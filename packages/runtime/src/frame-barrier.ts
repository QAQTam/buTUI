/**
 * Frame flush barrier —— v0.2 的 accepted / drained 同步点。
 *
 * accepted：终端 writable 已接收字节，即使返回 backpressure。
 * drained：仅当发生 backpressure 时，等待 writable 排空。
 *
 * FrameId 在 runtime 内单调递增；完成的 frame 会保留一小段窗口，方便
 * suspend、退出和测试在稍后查询同一个 frame。
 */

export type FrameFlushMode = "accepted" | "drained";

export interface FrameBarrier {
  readonly frameId: number;
  readonly accepted: Promise<void>;
  readonly drained: Promise<void>;
  markAccepted(): void;
  markDrained(): void;
  reject(error: unknown): void;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  settled(): boolean;
}

interface BarrierEntry extends FrameBarrier {
  acceptedDeferred: Deferred;
  drainedDeferred: Deferred;
  state: "pending" | "accepted" | "drained" | "rejected";
  error?: Error;
}

interface FrameSnapshot {
  accepted: boolean;
  drained: boolean;
  error?: Error;
}

const DEFAULT_COMPLETED_LIMIT = 240;

export class FrameBarrierStore {
  private readonly pending = new Map<number, BarrierEntry>();
  private readonly completed = new Map<number, FrameSnapshot>();

  constructor(private readonly completedLimit = DEFAULT_COMPLETED_LIMIT) {
    if (!Number.isFinite(completedLimit) || completedLimit < 1) {
      throw new Error("[butui] FrameBarrierStore completedLimit 必须为正数");
    }
  }

  begin(frameId: number): FrameBarrier {
    const existing = this.pending.get(frameId);
    if (existing) return existing;
    const entry = createEntry(frameId);
    this.attach(entry);
    this.pending.set(frameId, entry);
    return entry;
  }

  wait(frameId: number, mode: FrameFlushMode = "accepted"): Promise<void> {
    const pending = this.pending.get(frameId);
    if (pending) return mode === "accepted" ? pending.accepted : pending.drained;

    const snapshot = this.completed.get(frameId);
    if (!snapshot) {
      return Promise.reject(new Error(`[butui] unknown frame ${frameId}`));
    }
    if (mode === "accepted" && snapshot.accepted) return Promise.resolve();
    if (mode === "drained" && snapshot.drained) return Promise.resolve();
    if (snapshot.error) return Promise.reject(snapshot.error);
    return Promise.reject(
      new Error(`[butui] frame ${frameId} 未完成 ${mode}，且没有待处理记录`)
    );
  }

  rejectAll(error: unknown): void {
    const normalized = normalizeError(error);
    for (const entry of [...this.pending.values()]) entry.reject(normalized);
  }

  get size(): number {
    return this.pending.size;
  }

  private attach(entry: BarrierEntry): void {
    entry.markAccepted = () => {
      if (entry.state !== "pending") return;
      entry.state = "accepted";
      entry.acceptedDeferred.resolve();
      this.remember(entry.frameId, { accepted: true, drained: false });
    };
    entry.markDrained = () => {
      if (entry.state === "drained" || entry.state === "rejected") return;
      if (entry.state === "pending") {
        entry.state = "accepted";
        entry.acceptedDeferred.resolve();
      }
      entry.state = "drained";
      entry.drainedDeferred.resolve();
      this.pending.delete(entry.frameId);
      this.remember(entry.frameId, { accepted: true, drained: true });
    };
    entry.reject = error => {
      if (entry.state === "rejected" || entry.state === "drained") return;
      const accepted = entry.acceptedDeferred.settled();
      entry.state = "rejected";
      entry.error = normalizeError(error);
      entry.acceptedDeferred.reject(entry.error);
      entry.drainedDeferred.reject(entry.error);
      this.pending.delete(entry.frameId);
      this.remember(entry.frameId, {
        accepted,
        drained: false,
        error: entry.error,
      });
    };
  }

  private remember(frameId: number, snapshot: FrameSnapshot): void {
    this.completed.set(frameId, snapshot);
    while (this.completed.size > this.completedLimit) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }
}

function createEntry(frameId: number): BarrierEntry {
  const acceptedDeferred = deferred();
  const drainedDeferred = deferred();
  return {
    frameId,
    accepted: acceptedDeferred.promise,
    drained: drainedDeferred.promise,
    acceptedDeferred,
    drainedDeferred,
    state: "pending",
    markAccepted: () => {},
    markDrained: () => {},
    reject: () => {},
  };
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let done = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = () => {
      if (done) return;
      done = true;
      resolve();
    };
    rejectPromise = error => {
      if (done) return;
      done = true;
      reject(error);
    };
  });
  // A caller may only await accepted while a later stop rejects drained too.
  // Keep that rejection from surfacing as an unhandled rejection while the
  // original promise remains awaitable.
  void promise.catch(() => {});
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: () => done,
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
