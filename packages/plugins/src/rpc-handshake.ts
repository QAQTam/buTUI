import type {
  WorkerRpcEndpoint,
  WorkerRpcEndpointEvent,
  WorkerRpcHello,
  WorkerRpcMessage,
} from "./worker-rpc.ts";

export interface RpcHandshakeInfo {
  protocol: string;
  version: number;
  capabilities: readonly string[];
}

export interface RpcHandshakeOptions extends RpcHandshakeInfo {
  /** 对端必须声明的协议能力；缺失即握手失败。 */
  requiredCapabilities?: readonly string[];
  /** 默认 5s；超时后握手和该 transport 一起 fail closed。 */
  timeoutMs?: number;
  dispose?(): void | Promise<void>;
}

export interface RpcHandshakeEndpoint extends WorkerRpcEndpoint {
  readonly ready: Promise<RpcHandshakeInfo>;
  readonly peer: RpcHandshakeInfo | undefined;
  dispose(): Promise<void>;
}

/**
 * 给任意 RPC endpoint 增加双向 protocol / version 握手。
 *
 * 双方创建 wrapper 后各自发送 hello；握手完成前，业务消息会排队。协议或版本
 * 不匹配、超时、底层 transport error 都会 fail-fast，不会静默按旧协议继续。
 */
export function withRpcHandshake(
  target: WorkerRpcEndpoint,
  options: RpcHandshakeOptions
): RpcHandshakeEndpoint {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const capabilities = Object.freeze([...options.capabilities]);
  const listeners = new Map<
    WorkerRpcEndpointEvent,
    Set<(event: Event) => void>
  >();
  const outbound: WorkerRpcMessage[] = [];
  const inbound: WorkerRpcMessage[] = [];
  let peer: RpcHandshakeInfo | undefined;
  let settled = false;
  let failed = false;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: (value: RpcHandshakeInfo) => void;
  let rejectReady!: (error: Error) => void;

  const ready = new Promise<RpcHandshakeInfo>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});

  const clearHandshakeTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const dispatch = (type: WorkerRpcEndpointEvent, event: Event): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      try {
        listener(event);
      } catch {
        // listener 不能反向破坏握手状态。
      }
    }
  };

  const fail = (
    error: Error,
    type: "error" | "messageerror" = "error"
  ): void => {
    if (failed || disposed) return;
    failed = true;
    clearHandshakeTimer();
    outbound.length = 0;
    inbound.length = 0;
    rejectReady(error);
    dispatch(type, {
      type,
      error,
      message: error.message,
    } as ErrorEvent);
  };

  const send = (message: WorkerRpcMessage): void => {
    try {
      target.postMessage(message);
    } catch (error) {
      const normalized = asError(error);
      fail(normalized);
      throw normalized;
    }
  };

  const settle = (message: WorkerRpcHello): void => {
    if (failed || disposed) return;
    if (settled) {
      if (!sameHandshake(peer, message)) {
        fail(
          new Error(
            `[butui] RPC handshake changed after settlement: ${message.protocol}@${message.version}`
          ),
          "messageerror"
        );
      }
      return;
    }

    peer = {
      protocol: message.protocol,
      version: message.version,
      capabilities: Object.freeze([...message.capabilities]),
    };
    settled = true;
    clearHandshakeTimer();
    resolveReady(peer);

    const queuedInbound = inbound.splice(0);
    for (const value of queuedInbound) {
      dispatch("message", { data: value } as MessageEvent);
    }
    const queuedOutbound = outbound.splice(0);
    for (const value of queuedOutbound) send(value);
  };

  const onMessage = (event: Event): void => {
    if (failed || disposed) return;
    const value = (event as MessageEvent).data;
    if (isWorkerRpcHello(value)) {
      const mismatch = handshakeMismatch(options, value);
      if (mismatch) {
        fail(mismatch, "messageerror");
        return;
      }
      settle(value);
      return;
    }
    if (!settled) {
      inbound.push(value as WorkerRpcMessage);
      return;
    }
    dispatch("message", { data: value } as MessageEvent);
  };

  const onFailure = (event: Event): void => {
    const source = event as { error?: unknown; message?: unknown };
    const message =
      source.error instanceof Error
        ? source.error.message
        : typeof source.message === "string" && source.message
          ? source.message
          : event.type === "messageerror"
            ? "RPC message could not be deserialized"
            : "RPC transport failed";
    fail(
      new Error(`[butui] RPC handshake transport failed: ${message}`),
      event.type === "messageerror" ? "messageerror" : "error"
    );
  };

  target.addEventListener("message", onMessage);
  target.addEventListener("error", onFailure);
  target.addEventListener("messageerror", onFailure);
  timer = setTimeout(() => {
    fail(
      new Error(
        `[butui] RPC handshake timeout: ${options.protocol}@${options.version}`
      )
    );
  }, timeoutMs);

  send({
    type: "hello",
    protocol: options.protocol,
    version: options.version,
    capabilities,
  });

  return {
    addEventListener(type, listener) {
      let entries = listeners.get(type);
      if (!entries) {
        entries = new Set();
        listeners.set(type, entries);
      }
      entries.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage(message) {
      if (disposed) {
        throw new Error("[butui] RPC handshake endpoint 已关闭");
      }
      if (failed) {
        throw new Error("[butui] RPC handshake endpoint 已失败");
      }
      if (message.type === "hello") {
        send(message);
        return;
      }
      if (settled) send(message);
      else outbound.push(message);
    },
    get ready() {
      return ready;
    },
    get peer() {
      return peer;
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      clearHandshakeTimer();
      target.removeEventListener("message", onMessage);
      target.removeEventListener("error", onFailure);
      target.removeEventListener("messageerror", onFailure);
      outbound.length = 0;
      inbound.length = 0;
      if (!settled && !failed) {
        rejectReady(new Error("[butui] RPC handshake endpoint 已关闭"));
      }
      disposePromise = (async () => {
        const close =
          options.dispose ??
          (target as WorkerRpcEndpoint & {
            dispose?: () => void | Promise<void>;
          }).dispose;
        await close?.call(target);
      })();
      return disposePromise;
    },
  };
}

