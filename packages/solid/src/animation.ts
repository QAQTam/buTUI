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
import { FrameClock, type FrameRequestHandle } from "@butui/core";
import { createEffect, createSignal, flush, type Accessor } from "solid-js";
import { useAppScope } from "./app-context.ts";

export interface AnimationSchedulerOptions {
  /** 默认 30fps；终端不需要 60fps 的手机级动画 */
  fps?: number;
  now?: () => number;
  /** 嵌入 runtime 时注入共享 FrameClock；不传则自己创建一个。 */
  clock?: FrameClock;
  /** 默认 decorative；SmoothStream 使用 reveal。 */
  lane?: "reveal" | "decorative";
  /** 同一个 FrameClock 上必须唯一；默认 animation。 */
  coalesceKey?: string;
}

export class AnimationScheduler {
  private readonly listeners = new Set<(time: number) => void>();
  private readonly interval: number;
  private readonly now: () => number;
  private readonly clock: FrameClock;
  private readonly lane: "reveal" | "decorative";
  private readonly coalesceKey: string;
  private handle: FrameRequestHandle | undefined;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private revision = 0;

  constructor(options: AnimationSchedulerOptions = {}) {
    const fps = Math.max(1, Math.min(120, options.fps ?? 30));
    this.interval = Math.max(1, Math.round(1000 / fps));
    this.lane = options.lane ?? "decorative";
    this.coalesceKey = options.coalesceKey ?? "animation";
    this.clock =
      options.clock ??
      new FrameClock(
        { fps },
        options.now ? { now: options.now } : {}
      );
    this.now = options.now ?? (() => this.clock.now());
  }

  get active(): boolean {
    return this.handle !== undefined;
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

  /** 手动推进一帧；测试用，也方便嵌入方接管时钟。 */
  tick(time = this.now()): void {
    this.lastTickAt = time;
    for (const listener of [...this.listeners]) listener(time);
    // Solid 2 的写入延迟到 flush；动画帧必须自己提交，否则 terminal 不会看到
    // 节点变更，也就不会 requestPaint。
    flush();
  }

  stop(): void {
    this.handle?.cancel();
    this.handle = undefined;
  }

  private start(): void {
    if (this.handle) return;
    this.schedule();
  }

  private schedule(): void {
    const now = this.now();
    const deadline = Number.isFinite(this.lastTickAt)
      ? Math.max(now, this.lastTickAt + this.interval)
      : now;

    this.handle = this.clock.request({
      lane: this.lane,
      reason: "animation",
      sessionRevision: ++this.revision,
      deadline,
      coalesceKey: this.coalesceKey,
      work: tick => {
        this.handle = undefined;
        if (this.listeners.size === 0) return;
        this.tick(tick.clockTime);
        if (this.listeners.size > 0) this.schedule();
      },
    });
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
  const scope = useAppScope();
  const scheduler = options.scheduler ?? scope?.animationScheduler ?? animationScheduler;
  createEffect(
    () => options.enabled?.() ?? true,
    enabled => {
      if (!enabled) return;
      return scheduler.subscribe(setTime);
    }
  );
  return time;
}
