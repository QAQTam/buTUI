import { createWorkerRpc } from "./worker-rpc.ts";
import type {
  WorkerRpcEndpoint,
  WorkerRpcHost,
} from "./worker-rpc.ts";

export type WorkerSupervisorState =
  | "running"
  | "restarting"
  | "failed"
  | "stopped";

export type WorkerSupervisorRestartReason = "failure" | "manual";

export type WorkerSupervisorEvent =
  | { type: "started"; generation: number }
  | {
      type: "restarting";
      generation: number;
      reason: WorkerSupervisorRestartReason;
      attempt: number;
      error?: Error;
    }
  | {
      type: "restarted";
      generation: number;
      reason: WorkerSupervisorRestartReason;
    }
  | {
      type: "failed";
      generation: number;
      error: Error;
      restarts: number;
    }
  | { type: "stopped"; generation: number };

export interface WorkerSupervisorOptions<
  T extends WorkerRpcEndpoint = WorkerRpcEndpoint,
> {
  create(): T;
  /** 每次创建新 target 后调用；返回的 cleanup 在 restart / dispose 前执行。 */
  setup?(target: T): void | (() => void);
  /** 默认尝试 target.terminate() 或 target.close()。 */
  terminate?(target: T): void | Promise<void>;
  timeoutMs?: number;
  /** 自动重启预算；默认 3，手动 restart 会重置。 */
  maxRestarts?: number;
  /** 自动重启前等待；默认 0。 */
  restartDelayMs?: number;
  onEvent?: (event: WorkerSupervisorEvent) => void;
}

export interface WorkerSupervisor<
  T extends WorkerRpcEndpoint = WorkerRpcEndpoint,
> {
  readonly state: WorkerSupervisorState;
  readonly generation: number;
  /** 已消耗的自动重启次数；不包含手动 restart。 */
  readonly restarts: number;
  readonly target: T | undefined;
  call<TResult = unknown>(
    method: string,
    ...args: readonly unknown[]
  ): Promise<TResult>;
  ready(): Promise<void>;
  restart(): Promise<void>;
  onEvent(listener: (event: WorkerSupervisorEvent) => void): () => void;
  dispose(): Promise<void>;
}

/**
 * 单 worker supervisor。
 *
 * RPC 通道失败后按预算自动重建，并在每次重建时重新执行 setup。调用在重启期间
 * 等待新 generation，不自动重放已经失败的调用，避免非幂等操作被重复执行。
 */
export function createWorkerSupervisor<
  T extends WorkerRpcEndpoint = WorkerRpcEndpoint,
