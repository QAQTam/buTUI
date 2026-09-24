/**
 * TerminalArbiter —— v0.2 的终端单写者原型。
 *
 * 这里不碰 TTY / raw mode，只仲裁“谁现在可以写终端”。真正的 TerminalSession
 * 接入放在后续步骤；先验证 lease 状态机和 frame / append / raw 规则。
 */

export type LeaseKind = "frame" | "append" | "raw" | "probe";
export type LeaseState = "pending" | "active" | "suspended" | "released" | "revoked";
export type TerminalCapability = LeaseKind | "control";

export interface LeaseRequest {
  owner: string;
  kind: LeaseKind;
  reason: string;
  /** 数值越大优先级越高；相同优先级按请求顺序。 */
  priority?: number;
  ttlMs?: number;
  signal?: AbortSignal;
}

export interface TerminalLease {
  id: number;
  owner: string;
  kind: LeaseKind;
  state: LeaseState;
  acquiredAt: number;
  expiresAt?: number;
  capabilities: ReadonlySet<TerminalCapability>;
}

export interface WriteBatch {
  kind: "frame" | "append" | "control";
  frameId?: number;
  bytes: string | Uint8Array;
  replaces?: number;
  barrier?: boolean;
  flush?: "accepted" | "drained";
}

export type WriteRejectReason =
  | "not-owner"
  | "suspended"
  | "stale-frame"
  | "superseded"
  | "closed";

export interface WriteReceipt {
  accepted: boolean;
  blocked: boolean;
  bytesWritten: number;
  acceptedAt?: number;
  drained?: Promise<void>;
  rejectedReason?: WriteRejectReason;
  requiresFullDamage?: boolean;
}

export type ArbiterEvent =
  | { type: "acquired"; lease: TerminalLease }
  | { type: "write"; lease: TerminalLease; batch: WriteBatch; receipt: WriteReceipt }
  | { type: "blocked"; lease: TerminalLease }
  | { type: "drained"; lease: TerminalLease }
  | { type: "suspended"; lease: TerminalLease; reason: string }
  | { type: "resumed"; lease: TerminalLease }
  | { type: "released"; lease: TerminalLease }
  | { type: "revoked"; lease: TerminalLease; reason: string };

export interface TerminalArbiterOptions {
  write: (bytes: string | Uint8Array) => boolean | void;
  onDrain?: (listener: () => void) => () => void;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface PendingRequest {
  request: LeaseRequest;
  order: number;
  resolve: (lease: TerminalLease) => void;
  reject: (error: Error) => void;
}

export class TerminalArbiter {
  private readonly writeRaw: (bytes: string | Uint8Array) => boolean | void;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<TerminalArbiterOptions["setTimeout"]>;
  private readonly clearTimer: NonNullable<TerminalArbiterOptions["clearTimeout"]>;
  private readonly listeners = new Set<(event: ArbiterEvent) => void>();
  private readonly pending: PendingRequest[] = [];
  private readonly leases = new Map<number, TerminalLease>();
  private readonly ttlTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private drainWaiters: Array<() => void> = [];
  private active: TerminalLease | undefined;
  private nextLeaseId = 1;
  private nextOrder = 1;
  private lastAcceptedFrameId = 0;
  private needsFullDamage = false;

  constructor(options: TerminalArbiterOptions) {
    this.writeRaw = options.write;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
    options.onDrain?.(() => {
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const resolve of waiters) resolve();
      if (this.active) this.emit({ type: "drained", lease: this.active });
    });
  }

  /**
   * 同步获取 lease；只有当前无 owner 且无等待队列时成功。
   * 给必须保持同步签名的 TerminalSession.start() 使用。
   */
  tryAcquire(request: LeaseRequest): TerminalLease | undefined {
    if (request.signal?.aborted) return undefined;
    if (this.active || this.pending.length > 0) return undefined;
    return this.grant(request);
  }

