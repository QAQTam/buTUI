import { describe, expect, test } from "bun:test";
import {
  type MouseEvent,
  type Node,
  createModifiers,
  eventTarget,
} from "@butui/core";
import { createTuiApp } from "@butui/runtime";
import { useMouseCapture } from "@butui/solid";
import { createSignal } from "solid-js";
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

describe("mouse interaction", () => {
  test("clickCount 合成双击，右键走 onContextMenu", () => {
    const terminal = new FakeTerminal();
    const calls: string[] = [];
    let clock = 1000;
    const app = createTuiApp({
      terminal,
      size: { columns: 20, rows: 2 },
      selection: false,
      mouse: { now: () => clock, doubleClickMs: 400 },
      onQuit: () => {},
      view: () => (
        <box
          width={10}
          height={1}
          onClick={event => calls.push(`click:${event.clickCount ?? 1}`)}
          onDoubleClick={event => calls.push(`double:${event.clickCount}`)}
          onContextMenu={() => calls.push("context")}
        />
      ),
    });

    app.send(mouse("press", 0, 0));
    clock += 100;
    app.send(mouse("press", 0, 0));
    clock += 100;
    app.send(mouse("press", 0, 0));
    app.send(mouse("press", 0, 0, "right"));

    expect(calls).toEqual(["click:1", "double:2", "click:1", "context"]);
    app.dispose();
  });

  test("hover 只在目标变化时派发 enter / leave，且不冒泡", () => {
    const terminal = new FakeTerminal();
    const calls: string[] = [];
    const app = createTuiApp({
      terminal,
      size: { columns: 12, rows: 1 },
      selection: false,
      onQuit: () => {},
      view: () => (
        <row>
          <box
            width={5}
            height={1}
            onMouseEnter={() => calls.push("enter:a")}
            onMouseLeave={() => calls.push("leave:a")}
          />
          <box
            width={5}
            height={1}
            onMouseEnter={() => calls.push("enter:b")}
            onMouseLeave={() => calls.push("leave:b")}
          />
        </row>
      ),
    });

    app.send(mouse("move", 0, 0));
    app.send(mouse("move", 0, 0));
    app.send(mouse("move", 5, 0));
    app.send(mouse("move", 11, 0));

    expect(calls).toEqual([
      "enter:a",
      "leave:a",
      "enter:b",
      "leave:b",
    ]);
    app.dispose();
  });

  test("captureMouse 让拖拽在目标外继续收到 move，release 自动解除", () => {
    const terminal = new FakeTerminal();
    const calls: string[] = [];
    const app = createTuiApp({
      terminal,
      size: { columns: 20, rows: 3 },
      selection: false,
      onQuit: () => {},
      view: () => <Draggable onEvent={event => calls.push(event)} />,
    });

    app.send(mouse("press", 1, 0));
    expect(app.capturedMouse()).toBeDefined();

    app.send(mouse("move", 18, 2));
    app.send(mouse("release", 18, 2));

    expect(calls).toEqual(["down", "move", "up"]);
    expect(app.capturedMouse()).toBeUndefined();
    app.dispose();
  });
});

function Draggable(props: { onEvent: (event: string) => void }) {
  const [node, setNode] = createSignal<Node>();
  const capture = useMouseCapture();

  return (
    <box
      ref={setNode}
      width={5}
      height={1}
      selectable={false}
      onMouseDown={() => {
        props.onEvent("down");
        const current = node();
        if (current) capture?.capture(current);
      }}
      onMouseMove={() => props.onEvent("move")}
      onMouseUp={() => {
        props.onEvent("up");
        capture?.release();
      }}
    />
  );
}
