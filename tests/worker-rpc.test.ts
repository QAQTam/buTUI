import { describe, expect, test } from "bun:test";
import {
  CapabilityBroker,
  createWorkerRpc,
  serveWorkerCapabilities,
  serveWorkerRpc,
} from "@butui/plugins";
import type {
  WorkerCapabilityDeniedEvent,
  WorkerRpcEndpoint,
  WorkerRpcEndpointEvent,
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
  private readonly listeners = new Map<
    WorkerRpcEndpointEvent,
    Set<(event: Event) => void>
  >();
  readonly messages: WorkerRpcMessage[] = [];

  addEventListener(
    type: WorkerRpcEndpointEvent,
    listener: (event: Event) => void
  ): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(
    type: WorkerRpcEndpointEvent,
    listener: (event: Event) => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: WorkerRpcMessage): void {
    this.messages.push(message);
  }

  emit(data: unknown): void {
    this.emitEvent("message", { data } as MessageEvent);
  }

  emitEvent(type: WorkerRpcEndpointEvent, event: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
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

  test("capability proxy 允许授权调用，revoke 后立即拒绝", async () => {
    const child = worker();
    const broker = new CapabilityBroker();
    const lease = broker.grant("worker-plugin", "fs:read");
    const denied: WorkerCapabilityDeniedEvent[] = [];
    let reads = 0;
    const cleanup = serveWorkerCapabilities(child, {
      pluginId: "worker-plugin",
      broker,
      bindings: {
        readFile: {
          capability: "fs:read",
          handler(path: string) {
            reads++;
            return `read:${path}`;
          },
        },
      },
      onDenied(event) {
        denied.push(event);
      },
    });
    const rpc = createWorkerRpc(child, { timeoutMs: 1_000 });

    try {
      expect(await rpc.call<string>("readViaHost", "a.txt")).toBe("read:a.txt");
      expect(reads).toBe(1);

      broker.revoke(lease, "test");
      const failure = await captureRejection(
        rpc.call("readViaHost", "b.txt")
      );
      expect(failure.message).toContain("worker capability denied");
      expect(reads).toBe(1);
      expect(denied).toEqual([
        {
          pluginId: "worker-plugin",
          method: "readFile",
          capability: "fs:read",
          args: ["b.txt"],
        },
      ]);
    } finally {
      rpc.dispose();
      cleanup();
      broker.dispose();
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

  test("worker error / messageerror 会 fail-fast 并封禁后续调用", async () => {
    for (const type of ["error", "messageerror"] as const) {
      const endpoint = new TestEndpoint();
      const rpc = createWorkerRpc(endpoint, { timeoutMs: 1_000 });
      const rejected = captureRejection(rpc.call("never"));

      endpoint.emitEvent(type, {
        type,
        error: new Error("worker crashed"),
        message: "worker crashed",
      } as ErrorEvent);

      const failure = await rejected;
      expect(failure.message).toContain("worker RPC failed: worker crashed");
      expect(rpc.pending).toBe(0);

      const afterFailure = await captureRejection(rpc.call("again"));
      expect(afterFailure).toBe(failure);
      expect(endpoint.messages).toHaveLength(1);
      rpc.dispose();
    }
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
