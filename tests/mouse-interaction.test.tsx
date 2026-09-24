import { describe, expect, test } from "bun:test";
import {
  type MouseEvent,
  type Node,
  createModifiers,
  eventTarget,
} from "@butui/core";
import { createTuiApp } from "@butui/runtime";
import { useMouseCapture } from "@butui/solid";
import { Show, createSignal } from "solid-js";
import { FakeTerminal, tick } from "./helpers/terminal.ts";

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

  test("localX / localY 相对目标节点，捕获后允许为负数", () => {
    const terminal = new FakeTerminal();
    const coords: string[] = [];
    const app = createTuiApp({
      terminal,
      size: { columns: 20, rows: 3 },
      selection: false,
      onQuit: () => {},
      view: () => <LocalTarget onCoords={value => coords.push(value)} />,
    });

    app.send(mouse("press", 3, 1));
    app.send(mouse("move", 10, 1));
    app.send(mouse("move", 0, 0));
    app.send(mouse("release", 0, 0));

    expect(coords).toEqual([
      "down:1,0",
      "move:8,0",
      "move:-2,-1",
      "up:-2,-1",
    ]);
    app.dispose();
  });

  test("dragend 上报最近窗口的释放速度（cell/ms）", () => {
    const terminal = new FakeTerminal();
    let clock = 0;
    const velocities: Array<[number | undefined, number | undefined]> = [];
    const app = createTuiApp({
      terminal,
      size: { columns: 20, rows: 2 },
      selection: false,
      mouse: { now: () => clock, velocityWindowMs: 100 },
      onQuit: () => {},
      view: () => (
        <box
          width={15}
          height={1}
          selectable={false}
          onDragEnd={event =>
            velocities.push([event.velocityX, event.velocityY])
          }
        />
      ),
    });

    app.send(mouse("press", 0, 0));
    clock = 100;
    app.send(mouse("move", 10, 0));
    app.send(mouse("release", 10, 0));

    expect(velocities).toEqual([[0.1, 0]]);
    app.dispose();
  });

  test("dragstart / drag / dragend 按阈值触发并携带本地坐标", () => {
    const terminal = new FakeTerminal();
    const calls: string[] = [];
    const app = createTuiApp({
      terminal,
      size: { columns: 20, rows: 2 },
      selection: false,
      mouse: { dragThreshold: 2 },
      onQuit: () => {},
      view: () => (
        <box
          width={10}
          height={1}
          selectable={false}
          onDragStart={event => calls.push(`start:${event.localX},${event.localY}`)}
          onDrag={event => calls.push(`drag:${event.localX},${event.localY}`)}
          onDragEnd={event => calls.push(`end:${event.localX},${event.localY}`)}
        />
      ),
    });

    app.send(mouse("press", 0, 0));
    app.send(mouse("move", 1, 0));
    app.send(mouse("move", 2, 0));
    app.send(mouse("move", 5, 0));
    app.send(mouse("release", 5, 0));

    expect(calls).toEqual([
      "start:2,0",
      "drag:2,0",
      "drag:5,0",
      "end:5,0",
    ]);
    app.dispose();
  });

  test("presented routing 在 backpressure 期间不命中未展示的新节点", async () => {
    const terminal = new FakeTerminal();
    const [showA, setShowA] = createSignal(true);
    let a = 0;
    let b = 0;
    const app = createTuiApp({
      terminal,
      size: { columns: 12, rows: 1 },
      inputRouting: "presented",
      selection: false,
      onQuit: () => {},
      view: () => (
        <Show
          when={showA()}
          fallback={
            <box width={5} height={1} onClick={() => b++}>
              <text>B</text>
            </box>
          }
        >
          <box width={5} height={1} onClick={() => a++}>
            <text>A</text>
          </box>
        </Show>
      ),
    });

    terminal.blockWrites = true;
    setShowA(false);
    await tick();

    app.send(mouse("press", 0, 0));
    expect(a).toBe(0);
    expect(b).toBe(0);

    terminal.drain();
    await tick();
    app.send(mouse("press", 0, 0));
    expect(b).toBe(1);
    app.dispose();
  });

  test("presented routing 的 local 坐标使用用户看到的 bounds", async () => {
    const terminal = new FakeTerminal();
    const [offset, setOffset] = createSignal(0);
    const coords: Array<number | undefined> = [];
    const app = createTuiApp({
      terminal,
      size: { columns: 20, rows: 1 },
      inputRouting: "presented",
      selection: false,
      onQuit: () => {},
      view: () => (
        <row>
          <box width={offset()} />
          <box
            width={5}
            height={1}
            selectable={false}
            onClick={event => coords.push(event.localX)}
          >
            <text>A</text>
          </box>
        </row>
      ),
    });

    terminal.blockWrites = true;
    setOffset(2);
    await tick();

    app.send(mouse("press", 1, 0));
    expect(coords).toEqual([1]);

    terminal.drain();
    await tick();
    app.send(mouse("press", 2, 0));
    expect(coords).toEqual([1, 0]);
    app.dispose();
  });

  test("presented routing 在 resize 后等待新 frame 再恢复命中", async () => {
    const terminal = new FakeTerminal();
    let clicks = 0;
    const app = createTuiApp({
      terminal,
      size: { columns: 12, rows: 1 },
      inputRouting: "presented",
      selection: false,
      onQuit: () => {},
      view: () => (
        <box width={5} height={1} onClick={() => clicks++}>
          <text>A</text>
        </box>
      ),
    });

    terminal.resize({ columns: 20, rows: 2 });
    app.send(mouse("press", 0, 0));
    expect(clicks).toBe(0);

    await tick();
    app.send(mouse("press", 0, 0));
    expect(clicks).toBe(1);
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

function LocalTarget(props: { onCoords: (value: string) => void }) {
  const [node, setNode] = createSignal<Node>();
  const capture = useMouseCapture();

  return (
    <box>
      <box height={1} />
      <row>
        <box width={2} height={1} />
        <box
          ref={setNode}
          width={5}
          height={1}
          selectable={false}
          onMouseDown={event => {
            props.onCoords(`down:${event.localX},${event.localY}`);
            const current = node();
            if (current) capture?.capture(current);
          }}
          onMouseMove={event =>
            props.onCoords(`move:${event.localX},${event.localY}`)
          }
          onMouseUp={event => {
            props.onCoords(`up:${event.localX},${event.localY}`);
            capture?.release();
          }}
        />
      </row>
    </box>
  );
}
