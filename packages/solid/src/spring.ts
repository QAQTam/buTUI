/**
 * 阻尼弹簧。
 *
 * 适合面板展开、滚动回弹、指针反馈等需要轻微 overshoot 的交互。积分使用
 * 固定小步长，避免 30fps 下刚度较高时数值发散。
 */
import { createSignal } from "solid-js";
import {
  AnimationScheduler,
  animationScheduler,
  prefersReducedMotion,
} from "./animation.ts";

export interface SpringOptions {
  from: number;
  to: number;
  /** 初始速度，单位 / 秒 */
  velocity?: number;
  /** 默认 170 */
  stiffness?: number;
  /** 默认 26 */
  damping?: number;
  /** 默认 1 */
  mass?: number;
  /** 离目标多近算静止，默认 0.01 */
  restDelta?: number;
  /** 速度多低算静止，默认 0.01 */
  restSpeed?: number;
  autoplay?: boolean;
  scheduler?: AnimationScheduler;
  /** 测试 / 嵌入方覆盖 reduced-motion 检测 */
  reducedMotion?: boolean;
  onUpdate?: (value: number, velocity: number) => void;
  onComplete?: (value: number) => void;
}

export interface Spring {
  value(): number;
  velocity(): number;
  progress(): number;
  active(): boolean;
  start(): void;
  cancel(): void;
  set(value: number, velocity?: number): void;
}

export function createSpring(options: SpringOptions): Spring {
  const [value, setValue] = createSignal(options.from);
  const [velocity, setVelocity] = createSignal(options.velocity ?? 0);
  const [progress, setProgress] = createSignal(0);
  const [activeRev, bumpActive] = createSignal(0);
  let activeValue = false;
  const active = (): boolean => (activeRev(), activeValue);
  const setActive = (next: boolean): void => {
    activeValue = next;
    bumpActive(value => value + 1);
  };
  const scheduler = options.scheduler ?? animationScheduler;
  const stiffness = Math.max(0, options.stiffness ?? 170);
  const damping = Math.max(0, options.damping ?? 26);
  const mass = Math.max(0.0001, options.mass ?? 1);
  const restDelta = Math.max(0, options.restDelta ?? 0.01);
  const restSpeed = Math.max(0, options.restSpeed ?? 0.01);
  let current = options.from;
  let speed = options.velocity ?? 0;
  let previousAt: number | undefined;
  let unsubscribe = () => {};
  let completed = false;

  const sync = (): void => {
    setValue(() => current);
    setVelocity(() => speed);
    const span = options.to - options.from;
    setProgress(span === 0 ? 1 : Math.max(0, Math.min(1, (current - options.from) / span)));
  };

  const finish = (): void => {
    if (!active()) return;
    current = options.to;
    speed = 0;
    sync();
    setActive(false);
    unsubscribe();
    if (!completed) {
      completed = true;
      options.onComplete?.(current);
    }
  };

  const tick = (time: number): void => {
    if (!active()) return;
    if (previousAt === undefined) {
      previousAt = time;
      return;
    }
    let remaining = Math.min(0.064, Math.max(0, (time - previousAt) / 1000));
    previousAt = time;
    while (remaining > 0) {
      const dt = Math.min(1 / 120, remaining);
      const acceleration =
        (-stiffness * (current - options.to) - damping * speed) / mass;
      speed += acceleration * dt;
      current += speed * dt;
      remaining -= dt;
    }
    sync();
    options.onUpdate?.(current, speed);
    if (Math.abs(current - options.to) <= restDelta && Math.abs(speed) <= restSpeed) {
      finish();
    }
  };

  const start = (): void => {
    unsubscribe();
    current = options.from;
    speed = options.velocity ?? 0;
    previousAt = undefined;
    completed = false;
    sync();
    setActive(true);
    if (
      options.reducedMotion === true ||
      (options.reducedMotion === undefined && prefersReducedMotion())
    ) {
      finish();
      return;
    }
    unsubscribe = scheduler.subscribe(tick);
  };

  const spring: Spring = {
    value,
    velocity,
    progress,
    active,
    start,
    cancel() {
      if (!active()) return;
      setActive(false);
      unsubscribe();
    },
    set(next, nextVelocity = 0) {
      current = next;
      speed = nextVelocity;
      sync();
    },
  };

  if (options.autoplay ?? true) start();
  return spring;
}
