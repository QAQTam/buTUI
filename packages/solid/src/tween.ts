/**
 * 数值 / 颜色 tween。
 *
 * 输出是 Solid 访问器，但仍由调用方显式管理生命周期；组件里应在 onCleanup
 * 调用 `cancel()`。所有时间来自注入的 AnimationScheduler，便于测试。
 */
import { theme } from "@butui/core";
import { createSignal } from "solid-js";
import {
  AnimationScheduler,
  animationScheduler,
  prefersReducedMotion,
} from "./animation.ts";
import { easeOutCubic, type Easing } from "./easing.ts";

export type TweenValue = number | string;

export interface TweenOptions<T extends TweenValue = number> {
  from: T;
  to: T;
  /** 毫秒 */
  duration: number;
  /** 毫秒 */
  delay?: number;
  easing?: Easing;
  /** 创建后立即开始，默认 true */
  autoplay?: boolean;
  scheduler?: AnimationScheduler;
  /** 测试 / 嵌入方覆盖 reduced-motion 检测 */
  reducedMotion?: boolean;
  onUpdate?: (value: T, progress: number) => void;
  onComplete?: (value: T) => void;
}

export interface Tween<T extends TweenValue = number> {
  value(): T;
  progress(): number;
  active(): boolean;
  start(): void;
  /** 停在当前位置 */
  cancel(): void;
  /** 直接跳到某个值 */
  set(value: T): void;
}

function rgba(value: string): [number, number, number, number] | undefined {
  const named = (theme() as unknown as Record<string, string>)[value] ?? value;
  const parsed = Bun.color(named, "[rgba]");
  if (!parsed) return undefined;
  return [parsed[0], parsed[1], parsed[2], parsed[3] > 1 ? parsed[3] / 255 : parsed[3]];
}

/** 数值线性插值；颜色走 RGB 线性插值，其它字符串在终点离散切换。 */
export function interpolateTween(from: number, to: number, progress: number): number;
export function interpolateTween(from: string, to: string, progress: number): string;
export function interpolateTween<T extends TweenValue>(
  from: T,
  to: T,
  progress: number
): T {
  const t = Math.max(0, Math.min(1, progress));
  if (typeof from === "number" && typeof to === "number") {
    return (from + (to - from) * t) as T;
  }
  if (typeof from === "string" && typeof to === "string") {
    const a = rgba(from);
    const b = rgba(to);
    if (a && b) {
      const channel = (index: number): number =>
        Math.round(a[index]! + (b[index]! - a[index]!) * t);
      const alpha = Number((a[3] + (b[3] - a[3]) * t).toFixed(3));
      return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha})` as T;
    }
    return (t >= 1 ? to : from) as T;
  }
  return (t >= 1 ? to : from) as T;
}

export function createTween<T extends TweenValue = number>(
  options: TweenOptions<T>
): Tween<T> {
  const [valueRev, bumpValue] = createSignal(0);
  const [progressRev, bumpProgress] = createSignal(0);
  const [activeRev, bumpActive] = createSignal(0);
  let currentValue: TweenValue = options.from;
  let currentProgress = 0;
  let activeValue = false;
  const value = (): T => (valueRev(), currentValue) as T;
  const progress = (): number => (progressRev(), currentProgress);
  const active = (): boolean => (activeRev(), activeValue);
  const writeValue = (next: TweenValue): void => {
    currentValue = next;
    bumpValue(value => value + 1);
  };
  const writeProgress = (next: number): void => {
    currentProgress = next;
    bumpProgress(value => value + 1);
  };
  const setActive = (next: boolean): void => {
    activeValue = next;
    bumpActive(value => value + 1);
  };
  const scheduler = options.scheduler ?? animationScheduler;
  const duration = Math.max(0, options.duration);
  const delay = Math.max(0, options.delay ?? 0);
  const easing = options.easing ?? easeOutCubic;
  let startedAt: number | undefined;
  let unsubscribe = () => {};
  let completed = false;

  const finish = (): void => {
    if (!active()) return;
    writeValue(options.to);
    writeProgress(1);
    setActive(false);
    unsubscribe();
    if (!completed) {
      completed = true;
      options.onComplete?.(options.to);
    }
  };

  const tick = (time: number): void => {
    if (!active()) return;
    if (startedAt === undefined) {
      startedAt = time;
      options.onUpdate?.(options.from, 0);
      return;
    }
    const elapsed = time - startedAt - delay;
    if (elapsed < 0) return;
    if (duration === 0 || elapsed >= duration) {
      finish();
      return;
    }
    const linearProgress = elapsed / duration;
    const eased = easing(Math.max(0, Math.min(1, linearProgress)));
    const next =
      typeof options.from === "number" && typeof options.to === "number"
        ? interpolateTween(options.from, options.to, eased)
        : interpolateTween(options.from as string, options.to as string, eased);
    writeValue(next);
    writeProgress(linearProgress);
    options.onUpdate?.(next as T, linearProgress);
  };

  const cancel = (): void => {
    if (!active()) return;
    setActive(false);
    unsubscribe();
  };

  const start = (): void => {
    unsubscribe();
    startedAt = undefined;
    completed = false;
    writeValue(options.from);
    writeProgress(0);
    setActive(true);
    if (
      options.reducedMotion === true ||
      (options.reducedMotion === undefined && prefersReducedMotion()) ||
      duration === 0
    ) {
      finish();
      return;
    }
    unsubscribe = scheduler.subscribe(tick);
  };

  const tween: Tween<T> = {
    value,
    progress,
    active,
    start,
    cancel,
    set(next) {
      writeValue(next);
    },
  };

  if (options.autoplay ?? true) start();
  return tween;
}
