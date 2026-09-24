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
import { Slider, createSlider, sliderValueAt } from "@butui/components";
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

describe("sliderValueAt", () => {
  test("端点、比例和 step 都精确", () => {
    expect(sliderValueAt(0, 10, 0, 100, 1)).toBe(0);
    expect(sliderValueAt(9, 10, 0, 100, 1)).toBe(100);
    expect(sliderValueAt(4, 10, 0, 100, 10)).toBe(40);
    expect(sliderValueAt(999, 10, 0, 100, 1)).toBe(100);
  });
});

describe("createSlider", () => {
  test("begin/drag/end 与键盘步进", () => {
    let value = 0;
    const model = createSlider({
      value: () => value,
      min: 0,
      max: 100,
      step: 10,
      onChange: next => {
        value = next;
      },
    });

    expect(model.position(11)).toBe(0);
    expect(model.beginDrag(10, 11)).toBe(true);
    expect(value).toBe(100);
    expect(model.dragging()).toBe(true);

    expect(model.drag(5, 11)).toBe(true);
    expect(value).toBe(50);
    model.endDrag();
    expect(model.dragging()).toBe(false);

    expect(model.handleKey(key("left"))).toBe(true);
    expect(value).toBe(40);
    expect(model.handleKey(key("home"))).toBe(true);
    expect(value).toBe(0);
    expect(model.handleKey(key("end"))).toBe(true);
    expect(value).toBe(100);
  });
});

describe("<Slider>", () => {
  test("渲染轨道、thumb 和值", () => {
    const [value, setValue] = createSignal(50);
    const model = createSlider({
      value,
      min: 0,
      max: 100,
      step: 10,
      onChange: setValue,
    });
    const app = mount(
      () => <Slider model={model} width={10} showValue />,
      { width: 20, height: 1 }
    );

    expect(app.text()).toContain("─────●──── 50");
    app.unmount();
  });

  test("鼠标按下、跨区域拖动和 release 都走模型", () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 20, rows: 1 };
    const [value, setValue] = createSignal(0);
    const model = createSlider({
      value,
      min: 0,
      max: 100,
      step: 10,
      onChange: setValue,
    });
    const app = createTuiApp({
      terminal,
      size: { columns: 20, rows: 1 },
      selection: false,
      onQuit: () => {},
      view: () => <Slider model={model} width={10} />,
    });

    app.send(mouse("press", 9, 0));
    expect(value()).toBe(100);
    expect(app.capturedMouse()).toBeDefined();

    app.send(mouse("move", 4, 0));
    expect(value()).toBe(40);

    app.send(mouse("release", 4, 0));
    expect(model.dragging()).toBe(false);
    expect(app.capturedMouse()).toBeUndefined();
    app.dispose();
  });

  test("键盘方向键 / Home / End 可操作", () => {
    const [value, setValue] = createSignal(50);
    const model = createSlider({
      value,
      min: 0,
      max: 100,
      step: 10,
      onChange: setValue,
    });
    const app = mount(
      () => <Slider model={model} width={10} />,
      { width: 20, height: 1 }
    );
    const node = [...walk(app.root)].find(
      item => isElement(item) && item.props.focusable === true
    )!;
    focusNode(app.root, node);

    app.key("right");
    app.flush();
    expect(value()).toBe(60);
    app.key("end");
    app.flush();
    expect(value()).toBe(100);
    app.key("left");
    app.flush();
    expect(value()).toBe(90);
    app.unmount();
  });
});
