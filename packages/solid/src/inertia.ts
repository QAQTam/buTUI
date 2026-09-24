/**
 * 拖动释放后的惯性衰减。
 *
 * runtime 只负责在 `dragend` 上报速度（cell/ms）；这个模型把速度积分成整数
 * cell 位移，并通过共享 AnimationScheduler 驱动。控件只需在 `onStep` 里把
 * 位移应用到自己的值域。
 */
import { AnimationScheduler, animationScheduler, prefersReducedMotion } from "./animation.ts";

export interface DragInertiaOptions {
  /** release 时的水平速度，cell/ms */
  velocityX?: number;
  /** release 时的垂直速度，cell/ms */
  velocityY?: number;
  /** 每帧收到整数 cell 位移；0 的轴不会调用 */
  onStep: (deltaX: number, deltaY: number) => void;
  /** 自然停止或 cancel 时调用一次 */
  onEnd?: () => void;
  /** false 或 reduced-motion 环境直接不启动 */
  enabled?: boolean;
  /** 测试 / 嵌入方覆盖环境检测；不传时读取 reduced-motion 环境 */
  reducedMotion?: boolean;
  /** 速度衰减系数，单位 1/ms；默认 0.01 */
  decay?: number;
  /** 低于这个速度就停止，单位 cell/ms；默认 0.005 */
  minVelocity?: number;
  /** 最长运行时间，毫秒；默认 700 */
  maxDuration?: number;
  /** 测试 / 嵌入方可注入调度器 */
  scheduler?: AnimationScheduler;
}

export interface DragInertiaHandle {
  active(): boolean;
  cancel(): void;
}

const INACTIVE: DragInertiaHandle = {
  active: () => false,
  cancel: () => {},
};

export function startDragInertia(options: DragInertiaOptions): DragInertiaHandle {
  if (options.enabled === false || (options.reducedMotion ?? prefersReducedMotion())) {
    return INACTIVE;
  }

  const decay = Math.max(0.0001, options.decay ?? 0.01);
  const minVelocity = Math.max(0, options.minVelocity ?? 0.005);
  const maxDuration = Math.max(0, options.maxDuration ?? 700);
  let velocityX = Number.isFinite(options.velocityX) ? options.velocityX! : 0;
  let velocityY = Number.isFinite(options.velocityY) ? options.velocityY! : 0;
  if (Math.hypot(velocityX, velocityY) < minVelocity) return INACTIVE;

  let active = true;
  let startedAt: number | undefined;
  let previousAt: number | undefined;
  let accumulatorX = 0;
  let accumulatorY = 0;
  let unsubscribe = () => {};

  const finish = (): void => {
    if (!active) return;
    active = false;
    unsubscribe();
    options.onEnd?.();
  };

  const tick = (time: number): void => {
    if (!active) return;
    if (startedAt === undefined) {
      startedAt = time;
      previousAt = time;
      return;
    }

    const dt = Math.min(64, Math.max(0, time - (previousAt ?? time)));
    previousAt = time;
    if (dt > 0) {
      const factor = Math.exp(-decay * dt);
      const integral = (1 - factor) / decay;
      accumulatorX += velocityX * integral;
      accumulatorY += velocityY * integral;
      velocityX *= factor;
      velocityY *= factor;

      const deltaX = accumulatorX >= 0 ? Math.floor(accumulatorX) : Math.ceil(accumulatorX);
      const deltaY = accumulatorY >= 0 ? Math.floor(accumulatorY) : Math.ceil(accumulatorY);
      if (deltaX !== 0) accumulatorX -= deltaX;
      if (deltaY !== 0) accumulatorY -= deltaY;
      if (deltaX !== 0 || deltaY !== 0) options.onStep(deltaX, deltaY);
    }

    const elapsed = time - (startedAt ?? time);
    if (
      elapsed >= maxDuration ||
      Math.hypot(velocityX, velocityY) < minVelocity
    ) {
      finish();
    }
  };

  unsubscribe = (options.scheduler ?? animationScheduler).subscribe(tick);
  return {
    active: () => active,
    cancel: finish,
  };
}
