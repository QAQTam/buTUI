import { describe, expect, test } from "bun:test";
import { type MouseEvent, createModifiers } from "@butui/core";
import { createTuiApp } from "@butui/runtime";
import { osc52 } from "@butui/terminal";
import { FakeTerminal } from "./helpers/terminal.ts";

const mouse = (
  action: MouseEvent["action"],
  x: number,
  y: number,
  button: MouseEvent["button"] = action === "move" ? "none" : "left"
): MouseEvent =>
  ({
    type: "mouse",
    action,
    button,
    x,
    y,
    modifiers: createModifiers(),
  }) as MouseEvent;

describe("OSC 52 剪贴板", () => {
  test("UTF-8 → base64，默认写 clipboard 且用 BEL 结束", () => {
    expect(osc52("hi")).toBe("\x1b]52;c;aGk=\x07");
    expect(osc52("你好")).toBe("\x1b]52;c;5L2g5aW9\x07");
  });

  test("primary / ST / tmux passthrough", () => {
    expect(osc52("x", { target: "primary", terminator: "st" })).toBe(
      "\x1b]52;p;eA==\x1b\\"
    );
    expect(osc52("x", { multiplexer: "tmux" })).toBe(
      "\x1bPtmux;\x1b\x1b]52;c;eA==\x07\x1b\\"
    );
  });
});

describe("鼠标文本选择（SPEC §9.4）", () => {
  test("拖拽选择、反显、行尾补白裁剪与自动复制", () => {
    const terminal = new FakeTerminal();
    const snapshots: Array<string | null> = [];
    const app = createTuiApp({
      terminal,
      view: () => (
        <box>
          <text>hello world</text>
          <text>second line</text>
        </box>
      ),
      selection: {
        onSelection: selection => snapshots.push(selection?.text ?? null),
      },
      onQuit: () => {},
    });

    app.send(mouse("press", 1, 0));
    app.send(mouse("move", 4, 0));
    terminal.output = "";
    app.send(mouse("release", 4, 0));

    expect(app.selectedText()).toBe("ello");
    expect(snapshots).toEqual(["ello"]);
    expect(terminal.output).toContain(osc52("ello", { multiplexer: "auto" }));

    const line = app.frame().lines[0];
    expect(line.slice(1, 5).every(cell => cell.selected === true)).toBe(true);
    expect(line[0].selected).toBeUndefined();
    expect(line[5].selected).toBeUndefined();

    app.clearSelection();
    expect(app.selectedText()).toBe("");
    expect(snapshots).toEqual(["ello", null]);
    app.dispose();
  });

  test("跨行 + CJK：边界落在宽字符任一 cell 上都复制完整 grapheme", () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      view: () => (
        <box>
          <text>你好世界</text>
          <text>abc def</text>
        </box>
      ),
      onQuit: () => {},
    });

    app.send(mouse("press", 1, 0)); // 落在「你」的第二个 cell
    app.send(mouse("move", 1, 1)); // 末行到 b
    app.send(mouse("release", 1, 1));

    expect(app.selectedText()).toBe("你好世界\nab");
    app.dispose();
  });

  test("选择整行也不会复制 frame 的布局补白", () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      view: () => <text>hello</text>,
      onQuit: () => {},
    });

    app.send(mouse("press", 0, 0));
    app.send(mouse("move", 39, 0));
    app.send(mouse("release", 39, 0));

    expect(app.selectedText()).toBe("hello");
    app.dispose();
  });

  test("selection:false 完全不接管鼠标 / 不写剪贴板", () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      view: () => <text>hello</text>,
      selection: false,
      onQuit: () => {},
    });

    terminal.output = "";
    app.send(mouse("press", 0, 0));
    app.send(mouse("move", 3, 0));
    app.send(mouse("release", 3, 0));

    expect(app.selection()).toBeNull();
    expect(terminal.output).not.toContain("\x1b]52;");
    app.dispose();
  });

  test("copyOnSelect:false 保留选择，但只在显式 copySelection() 时写剪贴板", () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      view: () => <text>copy me</text>,
      selection: { copyOnSelect: false },
      onQuit: () => {},
    });

    app.send(mouse("press", 0, 0));
    app.send(mouse("move", 3, 0));
    terminal.output = "";
    app.send(mouse("release", 3, 0));

    expect(app.selectedText()).toBe("copy");
    expect(terminal.output).not.toContain("\x1b]52;");
    expect(app.copySelection()).toBe(true);
    expect(terminal.output).toContain(osc52("copy", { multiplexer: "auto" }));
    app.dispose();
  });
});
