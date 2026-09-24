/**
 * 并行时间轴。
 *
 * 每个 step 可以显式 `start`；`sequenceSteps()` / `staggerSteps()` 负责常见的
 * 串行和错峰布局。step 只暴露归一化 progress，不绑定具体属性，因此既能驱动
 * cell、颜色，也能驱动 ScrollView / 面板状态。
 */
import { createSignal } from "solid-js";
import {
  AnimationScheduler,
  animationScheduler,
  prefersReducedMotion,
} from "./animation.ts";

export interface TimelineStep {
  /** 相对时间轴开始的毫秒偏移，默认 0 */
  start?: number;
  /** 持续毫秒；0 表示第一帧立即完成 */
  duration: number;
  onStart?: () => void;
  onUpdate: (progress: number) => void;
  onComplete?: () => void;
}

export interface TimelineOptions {
  steps: readonly TimelineStep[];
  autoplay?: boolean;
  scheduler?: AnimationScheduler;
  /** 测试 / 嵌入方覆盖 reduced-motion 检测 */
  reducedMotion?: boolean;
  onUpdate?: (progress: number) => void;
  onComplete?: () => void;
}

export interface Timeline {
  progress(): number;
  active(): boolean;
  start(): void;
  cancel(): void;
}

export function createTimeline(options: TimelineOptions): Timeline {
  const [progress, setProgress] = createSignal(0);
  const [activeRev, bumpActive] = createSignal(0);
  let activeValue = false;
  const active = (): boolean => (activeRev(), activeValue);
  const setActive = (next: boolean): void => {
    activeValue = next;
    bumpActive(value => value + 1);
  };
  const scheduler = options.scheduler ?? animationScheduler;
  const steps = options.steps;
  const total = Math.max(
    0,
    ...steps.map(step => Math.max(0, step.start ?? 0) + Math.max(0, step.duration))
  );
  let startedAt: number | undefined;
  let unsubscribe = () => {};
  let completed = false;
  let startedSteps = new Set<number>();
  let completedSteps = new Set<number>();

  const runInstant = (): void => {
    steps.forEach((step, index) => {
      step.onStart?.();
      step.onUpdate(1);
      step.onComplete?.();
      startedSteps.add(index);
      completedSteps.add(index);
    });
  };

  const finish = (): void => {
    if (!active()) return;
    setProgress(1);
    setActive(false);
    unsubscribe();
    if (!completed) {
      completed = true;
      options.onComplete?.();
    }
  };

  const tick = (time: number): void => {
    if (!active()) return;
    if (startedAt === undefined) {
      startedAt = time;
      return;
    }
    const elapsed = time - startedAt;
    const overall = total === 0 ? 1 : Math.max(0, Math.min(1, elapsed / total));
    setProgress(overall);
    options.onUpdate?.(overall);

    steps.forEach((step, index) => {
      const start = Math.max(0, step.start ?? 0);
      const duration = Math.max(0, step.duration);
      if (elapsed < start) return;
      if (!startedSteps.has(index)) {
        startedSteps.add(index);
        step.onStart?.();
      }
      const stepProgress = duration === 0 ? 1 : Math.max(0, Math.min(1, (elapsed - start) / duration));
      step.onUpdate(stepProgress);
      if (stepProgress >= 1 && !completedSteps.has(index)) {
        completedSteps.add(index);
        step.onComplete?.();
      }
    });

    if (elapsed >= total) finish();
  };

  const start = (): void => {
    unsubscribe();
    startedAt = undefined;
    completed = false;
    startedSteps = new Set();
    completedSteps = new Set();
    setProgress(0);
    setActive(true);
    if (
      options.reducedMotion === true ||
      (options.reducedMotion === undefined && prefersReducedMotion())
    ) {
      runInstant();
      finish();
      return;
    }
    if (steps.length === 0 || total === 0) {
      runInstant();
      finish();
      return;
    }
    unsubscribe = scheduler.subscribe(tick);
  };

  const timeline: Timeline = {
    progress,
    active,
    start,
    cancel() {
      if (!active()) return;
      setActive(false);
      unsubscribe();
    },
  };

  if (options.autoplay ?? true) start();
  return timeline;
}

/** 把多个 step 串起来；每个 step 的 `start` 作为相对间隔。 */
export function sequenceSteps(
  steps: readonly TimelineStep[],
  gap = 0
): TimelineStep[] {
  let cursor = 0;
  const spacing = Math.max(0, gap);
  return steps.map(step => {
    const start = cursor + Math.max(0, step.start ?? 0);
    cursor = start + Math.max(0, step.duration) + spacing;
    return { ...step, start };
  });
}

export interface StaggerStepOptions {
  /** 每个 step 之间的错峰毫秒数 */
  interval: number;
  duration: number;
  onUpdate: (index: number, progress: number) => void;
  onStart?: (index: number) => void;
  onComplete?: (index: number) => void;
}

/** 生成等间隔启动的 timeline steps。 */
export function staggerSteps(
  count: number,
  options: StaggerStepOptions
): TimelineStep[] {
  const size = Math.max(0, Math.floor(count));
  const interval = Math.max(0, options.interval);
  const duration = Math.max(0, options.duration);
  return Array.from({ length: size }, (_, index) => ({
    start: index * interval,
    duration,
    onStart: () => options.onStart?.(index),
    onUpdate: progress => options.onUpdate(index, progress),
    onComplete: () => options.onComplete?.(index),
  }));
}
