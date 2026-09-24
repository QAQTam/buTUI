/**
 * SplitPane 纯模型。
 *
 * 模型只处理「比例 ↔ 主窗格 cell 数」和拖动状态，不依赖布局 / renderer。
 * 分隔条本身也占 cell，比例基准因此是 `size - separator`，这样拖动端点能精确
 * 得到最小尺寸或最大尺寸，不会因为少减 1 格而永远差一列。
 */
import type { KeyEvent } from "@butui/core";
import { createSignal } from "solid-js";

export type SplitPaneOrientation = "horizontal" | "vertical";

export interface SplitPaneGeometryOptions {
  /** 主窗格最小 cell 数，默认 1 */
  minFirst?: number;
  /** 次窗格最小 cell 数，默认 1 */
  minSecond?: number;
  /** 分隔条占用的 cell 数，默认 1 */
  separator?: number;
}

export interface SplitPaneGeometry {
  /** 总尺寸 */
  size: number;
  /** 分隔条尺寸 */
  separator: number;
  /** 两个窗格可分配的总尺寸 = size - separator */
  available: number;
  /** 主窗格尺寸 */
  first: number;
  /** 次窗格尺寸 */
  second: number;
  /** 生效后的主窗格最小值 */
  minFirst: number;
  /** 生效后的主窗格最大值 */
  maxFirst: number;
  /** 归一化比例 */
  ratio: number;
}

function integer(value: number, min = 0): number {
  return Math.max(min, Math.floor(Number.isFinite(value) ? value : min));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function normalizedRatio(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

/** 把总尺寸和比例归一成精确的整数窗格尺寸。 */
export function splitPaneGeometry(
  size: number,
  ratio: number,
  options: SplitPaneGeometryOptions = {}
): SplitPaneGeometry {
  const total = integer(size);
  const separator = integer(options.separator ?? 1, 1);
  const available = Math.max(0, total - separator);
  const requestedMinFirst = integer(options.minFirst ?? 1);
  const requestedMinSecond = integer(options.minSecond ?? 1);
  const minFirst = Math.min(requestedMinFirst, available);
  const minSecond = Math.min(requestedMinSecond, Math.max(0, available - minFirst));
  const maxFirst = Math.max(minFirst, available - minSecond);
  const normalized = normalizedRatio(ratio);
  const first = clamp(Math.round(available * normalized), minFirst, maxFirst);

  return {
    size: total,
    separator,
    available,
    first,
    second: available - first,
    minFirst,
    maxFirst,
    ratio: available === 0 ? 0 : first / available,
  };
}

export interface SplitPaneOptions extends SplitPaneGeometryOptions {
  orientation?: SplitPaneOrientation;
  /** 当前主窗格占比，0..1 */
  ratio: () => number;
  onChange: (ratio: number) => void;
  /** 键盘方向键移动几格，默认 1 */
  keyboardStep?: number;
}

export interface SplitPaneModel {
  orientation(): SplitPaneOrientation;
  minFirst(): number;
  minSecond(): number;
  separator(): number;
  keyboardStep(): number;
  ratio(): number;
  geometry(size: number): SplitPaneGeometry;
  /** 主窗格当前占用 cell 数 */
  position(size: number): number;
  dragging(): boolean;
  /** 从分隔条开始拖动；总尺寸过小导致无法分配时返回 false */
  beginDrag(size: number): boolean;
  /** 按根节点本地坐标继续拖动；未在拖动状态返回 false */
  drag(local: number, size: number): boolean;
  endDrag(): void;
  /** 按 cell 数微调；用于键盘与无障碍操作 */
  nudge(delta: number, size: number): boolean;
  handleKey(event: KeyEvent, size: number): boolean;
}

export function createSplitPane(options: SplitPaneOptions): SplitPaneModel {
  let draggingValue = false;
  const [dragRev, bumpDrag] = createSignal(0);
  const orientation = (): SplitPaneOrientation => options.orientation ?? "horizontal";
  const minFirst = (): number => options.minFirst ?? 1;
  const minSecond = (): number => options.minSecond ?? 1;
  const separator = (): number => Math.max(1, Math.floor(options.separator ?? 1));
  const keyboardStep = (): number => Math.max(1, Math.floor(options.keyboardStep ?? 1));
  const ratio = (): number => normalizedRatio(options.ratio());
  const geometry = (size: number): SplitPaneGeometry =>
    splitPaneGeometry(size, ratio(), {
      minFirst: minFirst(),
      minSecond: minSecond(),
      separator: separator(),
    });

  const commit = (next: number): boolean => {
    const normalized = normalizedRatio(next);
    if (normalized === ratio()) return false;
    options.onChange(normalized);
    return true;
  };

  const commitFirst = (first: number, size: number): boolean => {
    const current = geometry(size);
    if (current.available === 0) return false;
    const next = clamp(Math.round(first), current.minFirst, current.maxFirst);
    return commit(next / current.available);
  };

  return {
    orientation,
    minFirst,
    minSecond,
    separator,
    keyboardStep,
    ratio,
    geometry,
    position: size => geometry(size).first,
    dragging: () => (dragRev(), draggingValue),
    beginDrag(size) {
      if (geometry(size).available === 0) return false;
      draggingValue = true;
      bumpDrag(value => value + 1);
      return true;
    },
    drag(local, size) {
      if (!draggingValue) return false;
      const current = geometry(size);
      if (current.available === 0) return true;
      const offset = (current.separator - 1) / 2;
      commitFirst(local - offset, size);
      return true;
    },
    endDrag() {
      if (!draggingValue) return;
      draggingValue = false;
      bumpDrag(value => value + 1);
    },
    nudge(delta, size) {
      const current = geometry(size);
      return commitFirst(current.first + delta * keyboardStep(), size);
    },
    handleKey(event, size) {
      const axis = orientation();
      switch (event.name) {
        case "left":
          return axis === "horizontal" ? this.nudge(-1, size) : false;
        case "right":
          return axis === "horizontal" ? this.nudge(1, size) : false;
        case "up":
          return axis === "vertical" ? this.nudge(-1, size) : false;
        case "down":
          return axis === "vertical" ? this.nudge(1, size) : false;
        case "pagedown":
          return this.nudge(-5, size);
        case "pageup":
          return this.nudge(5, size);
        case "home": {
          const current = geometry(size);
          return current.available > 0 ? commitFirst(current.minFirst, size) : false;
        }
        case "end": {
          const current = geometry(size);
          return current.available > 0 ? commitFirst(current.maxFirst, size) : false;
        }
        default:
          return false;
      }
    },
  };
}
