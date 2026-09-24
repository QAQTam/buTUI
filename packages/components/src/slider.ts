/**
 * Slider 纯模型。
 *
 * 组件只把「本地 x」交给模型；比例、步进、键盘行为都在这里，和终端尺寸 /
 * renderer 无关。
 */
import type { KeyEvent } from "@butui/core";
import { createSignal } from "solid-js";

export interface SliderOptions {
  value: () => number;
  min?: number;
  max?: number;
  /** 步进；0 表示连续值 */
  step?: number;
  onChange: (value: number) => void;
}

export interface SliderModel {
  min(): number;
  max(): number;
  value(): number;
  ratio(): number;
  /** 当前 thumb 在轨道上的 cell 位置（0 .. track-1） */
  position(track: number): number;
  dragging(): boolean;
  /** 从轨道本地 x 开始拖动；返回是否开始 */
  beginDrag(localX: number, track: number): boolean;
  /** 继续拖动；未在拖动状态返回 false */
  drag(localX: number, track: number): boolean;
  endDrag(): void;
  /** 直接按轨道本地 x 定位，不进入拖动 */
  setFromPosition(localX: number, track: number): boolean;
  stepBy(delta: number): boolean;
  handleKey(event: KeyEvent): boolean;
}

export function sliderValueAt(
  localX: number,
  track: number,
  min: number,
  max: number,
  step = 0
): number {
  const width = Math.max(0, Math.floor(track));
  if (width <= 1) return min;
  const x = Math.max(0, Math.min(width - 1, Math.floor(localX)));
  const ratio = x / (width - 1);
  const raw = min + ratio * (max - min);
  const stepped = step > 0 ? Math.round(raw / step) * step : raw;
  return clamp(stepped, Math.min(min, max), Math.max(min, max));
}

export function createSlider(options: SliderOptions): SliderModel {
  let draggingValue = false;
  const [dragRev, bumpDrag] = createSignal(0);
  const min = (): number => options.min ?? 0;
  const max = (): number => options.max ?? 100;
  const step = (): number => Math.max(0, options.step ?? 1);
  const value = (): number =>
    clamp(options.value(), Math.min(min(), max()), Math.max(min(), max()));
  const ratio = (): number => {
    const span = max() - min();
    return span === 0 ? 0 : clamp((value() - min()) / span, 0, 1);
  };
  const position = (track: number): number => {
    const width = Math.max(1, Math.floor(track));
    return Math.round(ratio() * (width - 1));
  };
  const commit = (next: number): boolean => {
    const span = Math.abs(max() - min());
    const stepSize = step();
    const stepped = stepSize > 0 ? Math.round(next / stepSize) * stepSize : next;
    const clamped = clamp(stepped, Math.min(min(), max()), Math.max(min(), max()));
    if (clamped === value()) return false;
    options.onChange(clamped);
    return true;
  };
  const setFromPosition = (localX: number, track: number): boolean =>
    commit(sliderValueAt(localX, track, min(), max(), step()));

  return {
    min,
    max,
    value,
    ratio,
    position,
    dragging: () => (dragRev(), draggingValue),
    beginDrag(localX, track) {
      if (Math.floor(track) <= 0) return false;
      draggingValue = true;
      bumpDrag(value => value + 1);
      setFromPosition(localX, track);
      return true;
    },
    drag(localX, track) {
      if (!draggingValue) return false;
      setFromPosition(localX, track);
      return true;
    },
    endDrag() {
      if (!draggingValue) return;
      draggingValue = false;
      bumpDrag(value => value + 1);
    },
    setFromPosition,
    stepBy(delta) {
      const size = step() || (max() - min()) / 100;
      return commit(value() + delta * size);
    },
    handleKey(event) {
      switch (event.name) {
        case "left":
        case "down":
          return this.stepBy(-1);
        case "right":
        case "up":
          return this.stepBy(1);
        case "pagedown":
          return this.stepBy(-5);
        case "pageup":
          return this.stepBy(5);
        case "home":
          return commit(min());
        case "end":
          return commit(max());
        default:
          return false;
      }
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
