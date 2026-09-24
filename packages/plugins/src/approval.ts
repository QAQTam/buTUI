import type { CapabilityApprovalRequest } from "./loader.ts";

export type CapabilityApprovalState = "pending" | "approved" | "denied";

export interface CapabilityApprovalItem {
  readonly id: number;
  readonly request: CapabilityApprovalRequest;
  readonly state: CapabilityApprovalState;
  readonly requestedAt: number;
  readonly decidedAt?: number;
}

export type CapabilityApprovalEvent =
  | { type: "requested"; item: CapabilityApprovalItem }
  | { type: "resolved"; item: CapabilityApprovalItem; approved: boolean };

export interface CapabilityApprovalQueueOptions {
  now?: () => number;
}

interface PendingApproval {
  item: CapabilityApprovalItem;
  resolve: (approved: boolean) => void;
}

/**
 * 可挂审批 UI 的 capability 队列。
 *
 * loader 的 `approveCapability` 只需要等待 Promise；UI 可以读取 `pending()`，
 * 再调用 `resolve(id, approved)`。
 */
export class CapabilityApprovalQueue {
  private readonly now: () => number;
  private readonly entries = new Map<number, PendingApproval>();
  private readonly listeners = new Set<(event: CapabilityApprovalEvent) => void>();
  private nextId = 1;
  private disposed = false;

  constructor(options: CapabilityApprovalQueueOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  request(request: CapabilityApprovalRequest): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const item: CapabilityApprovalItem = {
      id: this.nextId++,
      request,
      state: "pending",
      requestedAt: this.now(),
    };
    return new Promise(resolve => {
      this.entries.set(item.id, { item, resolve });
      this.emit({ type: "requested", item });
    });
  }

  pending(): readonly CapabilityApprovalItem[] {
    return [...this.entries.values()].map(entry => entry.item);
  }

  resolve(id: number, approved: boolean): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.item.state !== "pending") return false;
    const item: CapabilityApprovalItem = {
      ...entry.item,
      state: approved ? "approved" : "denied",
      decidedAt: this.now(),
    };
    entry.item = item;
    this.entries.delete(id);
    entry.resolve(approved);
    this.emit({ type: "resolved", item, approved });
    return true;
  }

  onEvent(listener: (event: CapabilityApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      this.resolve(entry.item.id, false);
    }
    this.listeners.clear();
  }

  private emit(event: CapabilityApprovalEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

export function createCapabilityApprover(
  queue: CapabilityApprovalQueue
): (request: CapabilityApprovalRequest) => Promise<boolean> {
  return request => queue.request(request);
}
