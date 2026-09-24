import { createSignal } from "solid-js";

export type ToastTone =
  | "default"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "muted";

export type ToastState = "visible" | "dismissed" | "expired";

export type ToastDismissReason =
  | "manual"
  | "timeout"
  | "overflow"
  | "clear"
  | "dispose";

export interface ToastAction {
  id: string;
  label: string;
}

export interface ToastInput {
  title: string;
  message?: string;
  tone?: ToastTone;
  /** 毫秒；null / 0 表示不自动消失。 */
  durationMs?: number | null;
  dismissible?: boolean;
  /** 相同 key 的可见 toast 会合并并增加 count。 */
  dedupeKey?: string;
  actions?: readonly ToastAction[];
  data?: unknown;
}

export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  tone: ToastTone;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  count: number;
  dismissible: boolean;
  actions: readonly ToastAction[];
  dedupeKey?: string;
  data?: unknown;
  state: ToastState;
}

export type ToastEvent =
  | { type: "added"; item: ToastItem }
  | { type: "updated"; item: ToastItem }
  | {
      type: "dismissed";
      item: ToastItem;
      reason: ToastDismissReason;
    };

export interface ToastQueueOptions {
  now?: () => number;
  setTimeout?: (
    callback: () => void,
    delay: number
  ) => ReturnType<typeof setTimeout> | number;
  clearTimeout?: (handle: ReturnType<typeof setTimeout> | number) => void;
  /** 同时可见上限，默认 3。 */
  maxVisible?: number;
  /** 默认 TTL，默认 5s。 */
  defaultDurationMs?: number;
}

export interface ToastQueue {
  push(input: ToastInput): ToastItem;
  dismiss(id: string, reason?: ToastDismissReason): boolean;
  pause(id: string): boolean;
  resume(id: string): boolean;
  clear(reason?: ToastDismissReason): void;
  visible(): readonly ToastItem[];
  all(): readonly ToastItem[];
  onEvent(listener: (event: ToastEvent) => void): () => void;
  dispose(): void;
}

interface MutableToast extends ToastItem {
  order: number;
  remainingMs?: number;
}

export function createToastQueue(
  options: ToastQueueOptions = {}
): ToastQueue {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const maxVisible = Math.max(1, Math.floor(options.maxVisible ?? 3));
  const defaultDurationMs = Math.max(
    0,
    Math.floor(options.defaultDurationMs ?? 5_000)
  );
  const [revision, bumpRevision] = createSignal(0);
  const items = new Map<string, MutableToast>();
  const timers = new Map<
    string,
    ReturnType<typeof setTimeout> | number
  >();
  const listeners = new Set<(event: ToastEvent) => void>();
  let nextId = 1;
  let disposed = false;

  const emit = (event: ToastEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  const snapshot = (item: MutableToast): ToastItem => {
    const {
      order: _order,
      remainingMs: _remainingMs,
      ...toast
    } = item;
    return toast;
  };

  const active = (): MutableToast[] => {
    revision();
    return [...items.values()].filter(item => item.state === "visible");
  };

  const clearItemTimer = (id: string): void => {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimer(timer);
    timers.delete(id);
  };

  const schedule = (item: MutableToast, durationMs: number): void => {
    clearItemTimer(item.id);
    if (durationMs <= 0) {
      item.expiresAt = undefined;
      item.remainingMs = undefined;
      return;
    }
    item.remainingMs = durationMs;
    item.expiresAt = now() + durationMs;
    const timer = setTimer(() => dismiss(item.id, "timeout"), durationMs);
    timers.set(item.id, timer);
  };

  const dismiss = (
    id: string,
    reason: ToastDismissReason = "manual"
  ): boolean => {
    const item = items.get(id);
    if (!item || item.state !== "visible") return false;
    clearItemTimer(id);
    item.state = reason === "timeout" ? "expired" : "dismissed";
    item.updatedAt = now();
    item.expiresAt = undefined;
    item.remainingMs = undefined;
    bumpRevision(value => value + 1);
    emit({ type: "dismissed", item: snapshot(item), reason });
    return true;
  };

  const push = (input: ToastInput): ToastItem => {
    if (disposed) throw new Error("[butui] toast queue 已关闭");
    const title = input.title.trim();
    if (!title) throw new Error("[butui] toast title 不能为空");
    const timestamp = now();
    const duration =
      input.durationMs === undefined
        ? defaultDurationMs
        : input.durationMs === null
          ? 0
          : Math.max(0, Math.floor(input.durationMs));
    const existing = input.dedupeKey
      ? active().find(item => item.dedupeKey === input.dedupeKey)
      : undefined;
    if (existing) {
      existing.title = title;
      existing.message = input.message;
      existing.tone = input.tone ?? existing.tone;
      existing.dismissible = input.dismissible ?? existing.dismissible;
      existing.actions = [...(input.actions ?? existing.actions)];
      existing.data = input.data ?? existing.data;
      existing.count++;
      existing.updatedAt = timestamp;
      schedule(existing, duration);
      bumpRevision(value => value + 1);
      const item = snapshot(existing);
      emit({ type: "updated", item });
      return item;
    }

    const order = nextId++;
    const item: MutableToast = {
      id: `toast-${order}`,
      order,
      title,
      ...(input.message !== undefined ? { message: input.message } : {}),
      tone: input.tone ?? "default",
      createdAt: timestamp,
      updatedAt: timestamp,
      count: 1,
      dismissible: input.dismissible ?? true,
      actions: [...(input.actions ?? [])],
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.dedupeKey !== undefined
        ? { dedupeKey: input.dedupeKey }
        : {}),
      state: "visible",
    } as MutableToast;
    items.set(item.id, item);
    schedule(item, duration);

    const visible = [...items.values()].filter(value => value.state === "visible");
    if (visible.length > maxVisible) {
      const oldest = visible
        .filter(value => value.id !== item.id)
        .sort((left, right) => left.order - right.order)[0];
      if (oldest) dismiss(oldest.id, "overflow");
    }

    bumpRevision(value => value + 1);
    const result = snapshot(item);
    emit({ type: "added", item: result });
    return result;
  };

  const pause = (id: string): boolean => {
    const item = items.get(id);
    if (!item || item.state !== "visible" || item.remainingMs === undefined) {
      return false;
    }
    clearItemTimer(id);
    item.remainingMs = Math.max(0, (item.expiresAt ?? now()) - now());
    item.expiresAt = undefined;
    bumpRevision(value => value + 1);
    return true;
  };

  const resume = (id: string): boolean => {
    const item = items.get(id);
    if (
      !item ||
      item.state !== "visible" ||
      item.remainingMs === undefined ||
      item.remainingMs <= 0
    ) {
      return false;
    }
    schedule(item, item.remainingMs);
    bumpRevision(value => value + 1);
    return true;
  };

  const clear = (reason: ToastDismissReason = "clear"): void => {
    for (const item of [...items.values()]) {
      if (item.state === "visible") dismiss(item.id, reason);
    }
  };

  return {
    push,
    dismiss,
    pause,
    resume,
    clear,
    visible() {
      return active()
        .sort((left, right) => right.order - left.order)
        .map(snapshot);
    },
    all() {
      revision();
      return [...items.values()].map(snapshot);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear("dispose");
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      listeners.clear();
    },
  };
}
