import { createSignal } from "solid-js";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface TooltipPoint {
  x: number;
  y: number;
}

export interface TooltipPositionOptions {
  anchor: TooltipPoint;
  width: number;
  height: number;
  placement: TooltipPlacement;
  columns?: number;
  rows?: number;
  offset?: number;
}

export interface TooltipControllerOptions {
  delayMs?: number;
  hideDelayMs?: number;
  setTimeout?: (
    callback: () => void,
    delay: number
  ) => ReturnType<typeof setTimeout> | number;
  clearTimeout?: (handle: ReturnType<typeof setTimeout> | number) => void;
}

export interface TooltipController {
  visible(): boolean;
  anchor(): TooltipPoint | undefined;
  show(anchor?: TooltipPoint): void;
  hide(): void;
  hideNow(): void;
  dispose(): void;
}

export function tooltipPosition(options: TooltipPositionOptions): TooltipPoint {
  const offset = Math.max(0, Math.floor(options.offset ?? 1));
  let x = options.anchor.x;
  let y = options.anchor.y;
  switch (options.placement) {
    case "top":
      y -= options.height + offset;
      break;
    case "left":
      x -= options.width + offset;
      break;
    case "right":
      x += offset;
      break;
    case "bottom":
      y += offset;
      break;
  }
  const columns = options.columns ?? 0;
  const rows = options.rows ?? 0;
  if (columns > 0) x = Math.max(0, Math.min(Math.max(0, columns - options.width), x));
  if (rows > 0) y = Math.max(0, Math.min(Math.max(0, rows - options.height), y));
  return { x, y };
}

export function createTooltipController(
  options: TooltipControllerOptions = {}
): TooltipController {
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 400));
  const hideDelayMs = Math.max(0, Math.floor(options.hideDelayMs ?? 80));
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const [visible, setVisible] = createSignal(false);
  const [anchor, setAnchor] = createSignal<TooltipPoint>();
  let showTimer: ReturnType<typeof setTimeout> | number | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | number | undefined;
  let disposed = false;

  const clearShow = (): void => {
    if (showTimer !== undefined) clearTimer(showTimer);
    showTimer = undefined;
  };
  const clearHide = (): void => {
    if (hideTimer !== undefined) clearTimer(hideTimer);
    hideTimer = undefined;
  };

  const show = (next?: TooltipPoint): void => {
    if (disposed) return;
    clearHide();
    if (next) setAnchor(next);
    if (visible()) return;
    clearShow();
    if (delayMs === 0) {
      setVisible(true);
      return;
    }
    showTimer = setTimer(() => {
      showTimer = undefined;
      setVisible(true);
    }, delayMs);
  };

  const hideNow = (): void => {
    clearShow();
    clearHide();
    setVisible(false);
  };

  const hide = (): void => {
    if (disposed) return;
    clearShow();
    clearHide();
    if (!visible()) return;
    if (hideDelayMs === 0) {
      setVisible(false);
      return;
    }
    hideTimer = setTimer(() => {
      hideTimer = undefined;
      setVisible(false);
    }, hideDelayMs);
  };

  return {
    visible,
    anchor,
    show,
    hide,
    hideNow,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearShow();
      clearHide();
      setVisible(false);
    },
  };
}
