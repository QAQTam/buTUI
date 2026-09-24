import { serveWorkerRpc } from "./worker-rpc.ts";
import type {
  WorkerRpcEndpoint,
  WorkerRpcEndpointEvent,
  WorkerRpcHandlers,
  WorkerRpcMessage,
} from "./worker-rpc.ts";

export interface NdjsonRpcOutput {
  write(chunk: string | Uint8Array): unknown;
  flush?(): unknown;
}

export type NdjsonRpcInput =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface NdjsonRpcEndpointOptions {
  input: NdjsonRpcInput;
  output: NdjsonRpcOutput;
  /** 超过该长度的单行会被视为协议错误；默认 8 MiB。 */
  maxFrameBytes?: number;
  close?(): void | Promise<void>;
}

export interface NdjsonRpcEndpoint extends WorkerRpcEndpoint {
  readonly closed: boolean;
  dispose(): Promise<void>;
}

export interface ProcessRpcSubprocess {
  readonly stdin: NdjsonRpcOutput | undefined;
  readonly stdout: ReadableStream<Uint8Array> | undefined;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface ProcessStdioRpcOptions {
  input?: NdjsonRpcInput;
  output?: NdjsonRpcOutput;
  maxFrameBytes?: number;
  close?(): void | Promise<void>;
}

/**
 * 基于 NDJSON 的 endpoint。
 *
 * 一行一个 WorkerRpcMessage；适合 process / socket / test pipe。JSON 无法表达
 * `undefined`、BigInt、函数、循环引用等 structured-clone 值，跨进程协议应保持
 * 为普通 JSON 数据。
 */
export function createNdjsonRpcEndpoint(
  options: NdjsonRpcEndpointOptions
): NdjsonRpcEndpoint {
  const maxFrameBytes = normalizeFrameLimit(options.maxFrameBytes);
  const listeners = new Map<
    WorkerRpcEndpointEvent,
    Set<(event: Event) => void>
  >();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const dispatch = (type: WorkerRpcEndpointEvent, event: Event): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      try {
        listener(event);
      } catch {
        // transport listener 不应反向破坏读写状态。
      }
    }
  };

  const fail = (error: Error, type: "error" | "messageerror"): void => {
    if (closed || disposed) return;
    closed = true;
    dispatch(type, {
      type,
      error,
      message: error.message,
    } as ErrorEvent);
  };

  const handleLine = (line: string): boolean => {
    if (!line) return true;
    if (line.length > maxFrameBytes) {
      fail(
        new Error(
          `[butui] process RPC frame exceeds ${maxFrameBytes} characters`
        ),
        "messageerror"
      );
      return false;
    }
    try {
      const message = JSON.parse(line) as WorkerRpcMessage;
      dispatch("message", { data: message } as MessageEvent);
      return true;
    } catch (error) {
      fail(asError(error), "messageerror");
      return false;
    }
  };

  const consume = (chunk: Uint8Array): boolean => {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!handleLine(line)) return false;
    }
    if (buffer.length > maxFrameBytes) {
      fail(
        new Error(
          `[butui] process RPC frame exceeds ${maxFrameBytes} characters`
        ),
        "messageerror"
      );
      return false;
    }
    return true;
  };

  const pump = async (): Promise<void> => {
    try {
      if (isReadableStream(options.input)) {
        reader = options.input.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!consume(value)) return;
        }
      } else {
        for await (const chunk of options.input) {
          if (!consume(chunk)) return;
        }
      }
      buffer += decoder.decode();
      if (buffer && !handleLine(buffer.replace(/\r$/, ""))) return;
      if (!disposed) {
        fail(new Error("[butui] process RPC stream closed"), "error");
      }
    } catch (error) {
      if (!disposed) fail(asError(error), "error");
    }
  };

  void pump();

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
      if (disposed || closed) {
        throw new Error("[butui] process RPC endpoint 已关闭");
      }
      const line = JSON.stringify(message);
      if (line.length > maxFrameBytes) {
        throw new Error(
          `[butui] process RPC frame exceeds ${maxFrameBytes} characters`
        );
      }
      const written = options.output.write(`${line}\n`);
      const flushed =
        typeof options.output.flush === "function"
          ? options.output.flush()
          : undefined;
      if (isPromiseLike(written)) {
        void Promise.resolve(written).catch(error =>
          fail(asError(error), "error")
        );
      }
      if (isPromiseLike(flushed)) {
        void Promise.resolve(flushed).catch(error =>
          fail(asError(error), "error")
        );
      }
    },
    get closed() {
      return closed;
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      closed = true;
      disposePromise = (async () => {
        try {
          await reader?.cancel();
        } catch {
          // 输入可能已自然结束。
        }
        await options.close?.();
      })();
      return disposePromise;
    },
  };
}

export function attachProcessRpc(
  subprocess: ProcessRpcSubprocess,
  options: Omit<NdjsonRpcEndpointOptions, "input" | "output" | "close"> = {}
): NdjsonRpcEndpoint {
  if (!subprocess.stdin || !subprocess.stdout) {
    throw new Error(
      "[butui] process RPC requires stdin=pipe and stdout=pipe"
    );
  }
  return createNdjsonRpcEndpoint({
    input: subprocess.stdout,
    output: subprocess.stdin,
    ...options,
    close: async () => {
      try {
        subprocess.kill();
      } catch {
        // 进程可能已退出。
      }
      await subprocess.exited;
    },
  });
}

export function createProcessStdioEndpoint(
  options: ProcessStdioRpcOptions = {}
): NdjsonRpcEndpoint {
  return createNdjsonRpcEndpoint({
    input:
      options.input ??
      (process.stdin as unknown as AsyncIterable<Uint8Array>),
    output: options.output ?? process.stdout,
    ...(options.maxFrameBytes !== undefined
      ? { maxFrameBytes: options.maxFrameBytes }
      : {}),
    ...(options.close ? { close: options.close } : {}),
  });
}

export function serveProcessRpc(
  handlers: WorkerRpcHandlers,
  options: ProcessStdioRpcOptions = {}
): () => Promise<void> {
  const endpoint = createProcessStdioEndpoint(options);
  const cleanup = serveWorkerRpc(handlers, endpoint);
  return async () => {
    cleanup();
    await endpoint.dispose();
  };
}

function normalizeFrameLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 8 * 1024 * 1024;
  return Math.max(1, Math.floor(value));
}

function isReadableStream(
  value: NdjsonRpcInput
): value is ReadableStream<Uint8Array> {
  return typeof (value as ReadableStream<Uint8Array>).getReader === "function";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