  acquire(request: LeaseRequest): Promise<TerminalLease> {
    if (request.signal?.aborted) {
      return Promise.reject(new Error("[butui] terminal lease request aborted"));
    }

    if (!this.active && this.pending.length === 0) {
      const lease = this.grant(request);
      return Promise.resolve(lease);
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        request,
        order: this.nextOrder++,
        resolve,
        reject,
      };
      this.pending.push(pending);
      request.signal?.addEventListener(
        "abort",
        () => {
          const index = this.pending.indexOf(pending);
          if (index !== -1) this.pending.splice(index, 1);
          reject(new Error("[butui] terminal lease request aborted"));
        },
        { once: true }
      );
    });
  }

  write(lease: TerminalLease, batch: WriteBatch): WriteReceipt {
    const rejection = this.rejectWrite(lease, batch);
    if (rejection) return rejection;

    const bytesWritten = byteLength(batch.bytes);
    if (batch.kind === "append") {
      this.needsFullDamage = true;
    }
    if (batch.kind === "frame" && batch.frameId !== undefined) {
      if (
        batch.replaces !== undefined &&
        batch.replaces <= this.lastAcceptedFrameId
      ) {
        return {
          accepted: false,
          blocked: false,
          bytesWritten: 0,
          rejectedReason: "superseded",
        };
      }
      if (batch.frameId <= this.lastAcceptedFrameId) {
        return {
          accepted: false,
          blocked: false,
          bytesWritten: 0,
          rejectedReason: "stale-frame",
        };
      }
    }

    // Writable.write(false) 表示数据已入队但缓冲达到 highWaterMark；
    // 它不是拒绝。accepted 与 blocked 必须分开表达。
    const blocked = this.writeRaw(batch.bytes) === false;
    const receipt: WriteReceipt = {
      accepted: true,
      blocked,
      bytesWritten,
      acceptedAt: this.now(),
      ...(blocked ? { drained: this.drainPromise() } : {}),
      ...(this.needsFullDamage ? { requiresFullDamage: true } : {}),
    };

    if (batch.kind === "frame" && batch.frameId !== undefined) {
      this.lastAcceptedFrameId = batch.frameId;
      this.needsFullDamage = false;
    }
    if (blocked) this.emit({ type: "blocked", lease });
    this.emit({ type: "write", lease, batch, receipt });
    return receipt;
  }

  async suspend(lease: TerminalLease, reason: string): Promise<void> {
    if (lease.state !== "active" || this.active !== lease) return;
    lease.state = "suspended";
    this.active = undefined;
    this.emit({ type: "suspended", lease, reason });
    this.grantNext();
  }

  async resume(lease: TerminalLease): Promise<void> {
    if (lease.state !== "suspended") return;
    if (this.active && this.active !== lease) {
      throw new Error("[butui] terminal is owned by another lease");
    }
    lease.state = "active";
    this.active = lease;
    this.needsFullDamage = true;
    this.emit({ type: "resumed", lease });
  }

  async release(lease: TerminalLease): Promise<void> {
    if (lease.state === "released" || lease.state === "revoked") return;
    lease.state = "released";
    this.clearTtl(lease);
    if (this.active === lease) this.active = undefined;
    this.emit({ type: "released", lease });
    this.grantNext();
  }

  revoke(lease: TerminalLease, reason: string): void {
    if (lease.state === "revoked") return;
    lease.state = "revoked";
    this.clearTtl(lease);
    if (this.active === lease) this.active = undefined;
    this.emit({ type: "revoked", lease, reason });
    this.grantNext();
  }

  current(): TerminalLease | undefined {
    return this.active;
  }

  requiresFullDamage(): boolean {
    return this.needsFullDamage;
  }

  onEvent(listener: (event: ArbiterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.active) this.revoke(this.active, "dispose");
    for (const pending of this.pending.splice(0)) {
      pending.reject(new Error("[butui] terminal arbiter disposed"));
    }
    for (const lease of this.leases.values()) this.clearTtl(lease);
    this.listeners.clear();
  }

  private grant(request: LeaseRequest): TerminalLease {
    const lease: TerminalLease = {
      id: this.nextLeaseId++,
      owner: request.owner,
      kind: request.kind,
      state: "active",
      acquiredAt: this.now(),
      capabilities: new Set<TerminalCapability>([request.kind]),
    };
    if (request.ttlMs !== undefined && request.ttlMs > 0) {
      lease.expiresAt = lease.acquiredAt + request.ttlMs;
      this.ttlTimers.set(
        lease.id,
        this.setTimer(() => this.revoke(lease, "ttl"), request.ttlMs)
      );
    }
    this.leases.set(lease.id, lease);
    this.active = lease;
    this.emit({ type: "acquired", lease });
    return lease;
  }

  private grantNext(): void {
    if (this.active || this.pending.length === 0) return;
    this.pending.sort(
      (a, b) =>
        (b.request.priority ?? 0) - (a.request.priority ?? 0) || a.order - b.order
    );
    const next = this.pending.shift()!;
    const lease = this.grant(next.request);
    next.resolve(lease);
  }

  private rejectWrite(
    lease: TerminalLease,
    _batch: WriteBatch
  ): WriteReceipt | undefined {
    if (lease.state === "suspended") {
      return rejected("suspended");
    }
    if (lease.state === "released" || lease.state === "revoked") {
      return rejected("closed");
    }
    if (this.active !== lease) {
      return rejected("not-owner");
    }
    return undefined;
  }

  private drainPromise(): Promise<void> {
    return new Promise(resolve => {
      this.drainWaiters.push(resolve);
    });
  }

  private clearTtl(lease: TerminalLease): void {
    const timer = this.ttlTimers.get(lease.id);
    if (timer !== undefined) {
      this.clearTimer(timer);
      this.ttlTimers.delete(lease.id);
    }
  }

  private emit(event: ArbiterEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function rejected(reason: WriteRejectReason): WriteReceipt {
  return {
    accepted: false,
    blocked: false,
    bytesWritten: 0,
    rejectedReason: reason,
  };
}

function byteLength(bytes: string | Uint8Array): number {
  return typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
}
