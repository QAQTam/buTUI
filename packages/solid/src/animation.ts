/**
 * 共享动画帧调度。
 *
 * TUI 动画不应该让每个组件各起一个 `setInterval`：几十个 spinner / streaming
 * diff 会同时唤醒事件循环，还会把每帧重绘打散。这里用进程内单例调度器，
 * 只有存在订阅者时才启动定时器，全部卸载后自动停。
 *
 * 组件侧用 `useAnimationFrame()` 拿时间访问器即可；测试可以直接 `tick()`，
 * 不依赖墙钟。
 */
import { createEffect, createSignal, flush, type Accessor } from "solid-js";

export interface AnimationSchedulerOptions {
  /** 默认 30fps；终端不需要 60fps 的手机级动画 */
  fps?: number;
  now?: () => number;
}

export class AnimationScheduler {
  private readonly listeners = new Set<(time: number) => void>();
  private readonly interval: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AnimationSchedulerOptions = {}) {
    const fps = Math.max(1, Math.min(120, options.fps ?? 30));
    this.interval = Math.max(1, Math.round(1000 / fps));
    this.now = options.now ?? (() => performance.now());
  }

  get active(): boolean {
    return this.timer !== undefined;
  }

  get size(): number {
    return this.listeners.size;
  }

  subscribe(listener: (time: number) => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** 手动推进一帧；测试用，也方便以后接 runtime 的 render clock */
  tick(time = this.now()): void {
    for (const listener of [...this.listeners]) listener(time);
    // Solid 2 的写入延迟到 flush；动画帧必须自己提交，否则 terminal 不会看到
    // 节点变更，也就不会 requestPaint。
    flush();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.interval);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}

export const animationScheduler = new AnimationScheduler();

/** 无标准 TTY 信号，使用显式环境变量 / dumb terminal 作为降级依据 */
export function prefersReducedMotion(
  env: Record<string, string | undefined> = process.env
): boolean {
  const value = env.BUTUI_REDUCED_MOTION?.toLowerCase();
  return value === "1" || value === "true" || env.TERM === "dumb";
}

export interface UseAnimationFrameOptions {
  /** 响应式开关；false 时退订，调度器没有订阅者就停表 */
  enabled?: () => boolean;
  /** 测试 / 嵌入方可以注入自己的调度器 */
  scheduler?: AnimationScheduler;
}

/**
 * 返回当前动画时间（毫秒）。
 *
 * 只有 `enabled()` 为 true 时才订阅。组件卸载后自动退订。
 */
export function useAnimationFrame(options: UseAnimationFrameOptions = {}): Accessor<number> {
  const [time, setTime] = createSignal(0);
  createEffect(
    () => options.enabled?.() ?? true,
    enabled => {
      if (!enabled) return;
      return (options.scheduler ?? animationScheduler).subscribe(setTime);
    }
  );
  return time;
}
