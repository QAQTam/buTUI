/**
 * v0.2 FrameClock 原型。
 *
 * 这是 P0-A 的隔离实现：先把 request / lane / budget / backpressure 语义跑通，
 * 暂不接入 `createTuiApp`。目标是给后续 RenderScheduler、AnimationScheduler 和
 * SmoothStream 迁移提供一个可测试的时间源。
 *
 * 设计文档见 `V0.2_P0_FRAME_CLOCK.md`。
 */

export type FrameLane = "critical" | "reveal" | "decorative" | "maintenance";
export type QualityLevel = "full" | "balanced" | "responsive" | "minimal";

export type FrameId = number;
export type SessionRevision = number;

export type FrameWorkResult =
  | { status: "idle" }
  | { status: "dirty"; revision: SessionRevision }
  | { status: "budget-exceeded"; phase: string };

export type ClockFrameOutcome =
  | { status: "presented"; frameId: FrameId; at: number }
  | { status: "blocked"; frameId: FrameId; at: number }
  | { status: "drained"; frameId: FrameId; at: number }
  | { status: "superseded"; frameId: FrameId; at: number }
  | { status: "aborted"; frameId: FrameId; at: number; reason: string };

export interface FrameTick {
  clockTime: number;
  frameId: FrameId;
  quality: QualityLevel;
  budgetMs: number;
  sessionRevision: SessionRevision;
  phase: "dispatch";
}

export interface FrameRequest {
  lane: FrameLane;
  reason: string;
  sessionRevision: SessionRevision;
  deadline?: number;
  coalesceKey?: string;
  work: (tick: FrameTick) => FrameWorkResult | void;
}

export interface FrameRequestHandle {
  readonly key: string;
  cancel(): void;
}

export interface FrameDispatchSample {
  frameId: FrameId;
  clockTime: number;
  computeMs: number;
  budgetMs: number;
  quality: QualityLevel;
  ran: readonly FrameLane[];
  skipped: readonly FrameLane[];
  dirtyRevision?: SessionRevision;
}

export interface FrameClockStats {
  active: boolean;
  blocked: boolean;
  queued: number;
  frameId: FrameId;
  quality: QualityLevel;
  lastDispatchAt?: number;
  lastPresentedAt?: number;
  dispatches: number;
  skipped: number;
  superseded: number;
  aborted: number;
  lastDispatch?: FrameDispatchSample;
}

