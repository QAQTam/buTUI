import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
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
