export interface WorkerRpcRequest {
  type: "call";
  id: number;
  method: string;
  args: readonly unknown[];
}

export interface WorkerRpcResult {
  type: "result";
  id: number;
  value: unknown;
}

export interface WorkerRpcError {
  type: "error";
  id: number;
  error: {
    message: string;
    stack?: string;
  };
}

export interface WorkerRpcHello {
  type: "hello";
  protocol: string;
  version: number;
  capabilities: readonly string[];
}

export type WorkerRpcMessage =
  | WorkerRpcRequest
  | WorkerRpcResult
  | WorkerRpcError
  | WorkerRpcHello;

export interface WorkerRpcOptions {
  /** 单次调用超时；不传表示无限等待。 */
  timeoutMs?: number;
  /** worker error / messageerror 导致整个 RPC 通道失败时调用一次。 */
  onFailure?: (error: Error) => void;
}

export interface WorkerRpcHost {
  call<T = unknown>(method: string, ...args: readonly unknown[]): Promise<T>;
  readonly pending: number;
  readonly failure: Error | undefined;
  dispose(): void;
}

export type WorkerRpcEndpointEvent = "message" | "error" | "messageerror";

export interface WorkerRpcEndpoint {
  addEventListener(
    type: WorkerRpcEndpointEvent,
    listener: (event: Event) => void
  ): void;
  removeEventListener(
    type: WorkerRpcEndpointEvent,
    listener: (event: Event) => void
  ): void;
  postMessage(message: WorkerRpcMessage): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Host 侧 RPC 客户端。
 *
 * 消息使用 structured clone，不传递函数、class instance、socket 等不可克隆值。
 * Worker 只提供崩溃 / 堆隔离，不是安全沙箱；capability 必须在协议层单独代理。
 */
export function createWorkerRpc(
  target: WorkerRpcEndpoint,
  options: WorkerRpcOptions = {}
): WorkerRpcHost {
  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let disposed = false;
  let failure: Error | undefined;

  const onMessage = (event: Event): void => {
    const message = (event as MessageEvent).data;
    if (!isWorkerRpcResult(message) && !isWorkerRpcError(message)) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (call.timer) clearTimeout(call.timer);
    if (message.type === "result") call.resolve(message.value);
    else call.reject(errorFromMessage(message.error));
  };

  const onFailure = (event: Event): void => {
    if (disposed || failure) return;
    failWorker(
      errorFromEvent(
        event,
        event.type === "messageerror"
          ? "worker message could not be deserialized"
          : "worker failed"
      )
    );
  };

  const failWorker = (error: Error): void => {
    failure = error;
    target.removeEventListener("message", onMessage);
    target.removeEventListener("error", onFailure);
    target.removeEventListener("messageerror", onFailure);
    for (const call of pending.values()) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
    try {
      options.onFailure?.(error);
    } catch {
      // 生命周期回调不能改变 RPC 已经进入 failed 的事实。
    }
  };

  target.addEventListener("message", onMessage);
  target.addEventListener("error", onFailure);
  target.addEventListener("messageerror", onFailure);

  return {
    call<T = unknown>(
      method: string,
      ...args: readonly unknown[]
    ): Promise<T> {
      if (disposed) {
        return Promise.reject(new Error("[butui] worker RPC 已关闭"));
      }
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const entry: PendingCall = {
          resolve: value => resolve(value as T),
          reject,
        };
        if (options.timeoutMs !== undefined) {
          entry.timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`[butui] worker RPC timeout: ${method}`));
          }, Math.max(0, options.timeoutMs));
        }
        pending.set(id, entry);
        try {
          target.postMessage({ type: "call", id, method, args });
        } catch (error) {
          pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          reject(asError(error));
        }
      });
    },
    get pending() {
      return pending.size;
    },
    get failure() {
      return failure;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      target.removeEventListener("message", onMessage);
      target.removeEventListener("error", onFailure);
      target.removeEventListener("messageerror", onFailure);
      for (const call of pending.values()) {
        if (call.timer) clearTimeout(call.timer);
        call.reject(new Error("[butui] worker RPC 已关闭"));
      }
      pending.clear();
    },
  };
}

export type WorkerRpcHandlers = Record<
  string,
  (...args: any[]) => unknown | Promise<unknown>
>;

/**
 * Worker 侧 RPC handler。
 *
 * 只允许显式注册的 own function，避免 `toString` / `__proto__` 等原型链方法
 * 被当成远程入口。cleanup 后，已经在执行的 handler 也不会再回包。
 */
export function serveWorkerRpc(
  handlers: WorkerRpcHandlers,
  target: WorkerRpcEndpoint = globalThis as unknown as WorkerRpcEndpoint
): () => void {
  let active = true;

  const onMessage = async (event: Event): Promise<void> => {
    const message = (event as MessageEvent).data;
    if (!isWorkerRpcRequest(message)) return;
    try {
      const handler = getHandler(handlers, message.method);
      if (!handler) {
        throw new Error(`[butui] worker RPC method not found: ${message.method}`);
      }
      const value = await handler(...message.args);
      if (!active) return;
      try {
        target.postMessage({ type: "result", id: message.id, value });
      } catch (error) {
        postError(target, message.id, error);
      }
    } catch (error) {
      if (active) postError(target, message.id, error);
    }
  };

  target.addEventListener("message", onMessage);
  return () => {
    if (!active) return;
    active = false;
    target.removeEventListener("message", onMessage);
  };
}

function getHandler(
  handlers: WorkerRpcHandlers,
  method: string
): WorkerRpcHandlers[string] | undefined {
  if (!Object.prototype.hasOwnProperty.call(handlers, method)) return undefined;
  const handler = handlers[method];
  return typeof handler === "function" ? handler : undefined;
}

function postError(
  target: WorkerRpcEndpoint,
  id: number,
  value: unknown
): void {
  const error = asError(value);
  try {
    target.postMessage({
      type: "error",
      id,
      error: {
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      },
    });
  } catch {
    // 没有第二个错误通道；不可克隆的错误无法再报告给调用方。
  }
}

function isWorkerRpcRequest(value: unknown): value is WorkerRpcRequest {
  return (
    isRecord(value) &&
    value.type === "call" &&
    isMessageId(value.id) &&
    typeof value.method === "string" &&
    Array.isArray(value.args)
  );
}

function isWorkerRpcResult(value: unknown): value is WorkerRpcResult {
  return (
    isRecord(value) &&
    value.type === "result" &&
    isMessageId(value.id) &&
    "value" in value
  );
}

function isWorkerRpcError(value: unknown): value is WorkerRpcError {
  return (
    isRecord(value) &&
    value.type === "error" &&
    isMessageId(value.id) &&
    isRecord(value.error) &&
    typeof value.error.message === "string" &&
    (value.error.stack === undefined || typeof value.error.stack === "string")
  );
}

function isMessageId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorFromMessage(error: WorkerRpcError["error"]): Error {
  const value = new Error(error.message);
  if (error.stack) value.stack = error.stack;
  return value;
}

function errorFromEvent(event: Event, fallback: string): Error {
  const source = event as { error?: unknown; message?: unknown };
  if (source.error instanceof Error) {
    const value = new Error(`[butui] worker RPC failed: ${source.error.message}`);
    if (source.error.stack) value.stack = source.error.stack;
    return value;
  }
  const message =
    typeof source.message === "string" && source.message
      ? source.message
      : fallback;
  return new Error(`[butui] worker RPC failed: ${message}`);
}
