import { describe, expect, test } from "bun:test";
import { createWorkerRpc, serveWorkerRpc } from "@butui/plugins";
import type {
  WorkerRpcEndpoint,
  WorkerRpcMessage,
} from "@butui/plugins";

function worker() {
  return new Worker(new URL("./helpers/worker-rpc-fixture.ts", import.meta.url));
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  let rejected = false;
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    rejection = error;
  }
  if (!rejected) throw new Error("expected promise to reject");
  if (!(rejection instanceof Error)) {
    throw new Error(`expected Error rejection, received ${String(rejection)}`);
  }
  return rejection;
}

class TestEndpoint implements WorkerRpcEndpoint {
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly messages: WorkerRpcMessage[] = [];

  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void
  ): void {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(message: WorkerRpcMessage): void {
    this.messages.push(message);
  }

  emit(data: unknown): void {
    const event = { data } as MessageEvent;
    for (const listener of [...this.listeners]) listener(event);
  }
}

describe("Worker RPC", () => {
  test("call / result / error", async () => {
    const child = worker();
    const rpc = createWorkerRpc(child, { timeoutMs: 1_000 });
    try {
      expect(await rpc.call<{ value: number }>("echo", { value: 1 })).toEqual({
        value: 1,
      });
      expect(await rpc.call<number>("sum", 2, 3)).toBe(5);

      const failure = await captureRejection(rpc.call("fail"));
      expect(failure.message).toContain("worker failed");

      const missing = await captureRejection(rpc.call("missing"));
      expect(missing.message).toContain("method not found");

      const uncloneable = await captureRejection(rpc.call("uncloneable"));
      expect(uncloneable.message.length).toBeGreaterThan(0);

      expect(rpc.pending).toBe(0);
    } finally {
      rpc.dispose();
      child.terminate();
    }
  });

  test("并发请求按 id 独立结算，不依赖完成顺序", async () => {
    const child = worker();
    const rpc = createWorkerRpc(child, { timeoutMs: 1_000 });
    try {
      const slow = rpc.call<number>("delay", 25);
      const fast = rpc.call<number>("delay", 1);
      expect(await Promise.all([slow, fast])).toEqual([25, 1]);
      expect(rpc.pending).toBe(0);
    } finally {
      rpc.dispose();
      child.terminate();
    }
  });

  test("timeout 与 dispose 都会 reject pending", async () => {
    const timed = worker();
    const timedRpc = createWorkerRpc(timed, { timeoutMs: 20 });
    try {
      const error = await captureRejection(timedRpc.call("delay", 100));
      expect(error.message).toContain("worker RPC timeout");
    } finally {
      timedRpc.dispose();
      timed.terminate();
    }

    const disposedWorker = worker();
    const disposedRpc = createWorkerRpc(disposedWorker);
    const pending = disposedRpc.call("delay", 100);
    disposedRpc.dispose();
    const error = await captureRejection(pending);
    expect(error.message).toContain("worker RPC 已关闭");
    disposedWorker.terminate();
  });

  test("host 忽略畸形 response，后续合法 response 仍能结算", async () => {
    const endpoint = new TestEndpoint();
    const rpc = createWorkerRpc(endpoint, { timeoutMs: 100 });
    const pending = rpc.call<number>("value");

    expect(endpoint.messages[0]).toMatchObject({
      type: "call",
      id: 1,
      method: "value",
      args: [],
    });

    endpoint.emit(null);
    endpoint.emit({ type: "error", id: 1, error: null });
    endpoint.emit({ type: "result", id: 1, value: 7 });
    expect(await pending).toBe(7);
    expect(rpc.pending).toBe(0);
    rpc.dispose();
  });

  test("server 拒绝原型方法，并在 cleanup 后停止回包", async () => {
    const endpoint = new TestEndpoint();
    const cleanup = serveWorkerRpc(
      {
        echo(value: unknown) {
          return value;
        },
      },
      endpoint
    );

    endpoint.emit(null);
    endpoint.emit({ type: "call", id: 1, method: "toString", args: [] });
    endpoint.emit({ type: "call", id: 2, method: "echo", args: [42] });
    await Promise.resolve();

    expect(endpoint.messages).toHaveLength(2);
    expect(endpoint.messages[0]).toMatchObject({
      type: "error",
      id: 1,
      error: { message: expect.stringContaining("method not found") },
    });
    expect(endpoint.messages[1]).toEqual({
      type: "result",
      id: 2,
      value: 42,
    });

    cleanup();
    endpoint.emit({ type: "call", id: 3, method: "echo", args: [99] });
    await Promise.resolve();
    expect(endpoint.messages).toHaveLength(2);
  });

  test("server cleanup 后，进行中的异步 handler 不回包", async () => {
    const endpoint = new TestEndpoint();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const cleanup = serveWorkerRpc(
      {
        async wait() {
          await gate;
          return 1;
        },
      },
      endpoint
    );

    endpoint.emit({ type: "call", id: 1, method: "wait", args: [] });
    cleanup();
    release();
    await gate;
    await Promise.resolve();
    expect(endpoint.messages).toEqual([]);
  });
});