export interface FrameClockDependencies {
  now?: () => number;
  queueMicrotask?: (callback: () => void) => void;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface FrameClockOptions {
  /** 默认 120；限制在 1~240。 */
  fps?: number;
  /** 默认 full。 */
  quality?: QualityLevel;
  /** 覆盖当前 quality 的 compute budget；测试和嵌入方使用。 */
  budgetMs?: number;
}

interface InternalRequest extends FrameRequest {
  key: string;
  order: number;
  deadline: number;
}

const MIN_FPS = 1;
const MAX_FPS = 240;
const MIN_SLICE_MS = {
  reveal: 0.5,
  decorative: 0.25,
  maintenance: 0.25,
} as const;

const LANE_ORDER: Record<FrameLane, number> = {
  critical: 0,
  reveal: 1,
  decorative: 2,
  maintenance: 3,
};

const QUALITY_BUDGET_MS: Record<QualityLevel, number> = {
  full: 6,
  balanced: 12,
  responsive: 8,
  minimal: 4,
};

export class FrameClock {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly microtask: (callback: () => void) => void;
  private readonly setTimer: (
    callback: () => void,
    delay: number
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private quality: QualityLevel;
  private readonly budgetOverride?: number;
  private readonly queue = new Map<string, InternalRequest>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private microtaskScheduled = false;
  private wakeEpoch = 0;
  private blocked = false;
  private disposed = false;
  private nextFrameId = 1;
  private nextOrder = 1;
  private lastDispatchAt = Number.NEGATIVE_INFINITY;
  private lastPresentedAt: number | undefined;
  private lastMaintenanceAt = Number.NEGATIVE_INFINITY;
  private dispatches = 0;
  private skipped = 0;
  private superseded = 0;
  private aborted = 0;
  private lastDispatch: FrameDispatchSample | undefined;

  constructor(
    options: FrameClockOptions = {},
    dependencies: FrameClockDependencies = {}
  ) {
    const fps = clamp(options.fps ?? 120, MIN_FPS, MAX_FPS);
    this.intervalMs = 1000 / fps;
    this.quality = options.quality ?? "full";
    if (options.budgetMs !== undefined) this.budgetOverride = Math.max(0, options.budgetMs);
    this.now = dependencies.now ?? (() => performance.now());
    this.microtask = dependencies.queueMicrotask ?? queueMicrotask;
    this.setTimer = dependencies.setTimeout ?? setTimeout;
    this.clearTimer = dependencies.clearTimeout ?? clearTimeout;
  }

  get active(): boolean {
    return this.queue.size > 0;
  }

  get isBlocked(): boolean {
    return this.blocked;
  }

  request(request: FrameRequest): FrameRequestHandle {
    const key = request.coalesceKey ?? `request:${this.nextOrder}`;
    if (this.disposed) return this.handleFor(key);

    const now = this.now();
    const deadline = this.deadlineFor(request, now);
    const previous = this.queue.get(key);
    if (!previous || request.sessionRevision >= previous.sessionRevision) {
      this.queue.set(key, {
        ...request,
        key,
        order: this.nextOrder++,
        deadline:
          previous && previous.sessionRevision === request.sessionRevision
            ? Math.min(previous.deadline, deadline)
            : deadline,
      });
    }

    this.scheduleWake();
    return this.handleFor(key);
  }

  cancel(handle: FrameRequestHandle): void {
    const request = this.queue.get(handle.key);
    if (request) this.queue.delete(handle.key);
    if (this.queue.size === 0) this.clearWake();
    else this.scheduleWake();
  }

  settle(outcome: ClockFrameOutcome): void {
    switch (outcome.status) {
      case "presented":
        this.lastPresentedAt = outcome.at;
        break;
      case "blocked":
        this.blocked = true;
        this.clearWake();
        break;
      case "drained":
        this.blocked = false;
        // 让 drain 后的 critical 立即可运行，而不是等下一整帧。
        this.lastDispatchAt = outcome.at - this.intervalMs;
        break;
      case "superseded":
        this.superseded++;
        break;
      case "aborted":
        this.aborted++;
        break;
    }
    this.scheduleWake();
  }

  setQuality(quality: QualityLevel): void {
    this.quality = quality;
    this.scheduleWake();
  }

  /**
   * 虚拟时间推进。
   *
   * `now` 仍由依赖注入；调用方应同步自己的 fake clock 后调用本方法。这样
   * FrameClock 不持有第二套时间，replay 也不需要 monkey-patch performance.now。
   */
  advanceTo(time: number): void {
    this.clearWake();
    this.runDue(time);
    this.scheduleWake();
  }

  stats(): FrameClockStats {
    return {
      active: this.active,
      blocked: this.blocked,
      queued: this.queue.size,
      frameId: this.nextFrameId - 1,
      quality: this.quality,
      ...(Number.isFinite(this.lastDispatchAt)
        ? { lastDispatchAt: this.lastDispatchAt }
        : {}),
      ...(this.lastPresentedAt !== undefined
        ? { lastPresentedAt: this.lastPresentedAt }
        : {}),
      dispatches: this.dispatches,
      skipped: this.skipped,
      superseded: this.superseded,
      aborted: this.aborted,
      ...(this.lastDispatch ? { lastDispatch: this.lastDispatch } : {}),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.clear();
    this.clearWake();
  }

  private deadlineFor(request: FrameRequest, now: number): number {
    if (request.deadline !== undefined) return request.deadline;
    if (request.lane === "critical" && !Number.isFinite(this.lastDispatchAt)) {
      return now;
    }
    if (request.lane === "maintenance") {
      return Math.max(now, this.lastDispatchAt + this.intervalMs, this.lastMaintenanceAt + 1000);
    }
    return Math.max(now, this.lastDispatchAt + this.intervalMs);
  }

  private handleFor(key: string): FrameRequestHandle {
    return {
      key,
      cancel: () => this.cancel({ key, cancel: () => {} }),
    };
  }

  private scheduleWake(): void {
    if (
      this.disposed ||
      this.blocked ||
      this.timer !== undefined ||
      this.microtaskScheduled ||
      this.queue.size === 0
    ) {
      return;
    }

    const next = this.earliestDeadline();
    if (next === undefined) return;
    const now = this.now();
    const epoch = this.wakeEpoch;

    if (now >= next) {
      this.microtaskScheduled = true;
      this.microtask(() => {
        if (this.disposed || epoch !== this.wakeEpoch) return;
        this.microtaskScheduled = false;
        this.runDue(this.now());
      });
      return;
    }

    this.timer = this.setTimer(() => {
      if (this.disposed || epoch !== this.wakeEpoch) return;
      this.timer = undefined;
      this.runDue(this.now());
    }, next - now);
  }

  private runDue(clockTime: number): void {
    if (this.disposed || this.blocked) return;

    const due = [...this.queue.values()]
      .filter(request => request.deadline <= clockTime)
      .sort(compareRequests);

    if (due.length === 0) return;

    const frameId = this.nextFrameId++ as FrameId;
    const budgetMs = this.budgetForQuality();
    const ran: FrameLane[] = [];
    const skipped: FrameLane[] = [];
    let dirtyRevision: SessionRevision | undefined;
    let usedMs = 0;

    for (const request of due) {
      if (this.queue.get(request.key) !== request) continue;

      if (!this.canRun(request.lane, usedMs, budgetMs)) {
        this.skipped++;
        skipped.push(request.lane);
        request.deadline = clockTime + this.intervalMs;
        continue;
      }

      this.queue.delete(request.key);
      const workStartedAt = this.now();
      const result = request.work({
        clockTime,
        frameId,
        quality: this.quality,
        budgetMs,
        sessionRevision: request.sessionRevision,
        phase: "dispatch",
      });
      usedMs += Math.max(0, this.now() - workStartedAt);

      if (request.lane === "maintenance") this.lastMaintenanceAt = clockTime;
      ran.push(request.lane);

      if (result?.status === "dirty" && result.revision > request.sessionRevision) {
        dirtyRevision = result.revision;
        this.queue.set(request.key, {
          ...request,
          sessionRevision: result.revision,
          deadline: Math.max(this.now(), clockTime + this.intervalMs),
        });
      }
    }

    this.lastDispatchAt = Math.max(clockTime, this.now());
    this.dispatches++;
    this.lastDispatch = {
      frameId,
      clockTime,
      computeMs: usedMs,
      budgetMs,
      quality: this.quality,
      ran,
      skipped,
      ...(dirtyRevision !== undefined ? { dirtyRevision } : {}),
    };

    this.scheduleWake();
  }

  private canRun(lane: FrameLane, usedMs: number, budgetMs: number): boolean {
    if (lane === "critical") return true;
    return usedMs + MIN_SLICE_MS[lane] <= budgetMs;
  }

  private budgetForQuality(): number {
    return this.budgetOverride ?? QUALITY_BUDGET_MS[this.quality];
  }

  private earliestDeadline(): number | undefined {
    let earliest: number | undefined;
    for (const request of this.queue.values()) {
      if (earliest === undefined || request.deadline < earliest) earliest = request.deadline;
    }
    return earliest;
  }

  private clearWake(): void {
    this.wakeEpoch++;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.microtaskScheduled = false;
  }
}

function compareRequests(a: InternalRequest, b: InternalRequest): number {
  return LANE_ORDER[a.lane] - LANE_ORDER[b.lane] || a.deadline - b.deadline || a.order - b.order;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
