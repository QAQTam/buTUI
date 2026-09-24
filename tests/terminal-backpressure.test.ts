import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createElement } from "@butui/core";
import { createTuiApp } from "@butui/runtime";
import { TerminalSession, runPtyWithRawLease } from "@butui/terminal";

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

function capturingStreams() {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { setRawMode(): void }).setRawMode = () => {};
  (stdin as unknown as { resume(): void }).resume = () => {};

  let output = "";
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.write = chunk => {
    output += String(chunk);
    return true;
  };
  return { stdin, stdout, output: () => output };
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

  test("raw lease 原始输入绕过 UI InputDecoder", async () => {
    const { stdin, stdout } = streams(true);
    const session = new TerminalSession({
      stdin,
      stdout,
      altScreen: false,
      mouse: false,
      bracketedPaste: false,
      focusEvents: false,
    });
    const events: unknown[] = [];
    session.onEvent(event => events.push(event));
    session.start();

    let received = "";
    const result = await session.withRawLease("child", "pty", async context => {
      const off = context.onInput(chunk => {
        received += new TextDecoder().decode(chunk);
      });
      (stdin as unknown as EventEmitter).emit("data", Buffer.from("raw-input"));
      off();
      return 7;
    });

    expect(result).toBe(7);
    expect(received).toBe("raw-input");
    expect(events).toEqual([]);
    expect(session.frameLease?.state).toBe("active");
    session.stop();
  });

  test.skipIf(process.platform === "win32")(
    "runPtyWithRawLease 运行子进程并恢复 frame lease",
    async () => {
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

      const exitCode = await runPtyWithRawLease(session, "child", "tool", {
        cmd: [
          process.execPath,
          "-e",
          "process.stdout.write('PTY_OK'); process.exit(0)",
        ],
        cols: 80,
        rows: 24,
      });

      expect(exitCode).toBe(0);
      expect(session.frameLease?.state).toBe("active");
      expect(session.outputArbiter.current()).toBe(session.frameLease);
      expect(session.requiresFullDamage()).toBe(true);
      session.stop();
    }
  );

  test.skipIf(process.platform === "win32")(
    "runPtyWithRawLease 转发宿主 resize",
    async () => {
      const { stdin, stdout, output } = capturingStreams();
      const session = new TerminalSession({
        stdin,
        stdout,
        altScreen: false,
        mouse: false,
        bracketedPaste: false,
        focusEvents: false,
      });
      session.start();

      const exitCode = await runPtyWithRawLease(session, "child", "tool", {
        cmd: [
          process.execPath,
          "-e",
          `
            const started = Date.now();
            const timer = setInterval(() => {
              const columns = process.stdout.columns;
              const rows = process.stdout.rows;
              if (columns === 100 && rows === 30) {
                process.stdout.write("SIZE:" + columns + "x" + rows);
                process.exit(0);
              }
              if (Date.now() - started > 1000) process.exit(2);
            }, 10);
          `,
        ],
        cols: 80,
        rows: 24,
        onReady() {
          stdout.columns = 100;
          stdout.rows = 30;
          process.emit("SIGWINCH");
        },
      });

      expect(exitCode).toBe(0);
      const deadline = Date.now() + 500;
      while (!output().includes("SIZE:100x30") && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      expect(output()).toContain("SIZE:100x30");
      expect(session.frameLease?.state).toBe("active");
      session.stop();
    }
  );

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

  test.skipIf(process.platform === "win32")(
    "runtime runPty 运行子进程并恢复 frame",
    async () => {
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

      const exitCode = await app.runPty("child", "tool", {
        cmd: [process.execPath, "-e", "process.exit(0)"],
        cols: 80,
        rows: 24,
      });

      expect(exitCode).toBe(0);
      expect(session.frameLease?.state).toBe("active");
      expect(session.outputArbiter.current()).toBe(session.frameLease);
      app.dispose();
    }
  );

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
