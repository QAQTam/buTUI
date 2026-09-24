import type { PluginCapability } from "./types.ts";

export type CapabilityLeaseState = "active" | "revoked" | "expired";

export interface CapabilityLease {
  readonly id: number;
  readonly pluginId: string;
  readonly capability: PluginCapability;
  readonly grantedAt: number;
  readonly expiresAt?: number;
  readonly state: CapabilityLeaseState;
}

export type CapabilityBrokerEvent =
  | { type: "granted"; lease: CapabilityLease }
  | { type: "revoked"; lease: CapabilityLease; reason: string }
  | { type: "expired"; lease: CapabilityLease };

export interface CapabilityGrantOptions {
  /** 到期自动 revoke；不传表示直到显式 revoke。 */
  ttlMs?: number;
}

export interface CapabilityBrokerOptions {
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface MutableLease {
  id: number;
  pluginId: string;
  capability: PluginCapability;
  grantedAt: number;
  expiresAt?: number;
  state: CapabilityLeaseState;
}

/**
 * 插件 capability lease broker。
 *
 * 这是应用进程内的权限生命周期，不是 OS sandbox。loader 可以在动态 import 前
 * grant，在插件 dispose 时 revoke；TTL 过期会自动失效。
 */
export class CapabilityBroker {
  private readonly now: () => number;
  private readonly setTimer: NonNullable<CapabilityBrokerOptions["setTimeout"]>;
  private readonly clearTimer: NonNullable<CapabilityBrokerOptions["clearTimeout"]>;
  private readonly leases = new Map<number, MutableLease>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(event: CapabilityBrokerEvent) => void>();
  private nextId = 1;
  private disposed = false;

  constructor(options: CapabilityBrokerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  grant(
    pluginId: string,
    capability: PluginCapability,
    options: CapabilityGrantOptions = {}
  ): CapabilityLease {
    if (this.disposed) throw new Error("[butui] capability broker 已关闭");
    const grantedAt = this.now();
    const ttlMs =
      options.ttlMs === undefined
        ? undefined
        : Math.max(0, Math.floor(options.ttlMs));
    const lease: MutableLease = {
      id: this.nextId++,
      pluginId,
      capability,
      grantedAt,
      ...(ttlMs !== undefined ? { expiresAt: grantedAt + ttlMs } : {}),
      state: "active",
    };
    this.leases.set(lease.id, lease);
    this.emit({ type: "granted", lease });
    if (ttlMs !== undefined) {
      const handle = this.setTimer(() => this.expire(lease), ttlMs);
      this.timers.set(lease.id, handle);
    }
    return lease;
  }

  has(pluginId: string, capability: PluginCapability): boolean {
    for (const lease of this.leases.values()) {
      if (
        lease.pluginId === pluginId &&
        lease.capability === capability &&
        lease.state === "active"
      ) {
        return true;
      }
    }
    return false;
  }

  active(pluginId?: string): readonly CapabilityLease[] {
    return [...this.leases.values()].filter(
      lease =>
        lease.state === "active" &&
        (pluginId === undefined || lease.pluginId === pluginId)
    );
  }

  revoke(lease: CapabilityLease, reason = "revoked"): boolean {
    const current = this.leases.get(lease.id);
    if (!current || current.state !== "active") return false;
    current.state = "revoked";
    this.clearLeaseTimer(current.id);
    this.emit({ type: "revoked", lease: current, reason });
    return true;
  }

  revokeAll(pluginId: string, reason = "plugin-disposed"): number {
    let revoked = 0;
    for (const lease of this.leases.values()) {
      if (lease.pluginId !== pluginId || lease.state !== "active") continue;
      if (this.revoke(lease, reason)) revoked++;
    }
    return revoked;
  }

  onEvent(listener: (event: CapabilityBrokerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const lease of this.leases.values()) {
      if (lease.state === "active") {
        lease.state = "revoked";
        this.emit({ type: "revoked", lease, reason: "broker-disposed" });
      }
    }
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    this.leases.clear();
    this.listeners.clear();
  }

  private expire(lease: MutableLease): void {
    if (lease.state !== "active") return;
    lease.state = "expired";
    this.clearLeaseTimer(lease.id);
    this.emit({ type: "expired", lease });
  }

  private clearLeaseTimer(id: number): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    this.clearTimer(timer);
    this.timers.delete(id);
  }

  private emit(event: CapabilityBrokerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
