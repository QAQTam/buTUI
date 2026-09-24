import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createElement } from "@butui/core";
import { createTuiApp } from "@butui/runtime";
import { TerminalSession } from "@butui/terminal";

function streams(writeResult: boolean) {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { setRawMode(): void }).setRawMode = () => {};
  (stdin as unknown as { resume(): void }).resume = () => {};

  const stdout = new EventEmitter() as NodeJS.WriteStream;
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.write = () => writeResult;
  return { stdin, stdout };
}

describe("TerminalSession backpressure", () => {
  test("start 获取 frame lease，stop 释放", () => {
    const { stdin, stdout } = streams(true);
    const session = new TerminalSession({
      stdin,
      stdout,
      altScreen: false,
      mouse: false,
      bracketedPaste: false,
      focusEvents: false,
    });

    session.start();
    expect(session.frameLease?.state).toBe("active");
    expect(session.outputArbiter.current()).toBe(session.frameLease);
    session.stop();
    expect(session.frameLease).toBeUndefined();
    expect(session.outputArbiter.current()).toBeUndefined();
  });

  test("suspend 让 raw lease 接管，resume 后要求 full damage", async () => {
    const { stdin, stdout } = streams(true);
    const session = new TerminalSession({
      stdin,
      stdout,
      altScreen: false,
      mouse: false,
      bracketedPaste: false,
      focusEvents: false,
    });
    session.start();
    const frame = session.frameLease!;

    await session.suspend("child");
    expect(frame.state).toBe("suspended");
    const raw = await session.outputArbiter.acquire({
      owner: "child",
      kind: "raw",
      reason: "pty",
      priority: 10,
    });
    expect(session.outputArbiter.current()).toBe(raw);

    await session.outputArbiter.release(raw);
    await session.resume();
    expect(frame.state).toBe("active");
    expect(session.requiresFullDamage()).toBe(true);
    session.stop();
  });

  test("runtime frame 输出携带 frameId", () => {
    const { stdin, stdout } = streams(true);
    const session = new TerminalSession({
      stdin,
      stdout,
      altScreen: false,
      mouse: false,
      bracketedPaste: false,
      focusEvents: false,
    });
    const frameIds: number[] = [];
    session.outputArbiter.onEvent(event => {
      if (
        event.type === "write" &&
        event.batch.kind === "frame" &&
        event.batch.frameId !== undefined
      ) {
        frameIds.push(event.batch.frameId);
      }
    });

    const app = createTuiApp({
      terminal: session,
      view: () => createElement("text"),
      onQuit: () => {},
    });
    expect(frameIds).toEqual([1]);
    app.dispose();
  });

  test("withRawLease 自动接管、写入并恢复 frame lease", async () => {
    const { stdin, stdout } = streams(true);
    const session = new TerminalSession({
      stdin,
      stdout,
      altScreen: false,
      mouse: false,
      bracketedPaste: false,
      focusEvents: false,
    });
    session.start();

    const result = await session.withRawLease(
      "child",
      "tool",
      async ({ lease, write }) => {
        expect(lease.kind).toBe("raw");
        expect(session.outputArbiter.current()).toBe(lease);
        expect(write("raw output")).toBe(true);
        expect(session.write("frame while raw")).toBe(false);
        return 42;
      }
    );

    expect(result).toBe(42);
    expect(session.frameLease?.state).toBe("active");
    expect(session.outputArbiter.current()).toBe(session.frameLease);
    expect(session.requiresFullDamage()).toBe(true);
    session.stop();
  });

  test("withRawLease callback 抛错也会恢复 frame lease", async () => {
    const { stdin, stdout } = streams(true);
    const session = new TerminalSession({
      stdin,
      stdout,
      altScreen: false,
      mouse: false,
      bracketedPaste: false,
      focusEvents: false,
    });
    session.start();

    await expect(
      session.withRawLease("child", "crash", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(session.frameLease?.state).toBe("active");
    expect(session.outputArbiter.current()).toBe(session.frameLease);
    expect(session.requiresFullDamage()).toBe(true);
    session.stop();
  });

  test("runtime withRawLease 自动恢复 frame 并请求 full damage", async () => {
    const { stdin, stdout } = streams(true);
    const session = new TerminalSession({
      stdin,
      stdout,
      altScreen: false,
      mouse: false,
      bracketedPaste: false,
      focusEvents: false,
    });
    const app = createTuiApp({
      terminal: session,
      view: () => createElement("text"),
      onQuit: () => {},
    });

    const result = await app.withRawLease(
      "child",
      "tool",
      async ({ lease, write }) => {
        expect(lease.kind).toBe("raw");
        expect(write("raw output")).toBe(true);
        return 7;
      }
    );

    expect(result).toBe(7);
    expect(session.frameLease?.state).toBe("active");
    expect(session.outputArbiter.current()).toBe(session.frameLease);
    app.dispose();
  });

  test("write 透传 false，drain 事件转发给订阅者", () => {
    const { stdin, stdout } = streams(false);
    const session = new TerminalSession({
      stdin,
      stdout,
      altScreen: false,
      mouse: false,
      bracketedPaste: false,
      focusEvents: false,
    });
    let drained = 0;
    const off = session.onDrain(() => drained++);

    session.start();
    expect(session.write("x")).toBe(false);
    stdout.emit("drain");
    expect(drained).toBe(1);

    off();
    stdout.emit("drain");
    expect(drained).toBe(1);
    session.stop();
  });
});
