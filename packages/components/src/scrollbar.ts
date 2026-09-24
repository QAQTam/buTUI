/**
 * ScrollBar 几何模型。
 *
 * 很多 TUI 的 scrollbar 不准，根因是把「内容比例」和「轨道像素」混在一起，
 * 再用浮点位置近似。这里先把测量归一成整数，再单独提供：
 *
 *   top / total / viewport  →  thumbStart / thumbSize / thumbRange
 *   thumbStart             →  top
 *
 * 每个轨道 cell 都是一个精确坐标；拖动时保留鼠标相对 thumb 的 grabOffset，
 * 点击轨道则把 thumb 居中到该 cell 后反算 top。
 */
import { createSignal } from "solid-js";
import type { ScrollView } from "./scroll.ts";

export interface ScrollBarMetrics {
  /** 当前顶部偏移（内容行号） */
  top: number;
  /** 内容总行数 */
  total: number;
  /** 视口高度（行） */
  viewport: number;
  /** scrollbar 轨道高度（cell 行） */
  track: number;
}

export interface ScrollBarGeometry {
  track: number;
  total: number;
  viewport: number;
  maxTop: number;
  overflow: boolean;
  /** thumb 占用几格，至少 1（有溢出时） */
  thumbSize: number;
  /** 未量化 thumb 尺寸；DOM / 像素级 renderer 可用 */
  thumbSizeExact: number;
  /** thumb 顶部的轨道坐标，0-based */
  thumbStart: number;
  /** 未量化 thumb 顶部；cell renderer 仍应使用 thumbStart */
  thumbStartExact: number;
  /** 可移动范围 = track - thumbSize */
  thumbRange: number;
}

