import { describe, expect, test } from "bun:test";
import { type MouseEvent, createModifiers } from "@butui/core";
import {
  ScrollBar,
  createScrollBar,
  createScrollBarFor,
  createScrollView,
  scrollBarGeometry,
  topAtTrack,
  topForThumb,
} from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { AnimationScheduler } from "@butui/solid";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";
import { FakeTerminal } from "./helpers/terminal.ts";

const mouse = (
  action: MouseEvent["action"],
  x: number,
  y: number
): MouseEvent =>
  ({
    type: "mouse",
    action,
    button: action === "move" ? "none" : "left",
    x,
    y,
    modifiers: createModifiers(),
  }) as MouseEvent;

describe("ScrollBar 几何模型", () => {
  test("大内容：thumb 至少 1 格，端点精确落在轨道两端", () => {
    const base = { total: 100, viewport: 10, track: 10 };
    const top = scrollBarGeometry({ ...base, top: 0 });
    const bottom = scrollBarGeometry({ ...base, top: 90 });

    expect(top.thumbSize).toBe(1);
    expect(top.thumbSizeExact).toBe(1);
    expect(top.thumbRange).toBe(9);
    expect(top.thumbStart).toBe(0);
    expect(top.thumbStartExact).toBe(0);
    expect(bottom.thumbStart).toBe(9);
    expect(bottom.maxTop).toBe(90);
  });

  test("小内容：没有溢出，thumb 覆盖整条轨道", () => {
    const geometry = scrollBarGeometry({ top: 0, total: 3, viewport: 10, track: 5 });
    expect(geometry.overflow).toBe(false);
    expect(geometry.maxTop).toBe(0);
    expect(geometry.thumbSize).toBe(5);
  });

  test("thumb → top 单调且端点精确", () => {
    const metrics = { top: 0, total: 100, viewport: 10, track: 10 };
    expect(topForThumb(metrics, -10)).toBe(0);
    expect(topForThumb(metrics, 9)).toBe(90);

    let previous = -1;
    for (let y = 0; y <= 9; y++) {
      const value = topForThumb(metrics, y);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  test("点击轨道：center / start 两种对齐", () => {
    const metrics = { top: 0, total: 100, viewport: 50, track: 10 };
    expect(topAtTrack(metrics, 5, "center")).toBe(30);
    expect(topAtTrack(metrics, 5, "start")).toBe(50);
    expect(topAtTrack(metrics, 999)).toBe(50);
  });

  test("拖动保留 grabOffset，拖到底就是 maxTop", () => {
    let top = 0;
    const model = createScrollBar({
      top: () => top,
      total: () => 100,
      viewport: () => 10,
      track: () => 10,
      onScroll: value => {
        top = value;
      },
    });

    expect(model.beginDrag(0)).toBe(true);
    expect(model.dragging()).toBe(true);
    expect(model.drag(9)).toBe(true);
    expect(top).toBe(90);

    model.endDrag();
    expect(model.dragging()).toBe(false);
    expect(model.beginDrag(-1)).toBe(false);
    expect(model.beginDrag(10)).toBe(false);
    expect(model.drag(0)).toBe(false);
  });

  test("createScrollBarFor 直接驱动 ScrollView", () => {
    const view = createScrollView();
    view.measure({ top: 0, total: 100, height: 10 });
    const model = createScrollBarFor(view);

    model.jump(9, "start");
    expect(view.top()).toBe(90);
    expect(model.geometry().thumbStart).toBe(9);
  });
});

describe("<ScrollBar>", () => {
  test("按精确轨道行绘制 thumb，位置变化只重画对应行", () => {
    const [top, setTop] = createSignal(0);
    const model = createScrollBar({
      top,
      total: () => 100,
      viewport: () => 10,
      track: () => 5,
      onScroll: setTop,
    });
    const app = mount(() => <ScrollBar model={model} />, { width: 1, height: 5 });

    expect(app.text().split("\n")).toEqual(["█", "│", "│", "│", "│"]);
    setTop(90);
    app.flush();
    expect(app.text().split("\n")).toEqual(["│", "│", "│", "│", "█"]);
    app.unmount();
  });

  test("点击轨道行直接按比例定位", () => {
    const [top, setTop] = createSignal(0);
    const model = createScrollBar({
      top,
      total: () => 100,
      viewport: () => 10,
      track: () => 5,
      onScroll: setTop,
    });
    const app = mount(() => <ScrollBar model={model} />, { width: 1, height: 5 });

    app.click(0, 3);
    app.flush();
    expect(top()).toBe(68);
    app.unmount();
  });

  test("释放 thumb 后按速度继续滚动", () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 1, rows: 10 };
    const scheduler = new AnimationScheduler({ now: () => 0 });
    scheduler.stop();
    let clock = 0;
    let top = 0;
    const model = createScrollBar({
      top: () => top,
      total: () => 100,
      viewport: () => 10,
      track: () => 10,
      onScroll: value => {
        top = value;
      },
    });
    const app = createTuiApp({
      terminal,
      size: { columns: 1, rows: 10 },
      selection: false,
      mouse: { now: () => clock, velocityWindowMs: 100 },
      onQuit: () => {},
      view: () => (
        <ScrollBar
          model={model}
          inertiaScheduler={scheduler}
          inertiaReducedMotion={false}
        />
      ),
    });

    app.send(mouse("press", 0, 0));
    clock = 100;
    app.send(mouse("move", 0, 3));
    app.send(mouse("release", 0, 3));
    expect(top).toBe(30);

    scheduler.tick(0);
    scheduler.tick(64);
    expect(top).toBeGreaterThan(30);
    app.dispose();
    expect(scheduler.size).toBe(0);
  });

  test("全局文本选择不会抢走 scrollbar 的拖拽", () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 1, rows: 5 };
    let top = 0;
    const model = createScrollBar({
      top: () => top,
      total: () => 100,
      viewport: () => 10,
      track: () => 5,
      onScroll: value => {
        top = value;
      },
    });
    const app = createTuiApp({
      terminal,
      size: { columns: 1, rows: 5 },
      view: () => <ScrollBar model={model} />,
      onQuit: () => {},
    });

    app.send(mouse("press", 0, 0));
    app.send(mouse("move", 0, 4));
    app.send(mouse("release", 0, 4));

    expect(top).toBe(90);
    expect(app.selection()).toBeNull();
    app.dispose();
  });
});
