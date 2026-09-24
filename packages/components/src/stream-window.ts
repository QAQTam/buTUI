/**
 * StreamWindowController 的键盘 / 鼠标 / scrollbar 适配。
 *
 * controller 负责异步 cold-read 与窗口状态；这里只把输入语义映射成
 * scrollTo / scrollBy / pageBy，不持有 transcript。
 */
import type { KeyEvent, MouseEvent } from "@butui/core";
import type { StreamWindowController } from "@butui/stream";
import { createScrollBar, type ScrollBarModel } from "./scrollbar.ts";

export interface StreamWindowInputOptions {
  /** 滚轮一次滚动几行，默认 1。 */
  wheelStep?: number;
  /** 翻页时保留的重叠行，默认 1。 */
  pageOverlap?: number;
}

export interface StreamWindowInput {
  handleKey(event: KeyEvent): boolean;
  handleWheel(event: MouseEvent): boolean;
  /** 等待当前已触发的滚动操作完成。 */
  flush(): Promise<void>;
}

export function createStreamWindowInput(
  controller: StreamWindowController,
  options: StreamWindowInputOptions = {}
): StreamWindowInput {
  const wheelStep = Math.max(1, Math.floor(options.wheelStep ?? 1));
  const pageOverlap = Math.max(0, Math.floor(options.pageOverlap ?? 1));
  const pageStep = (): number => Math.max(1, controller.height() - pageOverlap);
  let pending: Promise<void> = Promise.resolve();

  const run = (operation: Promise<unknown>): void => {
    pending = pending.then(() => operation).then(() => undefined);
  };

  return {
    handleKey(event) {
      const { name, modifiers } = event;
      if (modifiers.ctrl || modifiers.alt || modifiers.meta) return false;

      switch (name) {
        case "up":
          run(controller.scrollBy(-1));
          return true;
        case "down":
          run(controller.scrollBy(1));
          return true;
        case "pageup":
          run(controller.scrollBy(-pageStep()));
          return true;
        case "pagedown":
          run(controller.scrollBy(pageStep()));
          return true;
        case "home":
          run(controller.scrollTo(0));
          return true;
        case "end":
          run(controller.scrollTo(Number.MAX_SAFE_INTEGER));
          return true;
        default:
          return false;
      }
    },

    handleWheel(event) {
      if (event.action !== "wheel") return false;
      if (event.wheel !== "up" && event.wheel !== "down") return false;
      run(controller.scrollBy(event.wheel === "down" ? wheelStep : -wheelStep));
      return true;
    },

    async flush() {
      await pending;
    },
  };
}

export interface StreamWindowScrollBarOptions {
  /** 轨道高度；默认与 controller viewport 同高。 */
  track?: () => number;
  /** 覆盖默认的 controller.scrollTo。 */
  onScroll?: (top: number) => void;
}

export function createScrollBarForStreamWindow(
  controller: StreamWindowController,
  options: StreamWindowScrollBarOptions = {}
): ScrollBarModel {
  return createScrollBar({
    top: controller.offset,
    total: controller.totalLines,
    viewport: controller.height,
    track: options.track ?? controller.height,
    onScroll(top) {
      if (options.onScroll) options.onScroll(top);
      else void controller.scrollTo(top);
    },
  });
}