function integer(value: number, min = 0): number {
  return Math.max(min, Math.floor(Number.isFinite(value) ? value : min));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function scrollBarGeometry(metrics: ScrollBarMetrics): ScrollBarGeometry {
  const track = integer(metrics.track);
  const total = integer(metrics.total);
  const viewport = integer(metrics.viewport);
  const maxTop = Math.max(0, total - viewport);
  const top = clamp(integer(metrics.top), 0, maxTop);

  if (track === 0 || maxTop === 0) {
    return {
      track,
      total,
      viewport,
      maxTop,
      overflow: false,
      thumbSize: track,
      thumbSizeExact: track,
      thumbStart: 0,
      thumbStartExact: 0,
      thumbRange: 0,
    };
  }

  // 用乘法再除，避免先算比例带来的浮点误差；向下取整后至少保留 1 格。
  const thumbSizeExact = (track * viewport) / total;
  const thumbSize = Math.max(1, Math.min(track, Math.floor(thumbSizeExact)));
  const thumbRange = Math.max(0, track - thumbSize);
  const thumbStartExact = thumbRange === 0 ? 0 : (thumbRange * top) / maxTop;
  const thumbStart = Math.round(thumbStartExact);

  return {
    track,
    total,
    viewport,
    maxTop,
    overflow: true,
    thumbSize,
    thumbSizeExact,
    thumbStart,
    thumbStartExact,
    thumbRange,
  };
}

/** thumb 顶部轨道坐标 → 内容 top（自动夹取） */
export function topForThumb(metrics: ScrollBarMetrics, thumbStart: number): number {
  const geometry = scrollBarGeometry(metrics);
  if (!geometry.overflow || geometry.thumbRange === 0) return 0;
  const start = clamp(integer(thumbStart), 0, geometry.thumbRange);
  return Math.round((geometry.maxTop * start) / geometry.thumbRange);
}

/**
 * 点击轨道 → top。
 *
 * `center` 把 thumb 中心放在点击行（桌面 scrollbar 的常见行为）；
 * `start` 则把点击行当 thumb 顶部，适合精确跳转。
 */
export function topAtTrack(
  metrics: ScrollBarMetrics,
  trackY: number,
  align: "center" | "start" = "center"
): number {
  const geometry = scrollBarGeometry(metrics);
  if (!geometry.overflow) return 0;
  const offset = align === "center" ? Math.floor(geometry.thumbSize / 2) : 0;
  return topForThumb(metrics, integer(trackY) - offset);
}

export interface ScrollBarOptions {
  top: () => number;
  total: () => number;
  viewport: () => number;
  track: () => number;
  onScroll: (top: number) => void;
}

export interface ScrollBarModel {
  geometry(): ScrollBarGeometry;
  dragging(): boolean;
  /** 在轨道局部坐标按下；轨道外返回 false */
  beginDrag(trackY: number): boolean;
  /** 拖动到轨道局部坐标；没有在拖动时返回 false */
  drag(trackY: number): boolean;
  /** 按轨道 cell 增量滚动；惯性动画用 */
  dragBy(delta: number): boolean;
  endDrag(): void;
  /** 点击轨道直接定位（不进入拖拽） */
  jump(trackY: number, align?: "center" | "start"): boolean;
}

export function createScrollBar(options: ScrollBarOptions): ScrollBarModel {
  let draggingValue = false;
  let grabOffset = 0;
  const [dragRev, bumpDrag] = createSignal(0);

  const metrics = (): ScrollBarMetrics => ({
    top: options.top(),
    total: options.total(),
    viewport: options.viewport(),
    track: options.track(),
  });

  const geometry = (): ScrollBarGeometry => scrollBarGeometry(metrics());

  const scrollToThumbStart = (thumbStart: number): void => {
    options.onScroll(topForThumb(metrics(), thumbStart));
  };

  const beginDrag = (trackY: number): boolean => {
    const current = geometry();
    if (!current.overflow || current.track === 0) return false;
    const raw = Number.isFinite(trackY) ? Math.floor(trackY) : Number.NaN;
    if (!Number.isFinite(raw) || raw < 0 || raw >= current.track) return false;
    const y = raw;
    if (y >= current.thumbStart && y < current.thumbStart + current.thumbSize) {
      grabOffset = y - current.thumbStart;
    } else {
      grabOffset = Math.floor(current.thumbSize / 2);
      scrollToThumbStart(y - grabOffset);
    }
    draggingValue = true;
    bumpDrag(value => value + 1);
    return true;
  };

  const drag = (trackY: number): boolean => {
    if (!draggingValue) return false;
    const current = geometry();
    const y = clamp(integer(trackY), 0, Math.max(0, current.track - 1));
    scrollToThumbStart(y - grabOffset);
    return true;
  };

  return {
    geometry,
    dragging: () => (dragRev(), draggingValue),
    beginDrag,
    drag,
    dragBy(delta) {
      const current = geometry();
      if (!current.overflow || current.thumbRange === 0 || delta === 0) return false;
      const next = metrics().top + delta * (current.maxTop / current.thumbRange);
      options.onScroll(Math.round(next));
      return true;
    },
    endDrag() {
      if (!draggingValue) return;
      draggingValue = false;
      bumpDrag(value => value + 1);
    },
    jump(trackY, align = "center") {
      const current = geometry();
      if (!current.overflow) return false;
      options.onScroll(topAtTrack(metrics(), trackY, align));
      return true;
    },
  };
}

export interface ScrollBarForOptions {
  /** 轨道高度；默认与 ScrollView 视口同高 */
  track?: () => number;
  /** 默认直接调用 `view.scrollTo(top)` */
  onScroll?: (top: number) => void;
}

/**
 * 把 `createScrollView()` 直接接成 scrollbar 模型。
 *
 * ```tsx
 * const view = createScrollView();
 * const bar = createScrollBarFor(view);
 * <row>
 *   <box flexGrow={1}>…</box>
 *   <ScrollBar model={bar} />
 * </row>
 * ```
 */
export function createScrollBarFor(
  view: ScrollView,
  options: ScrollBarForOptions = {}
): ScrollBarModel {
  return createScrollBar({
    top: view.top,
    total: view.total,
    viewport: view.height,
    track: options.track ?? view.height,
    onScroll: options.onScroll ?? view.scrollTo,
  });
}
