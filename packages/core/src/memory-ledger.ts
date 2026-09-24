/**
 * MemoryLedger —— v0.2 的内存准入控制原型。
 *
 * 它不是 GC 建议，而是 allocation 前的预算检查：能 grant 就 grant；预算不足时
 * 先返回可 spill 的 reservation，不静默把长期状态降级成 hot。
 */

export type MemoryClass = "ephemeral" | "hot" | "warm" | "cold" | "pinned";
export type MemoryPriority = 0 | 1 | 2 | 3;

export interface MemoryRequest {
  owner: string;
  class: MemoryClass;
  bytes: number;
  priority: MemoryPriority;
  spillable?: boolean;
  reconstructible?: boolean;
}

export interface MemoryPolicy {
  totalBytes: number;
  classLimits?: Partial<Record<MemoryClass, number>>;
}

export type MemoryDecision =
  | { status: "granted"; reservation: MemoryReservation }
  | { status: "spill-required"; candidates: readonly string[] }
  | { status: "rejected"; reason: "budget" | "pinned-limit" };

export interface MemoryReservation {
  id: string;
  readonly bytes: number;
  readonly class: MemoryClass;
  resize(nextBytes: number): MemoryDecision;
  release(): void;
}

export interface MemoryPressure {
  usedBytes: number;
  totalBytes: number;
  ratio: number;
  byClass: Readonly<Record<MemoryClass, number>>;
}

export interface MemoryStats {
  reservations: number;
  usedBytes: number;
  peakBytes: number;
  byClass: Readonly<Record<MemoryClass, number>>;
  rejected: number;
  spillRequired: number;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  totalBytes: Number.POSITIVE_INFINITY,
};

interface InternalReservation {
  id: string;
  owner: string;
  class: MemoryClass;
  bytes: number;
  priority: MemoryPriority;
  spillable: boolean;
  reconstructible: boolean;
}

const MEMORY_CLASSES: readonly MemoryClass[] = [
  "ephemeral",
  "hot",
  "warm",
  "cold",
  "pinned",
];

export class MemoryLedger {
  private policy: MemoryPolicy = { ...DEFAULT_MEMORY_POLICY };
  private readonly reservations = new Map<string, InternalReservation>();
  private nextId = 1;
  private peakBytes = 0;
  private rejected = 0;
  private spillRequired = 0;

  constructor(policy: MemoryPolicy = DEFAULT_MEMORY_POLICY) {
    this.setPolicy(policy);
  }

  reserve(request: MemoryRequest): MemoryDecision {
    const bytes = normalizeBytes(request.bytes);
    if (bytes === undefined) return this.reject("budget");

    const used = this.usedBytes();
    const classUsed = this.usedByClass()[request.class];
    const classLimit = this.policy.classLimits?.[request.class] ?? Number.POSITIVE_INFINITY;
    if (request.class === "pinned" && classUsed + bytes > classLimit) {
      return this.reject("pinned-limit");
    }
    if (used + bytes > this.policy.totalBytes || classUsed + bytes > classLimit) {
      return this.requireSpill();
    }

    const internal: InternalReservation = {
      id: `mem-${this.nextId++}`,
      owner: request.owner,
      class: request.class,
      bytes,
      priority: request.priority,
      spillable: request.spillable ?? false,
      reconstructible: request.reconstructible ?? false,
    };
    this.reservations.set(internal.id, internal);
    this.peakBytes = Math.max(this.peakBytes, this.usedBytes());
    return { status: "granted", reservation: this.publicReservation(internal) };
  }

  pressure(): MemoryPressure {
    const byClass = this.usedByClass();
    const usedBytes = this.usedBytes();
    return {
      usedBytes,
      totalBytes: this.policy.totalBytes,
      ratio:
        this.policy.totalBytes === Number.POSITIVE_INFINITY
          ? 0
          : usedBytes / this.policy.totalBytes,
      byClass,
    };
  }

  stats(): MemoryStats {
    return {
      reservations: this.reservations.size,
      usedBytes: this.usedBytes(),
      peakBytes: this.peakBytes,
      byClass: this.usedByClass(),
      rejected: this.rejected,
      spillRequired: this.spillRequired,
    };
  }

  setPolicy(policy: MemoryPolicy): void {
    this.policy = {
      totalBytes: Math.max(0, policy.totalBytes),
      ...(policy.classLimits ? { classLimits: { ...policy.classLimits } } : {}),
    };
  }

  dispose(): void {
    this.reservations.clear();
  }

  private publicReservation(internal: InternalReservation): MemoryReservation {
    return {
      id: internal.id,
      get bytes() {
        return internal.bytes;
      },
      get class() {
        return internal.class;
      },
      resize: (nextBytes: number) => this.resize(internal, nextBytes),
      release: () => this.release(internal.id),
    };
  }

  private resize(
    internal: InternalReservation,
    nextBytes: number
  ): MemoryDecision {
    const normalized = normalizeBytes(nextBytes);
    if (normalized === undefined) return this.reject("budget");

    const delta = normalized - internal.bytes;
    if (delta > 0) {
      const used = this.usedBytes();
      const classUsed = this.usedByClass()[internal.class];
      const classLimit =
        this.policy.classLimits?.[internal.class] ?? Number.POSITIVE_INFINITY;
      if (
        (internal.class === "pinned" && classUsed + delta > classLimit) ||
        used + delta > this.policy.totalBytes ||
        classUsed + delta > classLimit
      ) {
        return this.requireSpill();
      }
    }

    internal.bytes = normalized;
    this.peakBytes = Math.max(this.peakBytes, this.usedBytes());
    return { status: "granted", reservation: this.publicReservation(internal) };
  }

  private release(id: string): void {
    this.reservations.delete(id);
  }

  private requireSpill(): MemoryDecision {
    const candidates = [...this.reservations.values()]
      .filter(reservation => reservation.spillable && reservation.class !== "pinned")
      .sort((a, b) => b.priority - a.priority || b.bytes - a.bytes)
      .map(reservation => reservation.id);

    if (candidates.length === 0) return this.reject("budget");
    this.spillRequired++;
    return { status: "spill-required", candidates };
  }

  private reject(reason: "budget" | "pinned-limit"): MemoryDecision {
    this.rejected++;
    return { status: "rejected", reason };
  }

  private usedBytes(): number {
    let total = 0;
    for (const reservation of this.reservations.values()) total += reservation.bytes;
    return total;
  }

  private usedByClass(): Record<MemoryClass, number> {
    const result = Object.fromEntries(
      MEMORY_CLASSES.map(memoryClass => [memoryClass, 0])
    ) as Record<MemoryClass, number>;
    for (const reservation of this.reservations.values()) {
      result[reservation.class] += reservation.bytes;
    }
    return result;
  }
}

function normalizeBytes(bytes: number): number | undefined {
  if (!Number.isFinite(bytes) || bytes < 0) return undefined;
  return Math.floor(bytes);
}
