import { describe, expect, test } from "bun:test";
import {
  type KeyEvent,
  type MouseEvent,
  createModifiers,
  eventTarget,
  focusNode,
  isElement,
  walk,
} from "@butui/core";
import {
  SplitPane,
  createSplitPane,
  splitPaneGeometry,
} from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";
import { FakeTerminal } from "./helpers/terminal.ts";

const mouse = (
  action: MouseEvent["action"],
  x: number,
  y: number
): MouseEvent =>
  eventTarget({
    type: "mouse" as const,
    action,
    button: action === "move" ? "none" : "left",
    x,
    y,
    modifiers: createModifiers(),
  }) as MouseEvent;

const key = (name: string): KeyEvent =>
  eventTarget({
    type: "key" as const,
    name,
    modifiers: createModifiers(),
  }) as KeyEvent;

describe("splitPaneGeometry", () => {
  test("分隔条占位、比例和端点都精确", () => {
    expect(splitPaneGeometry(10, 0.5)).toMatchObject({
      size: 10,
      separator: 1,
      available: 9,
      first: 5,
      second: 4,
      minFirst: 1,
      maxFirst: 8,
    });
    expect(splitPaneGeometry(10, 0)).toMatchObject({ first: 1, second: 8 });
    expect(splitPaneGeometry(10, 1)).toMatchObject({ first: 8, second: 1 });
  });

  test("空间不足时不产生负尺寸", () => {
    expect(splitPaneGeometry(1, 0.5)).toMatchObject({
      available: 0,
      first: 0,
      second: 0,
    });
    expect(splitPaneGeometry(3, 0.5, { minFirst: 5, minSecond: 5 })).toMatchObject({
      available: 2,
      first: 2,
      second: 0,
    });
  });
});

describe("createSplitPane", () => {
  test("拖动、微调和键盘操作都走整数 cell 几何", () => {
    let ratio = 0.5;
    const model = createSplitPane({
      ratio: () => ratio,
      onChange: next => {
        ratio = next;
      },
      minFirst: 2,
      minSecond: 2,
      keyboardStep: 1,
    });

    expect(model.position(20)).toBe(10);
    expect(model.beginDrag(20)).toBe(true);
    expect(model.dragging()).toBe(true);
    expect(model.drag(19, 20)).toBe(true);
    expect(model.position(20)).toBe(17);
    expect(model.drag(0, 20)).toBe(true);
    expect(model.position(20)).toBe(2);
    model.endDrag();
    expect(model.dragging()).toBe(false);

    expect(model.nudge(1, 20)).toBe(true);
    expect(model.position(20)).toBe(3);
    expect(model.handleKey(key("home"), 20)).toBe(true);
    expect(model.position(20)).toBe(2);
    expect(model.handleKey(key("end"), 20)).toBe(true);
    expect(model.position(20)).toBe(17);
  });

  test("方向键只响应自身 orientation", () => {
    let ratio = 0.5;
    const vertical = createSplitPane({
      orientation: "vertical",
      ratio: () => ratio,
      onChange: next => {
        ratio = next;
      },
    });

    expect(vertical.handleKey(key("left"), 10)).toBe(false);
    expect(vertical.handleKey(key("down"), 10)).toBe(true);
    expect(vertical.position(10)).toBe(6);
  });
});

describe("<SplitPane>", () => {
  test("水平分栏渲染主窗格、分隔条和次窗格", () => {
    const [ratio, setRatio] = createSignal(0.5);
    const model = createSplitPane({
      ratio,
      onChange: setRatio,
      minFirst: 1,
      minSecond: 1,
    });
    const app = mount(
      () => (
        <SplitPane
          model={model}
          size={10}
          first={<text>left</text>}
          second={<text>R</text>}
        />
      ),
      { width: 10, height: 1 }
    );

    expect(app.text()).toBe("left │R");
    setRatio(1);
    app.flush();
    expect(app.text()).toBe("left    │R");
    app.unmount();
  });

  test("垂直分栏按高度分配", () => {
    const [ratio, setRatio] = createSignal(0.5);
    const model = createSplitPane({
      orientation: "vertical",
      ratio,
      onChange: setRatio,
    });
    const app = mount(
      () => (
        <SplitPane
          model={model}
          size={5}
          first={<text>A</text>}
          second={<text>B</text>}
        />
      ),
      { width: 6, height: 5 }
    );

    expect(app.text()).toBe("A\n\n──────\nB");
    app.unmount();
  });

  test("鼠标拖动捕获根节点，移出矩形后继续更新", () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 20, rows: 3 };
    const [ratio, setRatio] = createSignal(0.5);
    const model = createSplitPane({
      ratio,
      onChange: setRatio,
      minFirst: 2,
      minSecond: 2,
    });
    const app = createTuiApp({
      terminal,
      size: { columns: 20, rows: 3 },
      selection: false,
      onQuit: () => {},
      view: () => (
        <SplitPane
          model={model}
          size={20}
          first={<text>left</text>}
          second={<text>right</text>}
        />
      ),
    });

    app.send(mouse("press", 10, 1));
    expect(model.dragging()).toBe(true);
    expect(app.capturedMouse()).toBeDefined();

    app.send(mouse("move", 19, 1));
    expect(model.position(20)).toBe(17);

    app.send(mouse("move", -5, 1));
    expect(model.position(20)).toBe(2);

    app.send(mouse("release", -5, 1));
    expect(model.dragging()).toBe(false);
    expect(app.capturedMouse()).toBeUndefined();
    app.dispose();
  });

  test("焦点分隔条支持方向键 / Home / End", () => {
    const [ratio, setRatio] = createSignal(0.5);
    const model = createSplitPane({
      ratio,
      onChange: setRatio,
      minFirst: 1,
      minSecond: 1,
    });
    const app = mount(
      () => (
        <SplitPane
          model={model}
          size={10}
          first={<text>L</text>}
          second={<text>R</text>}
        />
      ),
      { width: 10, height: 1 }
    );
    const node = [...walk(app.root)].find(
      item =>
        isElement(item) &&
        item.props.focusable === true &&
        item.props.semantic === "split-pane:separator"
    )!;
    focusNode(app.root, node);

    app.key("right");
    app.flush();
    expect(model.position(10)).toBe(6);
    app.key("end");
    app.flush();
    expect(model.position(10)).toBe(8);
    app.key("left");
    app.flush();
    expect(model.position(10)).toBe(7);
    app.unmount();
  });
});
