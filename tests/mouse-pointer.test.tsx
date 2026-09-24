import { describe, expect, test } from "bun:test";
import { type MouseEvent, createModifiers, eventTarget } from "@butui/core";
import { SplitPane, createSplitPane } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { TerminalSession, osc22 } from "@butui/terminal";
import { FakeTerminal } from "./helpers/terminal.ts";

function mouse(
  action: MouseEvent["action"],
  x: number,
  y: number,
  button: MouseEvent["button"] = action === "move" ? "none" : "left"
): MouseEvent {
  return eventTarget({
    type: "mouse" as const,
    action,
    button,
    x,
    y,
    modifiers: createModifiers(),
  }) as MouseEvent;
}

const sequence = (style: Parameters<typeof osc22>[0]): string =>
  osc22(style, { multiplexer: "auto" });

describe("osc22", () => {
  test("生成指针形状，auto 映射到 default", () => {
    expect(osc22("pointer")).toBe("\x1b]22;pointer\x07");
    expect(osc22("auto")).toBe("\x1b]22;default\x07");
    expect(osc22("text", { terminator: "st" })).toBe("\x1b]22;text\x1b\\");
  });

  test("支持 tmux passthrough", () => {
    expect(osc22("grab", { multiplexer: "tmux" })).toBe(
      "\x1bPtmux;\x1b\x1b]22;grab\x07\x1b\\"
    );
  });

  test("TerminalSession 去重并在 stop 恢复 default", () => {
    const output: string[] = [];
    const stdin = {
      on() {},
      off() {},
      resume() {},
      setRawMode() {},
    } as unknown as NodeJS.ReadStream;
    const stdout = {
      columns: 80,
      rows: 24,
      write(chunk: string) {
        output.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const session = new TerminalSession({
      stdin,
      stdout,
      altScreen: false,
      mouse: false,
      bracketedPaste: false,
      focusEvents: false,
    });

    session.start();
    output.length = 0;
    session.setMousePointer("pointer");
    session.setMousePointer("pointer");
    session.setMousePointer("text");
    session.stop();

    expect(output.filter(chunk => chunk.startsWith("\x1b]22;"))).toEqual([
      sequence("pointer"),
      sequence("text"),
      sequence("default"),
    ]);
  });
});

describe("mouse pointer runtime", () => {
  test("按命中节点的 cursor 切换，相同形状不重复写", () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 12, rows: 1 };
    const app = createTuiApp({
      terminal,
      size: { columns: 12, rows: 1 },
      mouseMotion: "hover",
      selection: false,
      onQuit: () => {},
      view: () => (
        <row>
          <box width={4} height={1} cursor="pointer" />
          <box width={4} height={1} cursor="text" />
          <box width={4} height={1} />
        </row>
      ),
    });

    terminal.output = "";
    app.send(mouse("move", 0, 0));
    expect(terminal.output).toContain(sequence("pointer"));

    terminal.output = "";
    app.send(mouse("move", 1, 0));
    expect(terminal.output).toBe("");

    terminal.output = "";
    app.send(mouse("move", 4, 0));
    expect(terminal.output).toContain(sequence("text"));

    terminal.output = "";
    app.send(mouse("move", 8, 0));
    expect(terminal.output).toContain(sequence("default"));
    app.dispose();
  });

  test("SplitPane 分隔条使用 resize 指针", () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 10, rows: 1 };
    const split = createSplitPane({
      ratio: () => 0.5,
      onChange: () => {},
    });
    const app = createTuiApp({
      terminal,
      size: { columns: 10, rows: 1 },
      mouseMotion: "hover",
      selection: false,
      onQuit: () => {},
      view: () => (
        <SplitPane
          model={split}
          size={10}
          first={<text>L</text>}
          second={<text>R</text>}
        />
      ),
    });

    terminal.output = "";
    app.send(mouse("move", 5, 0));
    expect(terminal.output).toContain(sequence("col-resize"));

    terminal.output = "";
    app.send(mouse("move", 0, 0));
    expect(terminal.output).toContain(sequence("default"));
    app.dispose();
  });

  test("可点击祖先自动 pointer，显式 default 可覆盖", () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 10, rows: 1 };
    const app = createTuiApp({
      terminal,
      size: { columns: 10, rows: 1 },
      mouseMotion: "hover",
      selection: false,
      onQuit: () => {},
      view: () => (
        <row>
          <box width={5} height={1} onClick={() => {}}>
            <text>click</text>
          </box>
          <box width={5} height={1} cursor="default" onClick={() => {}}>
            <text>plain</text>
          </box>
        </row>
      ),
    });

    terminal.output = "";
    app.send(mouse("move", 1, 0));
    expect(terminal.output).toContain(sequence("pointer"));

    terminal.output = "";
    app.send(mouse("move", 6, 0));
    expect(terminal.output).toContain(sequence("default"));
    app.dispose();
  });

  test("capture 期间保持捕获节点的指针，release 后按新命中恢复", () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 10, rows: 1 };
    const app = createTuiApp({
      terminal,
      size: { columns: 10, rows: 1 },
      selection: false,
      onQuit: () => {},
      view: () => (
        <box
          width={5}
          height={1}
          cursor="grab"
          selectable={false}
          onMouseDown={event => {
            const target = event.target;
            if (target) app.captureMouse(target);
          }}
          onMouseUp={() => app.releaseMouse()}
        />
      ),
    });

    terminal.output = "";
    app.send(mouse("press", 1, 0));
    expect(terminal.output).toContain(sequence("grab"));

    terminal.output = "";
    app.send(mouse("move", 9, 0));
    expect(terminal.output).toBe("");

    app.send(mouse("release", 9, 0));
    expect(terminal.output).toContain(sequence("default"));
    app.dispose();
  });

  test("mousePointer=false 完全不写 OSC 22", () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      size: { columns: 5, rows: 1 },
      mousePointer: false,
      mouseMotion: "hover",
      selection: false,
      onQuit: () => {},
      view: () => <box width={5} height={1} cursor="pointer" />,
    });

    terminal.output = "";
    app.send(mouse("move", 1, 0));
    expect(terminal.output).not.toContain("\x1b]22;");
    app.dispose();
  });

  test("dispose 恢复 default", () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      size: { columns: 5, rows: 1 },
      mouseMotion: "hover",
      selection: false,
      onQuit: () => {},
      view: () => <box width={5} height={1} cursor="pointer" />,
    });

    app.send(mouse("move", 1, 0));
    terminal.output = "";
    app.dispose();
    expect(terminal.output).toContain(sequence("default"));
  });
});
