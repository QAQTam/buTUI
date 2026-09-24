/**
 * 高频渲染合帧调度。
 *
 * 默认的 `microtask` 模式只合并同一个 tick。流式 token 如果分别来自不同的
 * timer / I/O 回调，2000 tok/s 就会变成 2000 次 `flush + layout + draw`。
 *
 * `frame` 模式给终端写入设一个帧预算：
 *
 *   - 空闲后的第一次变更走微任务，避免凭空增加一帧延迟；
 *   - 帧预算内后续变更只标脏，不重置计时器；
 *   - 到 deadline 时读取最新树，因此 latest state wins；
 *   - 最后一次变更仍会触发尾帧，不会丢掉流式内容的尾巴。
 */

export type RenderMode = "microtask" | "frame";

export interface RenderOptions {
  /**
   * `microtask`（默认）保持现有语义：同一 tick 合并一次。
   * `frame` 适合高频流式 chunk，按 fps 限制终端写入频率。
   */
  mode?: RenderMode;
  /** frame 模式的目标帧率，默认 60；限制在 1~240。 */
  fps?: number;
}

export interface RenderSchedulerDependencies {
  /** 测试注入；默认 performance.now。 */
  now?: () => number;
  /** 测试注入；默认 queueMicrotask。 */
  queueMicrotask?: (callback: () => void) => void;
  /** 测试注入；默认 setTimeout。 */
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  /** 测试注入；默认 clearTimeout。 */
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

const MIN_FPS = 1;
const MAX_FPS = 240;

/**
 * 把零散 request 合成帧。
 *
 * 该类不依赖 DOM / TUI；runtime 只负责在回调里 `flush + layout + draw`。
 */
export class RenderScheduler {
  private readonly mode: RenderMode;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly microtask: (callback: () => void) => void;
  private readonly setTimer: (
    callback: () => void,
    delay: number
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastPaintAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    private readonly run: () => void,
    options: RenderOptions = {},
    dependencies: RenderSchedulerDependencies = {}
  ) {
    this.mode = options.mode ?? "microtask";
    const fps = clamp(options.fps ?? 60, MIN_FPS, MAX_FPS);
    this.intervalMs = 1000 / fps;
    this.now = dependencies.now ?? (() => performance.now());
    this.microtask = dependencies.queueMicrotask ?? queueMicrotask;
    this.setTimer = dependencies.setTimeout ?? setTimeout;
    this.clearTimer = dependencies.clearTimeout ?? clearTimeout;
  }

  get active(): boolean {
    return this.pending;
  }

  request(): void {
    if (this.disposed || this.pending) return;
    this.pending = true;
    const now = this.now();

    if (this.mode === "microtask" || now - this.lastPaintAt >= this.intervalMs) {
      this.microtask(() => this.fire());
      return;
    }

    const delay = Math.max(0, this.intervalMs - (now - this.lastPaintAt));
    this.timer = this.setTimer(() => this.fire(), delay);
  }

  /** 每次真正 draw 后调用；让下一帧从绘制完成时刻重新计预算。 */
  markPainted(): void {
    this.lastPaintAt = this.now();
  }

  /** 取消尚未触发的尾帧（dispose 用）。 */
  cancel(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.pending = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private fire(): void {
    this.timer = undefined;
    this.pending = false;
    if (this.disposed) return;
    this.run();
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
