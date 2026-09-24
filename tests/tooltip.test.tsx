import { describe, expect, test } from "bun:test";
import {
  Tooltip,
  createTooltipController,
  tooltipPosition,
} from "@butui/components";
import { type MouseEvent, createModifiers, eventTarget } from "@butui/core";
import { createTuiApp } from "@butui/runtime";
import { flush } from "solid-js";
import { FakeTerminal, tick } from "./helpers/terminal.ts";

function mouse(
  action: MouseEvent["action"],
  x: number,
  y: number
): MouseEvent {
  return eventTarget({
    type: "mouse" as const,
    action,
    button: action === "move" ? "none" : "left",
    x,
    y,
    modifiers: createModifiers(),
  }) as MouseEvent;
}

function frameText(app: ReturnType<typeof createTuiApp>): string {
  return app
    .frame()
    .lines.map(line => line.map(cell => cell.ch).join("").trimEnd())
    .join("\n");
}

function fakeTimers() {
  let next = 1;
  const callbacks = new Map<number, () => void>();
  return {
    setTimeout(callback: () => void) {
      const handle = next++;
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimeout(handle: number | ReturnType<typeof setTimeout>) {
      if (typeof handle === "number") callbacks.delete(handle);
    },
    run(handle: number) {
      callbacks.get(handle)?.();
      callbacks.delete(handle);
    },
    handles() {
      return [...callbacks.keys()];
    },
  };
}

describe("tooltipPosition", () => {
  test("四向定位并在视口内夹取", () => {
    const base = {
      anchor: { x: 10, y: 10 },
      width: 8,
      height: 3,
      columns: 40,
      rows: 20,
    };
    expect(tooltipPosition({ ...base, placement: "bottom" })).toEqual({
      x: 10,
      y: 11,
    });
    expect(tooltipPosition({ ...base, placement: "top" })).toEqual({
      x: 10,
      y: 6,
    });
    expect(tooltipPosition({ ...base, placement: "right" })).toEqual({
      x: 11,
      y: 10,
    });
    expect(tooltipPosition({ ...base, placement: "left" })).toEqual({
      x: 1,
      y: 10,
    });
    expect(
      tooltipPosition({
        ...base,
        anchor: { x: 39, y: 19 },
        placement: "bottom",
      })
    ).toEqual({ x: 32, y: 17 });
  });
});

describe("createTooltipController", () => {
  test("show / hide 使用独立延迟", () => {
    const timers = fakeTimers();
    const controller = createTooltipController({
      delayMs: 20,
      hideDelayMs: 5,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    controller.show({ x: 1, y: 2 });
    expect(controller.visible()).toBe(false);
    timers.run(timers.handles()[0]!);
    flush();
    expect(controller.visible()).toBe(true);
    expect(controller.anchor()).toEqual({ x: 1, y: 2 });

    controller.hide();
    expect(controller.visible()).toBe(true);
    timers.run(timers.handles()[0]!);
    flush();
    expect(controller.visible()).toBe(false);
    controller.dispose();
  });
});

describe("<Tooltip>", () => {
  test("mouse move 显示 tooltip，离开后隐藏", async () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 40, rows: 10 };
    const controller = createTooltipController({
      delayMs: 0,
      hideDelayMs: 0,
    });
    const app = createTuiApp({
      terminal,
      mouseMotion: "hover",
      view: () => (
        <>
          <box>
            <text>target</text>
          </box>
          <row height={1}>
            <box
              width={10}
              height={1}
              onMouseEnter={event =>
                controller.show({ x: event.x, y: event.y })
              }
              onMouseMove={event =>
                controller.show({ x: event.x, y: event.y })
              }
              onMouseLeave={() => controller.hide()}
            />
            <text>hover</text>
          </row>
          <Tooltip controller={controller} content="tip text" />
        </>
      ),
      onQuit: () => {},
    });
    app.start();
    try {
      app.send(mouse("move", 0, 1));
      await tick();
      flush();
      app.paint();
      expect(frameText(app)).toContain("tip text");

      app.send(mouse("move", 20, 9));
      await tick();
      flush();
      app.paint();
      expect(frameText(app)).not.toContain("tip text");
    } finally {
      controller.dispose();
      app.dispose();
    }
  });
});