function handshakeMismatch(
  local: RpcHandshakeOptions,
  remote: WorkerRpcHello
): Error | undefined {
  if (remote.protocol !== local.protocol) {
    return new Error(
      `[butui] RPC protocol mismatch: local=${local.protocol} remote=${remote.protocol}`
    );
  }
  if (remote.version !== local.version) {
    return new Error(
      `[butui] RPC protocol version mismatch: local=${local.version} remote=${remote.version}`
    );
  }
  if (
    !Array.isArray(remote.capabilities) ||
    !remote.capabilities.every(value => typeof value === "string")
  ) {
    return new Error("[butui] RPC handshake capabilities must be strings");
  }
  const missing = (local.requiredCapabilities ?? []).filter(
    capability => !remote.capabilities.includes(capability)
  );
  if (missing.length > 0) {
    return new Error(
      `[butui] RPC handshake missing capabilities: ${missing.join(", ")}`
    );
  }
  return undefined;
}

function sameHandshake(
  local: RpcHandshakeInfo | undefined,
  remote: WorkerRpcHello
): boolean {
  if (!local) return false;
  if (
    local.protocol !== remote.protocol ||
    local.version !== remote.version ||
    local.capabilities.length !== remote.capabilities.length
  ) {
    return false;
  }
  return local.capabilities.every(
    (capability, index) => capability === remote.capabilities[index]
  );
}

function isWorkerRpcHello(value: unknown): value is WorkerRpcHello {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "hello" &&
    typeof (value as { protocol?: unknown }).protocol === "string" &&
    typeof (value as { version?: unknown }).version === "number" &&
    Array.isArray((value as { capabilities?: unknown }).capabilities)
  );
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 5_000;
  return Math.max(0, Math.floor(value));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