>(options: WorkerSupervisorOptions<T>): WorkerSupervisor<T> {
  const maxRestarts = normalizeCount(options.maxRestarts, 3);
  const restartDelayMs = normalizeCount(options.restartDelayMs, 0);
  const listeners = new Set<(event: WorkerSupervisorEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);

  let state: WorkerSupervisorState = "running";
  let generation = 0;
  let automaticRestarts = 0;
  let target: T | undefined;
  let rpc: WorkerRpcHost | undefined;
  let cleanup: (() => void) | undefined;
  let restartPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  let delayTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseDelay: (() => void) | undefined;
  let disposed = false;
  let lastError: Error | undefined;

  const emit = (event: WorkerSupervisorEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 生命周期 listener 不能破坏 supervisor 状态机。
      }
    }
  };

  const attach = (reason: WorkerSupervisorRestartReason): void => {
    const nextTarget = options.create();
    const nextGeneration = ++generation;
    let nextCleanup: (() => void) | undefined;
    try {
      const setupResult = options.setup?.(nextTarget);
      nextCleanup =
        typeof setupResult === "function" ? setupResult : undefined;
      let nextRpc: WorkerRpcHost | undefined;
      nextRpc = createWorkerRpc(nextTarget, {
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
        onFailure: error => {
          if (nextRpc) handleFailure(nextRpc, error);
        },
      });
      target = nextTarget;
      rpc = nextRpc;
      cleanup = nextCleanup;
      state = "running";
      lastError = undefined;
      emit(
        nextGeneration === 1
          ? { type: "started", generation: nextGeneration }
          : { type: "restarted", generation: nextGeneration, reason }
      );
    } catch (error) {
      try {
        nextCleanup?.();
      } finally {
        void terminateTarget(nextTarget).catch(() => {});
      }
      throw asError(error);
    }
  };

  const teardown = async (): Promise<void> => {
    const oldRpc = rpc;
    const oldCleanup = cleanup;
    const oldTarget = target;
    rpc = undefined;
    cleanup = undefined;
    target = undefined;

    oldRpc?.dispose();
    try {
      oldCleanup?.();
    } finally {
      await terminateTarget(oldTarget);
    }
  };

  const terminateTarget = async (value: T | undefined): Promise<void> => {
    if (!value) return;
    if (options.terminate) {
      await options.terminate(value);
      return;
    }
    const fallback = value as T & {
      terminate?: () => unknown;
      close?: () => unknown;
    };
    if (typeof fallback.terminate === "function") {
      await fallback.terminate();
      return;
    }
    if (typeof fallback.close === "function") {
      await fallback.close();
    }
  };

  const waitForRestart = async (): Promise<void> => {
    if (restartDelayMs === 0) return;
    await new Promise<void>(resolve => {
      releaseDelay = resolve;
      delayTimer = setTimeout(() => {
        delayTimer = undefined;
        releaseDelay = undefined;
        resolve();
      }, restartDelayMs);
    });
  };

  const cancelRestartDelay = (): void => {
    if (delayTimer) clearTimeout(delayTimer);
    delayTimer = undefined;
    const release = releaseDelay;
    releaseDelay = undefined;
    release?.();
  };

  const failSupervisor = (error: Error): void => {
    lastError = error;
    state = "failed";
    emit({
      type: "failed",
      generation,
      error,
      restarts: automaticRestarts,
    });
  };

  const performRestart = async (
    reason: WorkerSupervisorRestartReason
  ): Promise<void> => {
    try {
      if (reason === "failure") await waitForRestart();
      if (disposed) return;
      await teardown();
      if (disposed) return;
      attach(reason);
    } catch (restartError) {
      const error = asError(restartError);
      failSupervisor(error);
      throw error;
    }
  };

  const scheduleRestart = (
    reason: WorkerSupervisorRestartReason,
    attempt: number,
    error?: Error
  ): Promise<void> => {
    state = "restarting";
    emit({
      type: "restarting",
      generation,
      reason,
      attempt,
      ...(error ? { error } : {}),
    });
    const promise = performRestart(reason).finally(() => {
      if (restartPromise === promise) restartPromise = undefined;
    });
    restartPromise = promise;
    return promise;
  };

  const handleFailure = (source: WorkerRpcHost, error: Error): void => {
    if (
      rpc !== source ||
      disposed ||
      state === "failed" ||
      state === "stopped"
    ) {
      return;
    }
    lastError = error;
    if (automaticRestarts >= maxRestarts) {
      failSupervisor(error);
      return;
    }
    const attempt = ++automaticRestarts;
    void scheduleRestart("failure", attempt, error).catch(() => {});
  };

  const requireRpc = (): WorkerRpcHost => {
    if (disposed) {
      throw new Error("[butui] worker supervisor 已关闭");
    }
    if (state === "failed") {
      throw lastError ?? new Error("[butui] worker supervisor 已失败");
    }
    if (!rpc) {
      throw new Error("[butui] worker supervisor 没有可用 worker");
    }
    return rpc;
  };

  try {
    attach("manual");
  } catch (error) {
    state = "failed";
    lastError = asError(error);
    throw error;
  }

  return {
    get state() {
      return state;
    },
    get generation() {
      return generation;
    },
    get restarts() {
      return automaticRestarts;
    },
    get target() {
      return target;
    },
    async call<TResult = unknown>(
      method: string,
      ...args: readonly unknown[]
    ): Promise<TResult> {
      if (restartPromise) await restartPromise;
      return requireRpc().call<TResult>(method, ...args);
    },
    async ready(): Promise<void> {
      if (restartPromise) await restartPromise;
      requireRpc();
    },
    async restart(): Promise<void> {
      if (disposed) {
        throw new Error("[butui] worker supervisor 已关闭");
      }
      if (restartPromise) return restartPromise;
      automaticRestarts = 0;
      cancelRestartDelay();
      return scheduleRestart("manual", 0);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      state = "stopped";
      cancelRestartDelay();
      disposePromise = (async () => {
        try {
          if (restartPromise) {
            try {
              await restartPromise;
            } catch {
              // restart 已进入 failed；dispose 仍必须清理当前 target。
            }
          }
          await teardown();
        } finally {
          emit({ type: "stopped", generation });
          listeners.clear();
        }
      })();
      return disposePromise;
    },
  };
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
