import { describe, expect, test } from "bun:test";
import { createTuiApp } from "@butui/runtime";
import { createSignal } from "solid-js";
import { FakeTerminal } from "./helpers/terminal.ts";

describe("runtime frame flush barrier", () => {
  test("accepted 在 backpressure 下立即完成，drained 等待终端 drain", async () => {
    const terminal = new FakeTerminal();
    terminal.blockWrites = true;
    const app = createTuiApp({
      terminal,
      view: () => <text>blocked</text>,
      autoStart: false,
      onQuit: () => {},
    });

    const painted = app.paint();
    expect(painted.accepted).toBe(true);
    expect(painted.blocked).toBe(true);

    await app.waitUntilFrameFlushed(painted.frameId, "accepted");
    let drained = false;
    const waiting = app.waitUntilFrameFlushed(painted.frameId, "drained").then(() => {
      drained = true;
    });

    await Bun.sleep(0);
    expect(drained).toBe(false);

    terminal.drain();
    await waiting;
    expect(drained).toBe(true);
    app.dispose();
  });

  test("省略 frameId 时等待下一帧，并读取调用后的最新状态", async () => {
    const terminal = new FakeTerminal();
    const [value, setValue] = createSignal("before");
    const app = createTuiApp({
      terminal,
      view: () => <text>{value()}</text>,
      onQuit: () => {},
    });

    terminal.output = "";
    const waiting = app.waitUntilFrameFlushed();
    setValue("after");
    await waiting;

    expect(terminal.output).toContain("after");
    expect(terminal.output).not.toContain("before");
    app.dispose();
  });

  test("dispose 会终止未完成的 drained 等待", async () => {
    const terminal = new FakeTerminal();
    terminal.blockWrites = true;
    const app = createTuiApp({
      terminal,
      view: () => <text>blocked</text>,
      autoStart: false,
      onQuit: () => {},
    });
    const painted = app.paint();
    const waiting = app.waitUntilFrameFlushed(painted.frameId, "drained");

    app.dispose();
    await expect(waiting).rejects.toThrow("frame flush");
  });
});
