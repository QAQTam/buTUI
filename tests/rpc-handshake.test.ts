import { describe, expect, test } from "bun:test";
import {
  CapabilityBroker,
  attachProcessRpc,
  createWorkerRpc,
  serveWorkerCapabilities,
  serveWorkerRpc,
  withRpcHandshake,
} from "@butui/plugins";
import type {
  WorkerRpcEndpoint,
  WorkerRpcEndpointEvent,
  WorkerRpcMessage,
} from "@butui/plugins";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("./helpers/process-handshake-fixture.ts", import.meta.url)
);

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

class LinkedEndpoint implements WorkerRpcEndpoint {
  peer: LinkedEndpoint | undefined;
  private readonly listeners = new Map<
    WorkerRpcEndpointEvent,
    Set<(event: Event) => void>
  >();

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
    const peer = this.peer;
    if (!peer) throw new Error("linked endpoint has no peer");
    queueMicrotask(() => {
      for (const listener of [...(peer.listeners.get("message") ?? [])]) {
        listener({ data: message } as MessageEvent);
      }
    });
  }
}

function linkedPair(): [LinkedEndpoint, LinkedEndpoint] {
  const left = new LinkedEndpoint();
  const right = new LinkedEndpoint();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

describe("RPC handshake", () => {
  test("双向 hello 完成前排队，完成后透传并暴露 peer capabilities", async () => {
    const [left, right] = linkedPair();
    const host = withRpcHandshake(left, {
      protocol: "butui.plugin",
      version: 1,
      capabilities: ["host"],
      requiredCapabilities: ["render"],
    });
    const worker = withRpcHandshake(right, {
      protocol: "butui.plugin",
      version: 1,
      capabilities: ["render"],
    });
    const rpc = createWorkerRpc(host, { timeoutMs: 1_000 });
    const cleanup = serveWorkerRpc(
      {
        echo(value: unknown) {
          return value;
        },
      },
      worker
    );

    const pending = rpc.call<number>("echo", 42);
    const [hostPeer, workerPeer] = await Promise.all([
      host.ready,
      worker.ready,
    ]);
    expect(hostPeer).toEqual({
      protocol: "butui.plugin",
      version: 1,
      capabilities: ["render"],
    });
    expect(workerPeer).toEqual({
      protocol: "butui.plugin",
      version: 1,
      capabilities: ["host"],
    });
    expect(await pending).toBe(42);

    rpc.dispose();
    cleanup();
    await host.dispose();
    await worker.dispose();
  });

  test("protocol / version 不匹配时双方 fail-fast", async () => {
    const [left, right] = linkedPair();
    const host = withRpcHandshake(left, {
      protocol: "butui.plugin",
      version: 1,
      capabilities: [],
    });
    const worker = withRpcHandshake(right, {
      protocol: "butui.plugin",
      version: 2,
      capabilities: [],
    });

    const [hostError, workerError] = await Promise.all([
      captureRejection(host.ready),
      captureRejection(worker.ready),
    ]);
    expect(hostError.message).toContain("version mismatch");
    expect(workerError.message).toContain("version mismatch");

    await host.dispose();
    await worker.dispose();
  });

  test("缺少 required capability 时 fail-fast", async () => {
    const [left, right] = linkedPair();
    const host = withRpcHandshake(left, {
      protocol: "butui.plugin",
      version: 1,
      capabilities: [],
      requiredCapabilities: ["worker-events"],
    });
    const worker = withRpcHandshake(right, {
      protocol: "butui.plugin",
      version: 1,
      capabilities: ["render"],
    });

    expect((await captureRejection(host.ready)).message).toContain(
      "missing capabilities: worker-events"
    );
    await host.dispose();
    await worker.dispose();
  });

  test("没有 peer hello 时按 timeout fail-fast", async () => {
    const endpoint = new LinkedEndpoint();
    endpoint.peer = new LinkedEndpoint();
    const handshake = withRpcHandshake(endpoint, {
      protocol: "butui.plugin",
      version: 1,
      capabilities: [],
      timeoutMs: 10,
    });

    expect((await captureRejection(handshake.ready)).message).toContain(
      "handshake timeout"
    );
    await handshake.dispose();
  });

  test("process transport 上可组合握手、RPC 与 capability proxy", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "--conditions=browser", FIXTURE],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const endpoint = withRpcHandshake(attachProcessRpc(child), {
      protocol: "butui.plugin",
      version: 1,
      capabilities: ["host-callbacks"],
      requiredCapabilities: ["host-callbacks"],
      timeoutMs: 3_000,
    });
    const broker = new CapabilityBroker();
    broker.grant("process-plugin", "fs:read");
    const cleanup = serveWorkerCapabilities(endpoint, {
      pluginId: "process-plugin",
      broker,
      bindings: {
        readFile: {
          capability: "fs:read",
          handler(path: string) {
            return `read:${path}`;
          },
        },
      },
    });
    const rpc = createWorkerRpc(endpoint, { timeoutMs: 3_000 });

    try {
      expect(await rpc.call<number>("sum", 7, 8)).toBe(15);
      expect(await rpc.call<string>("readViaHost", "a.txt")).toBe("read:a.txt");
      expect(endpoint.peer).toEqual({
        protocol: "butui.plugin",
        version: 1,
        capabilities: ["host-callbacks"],
      });
    } finally {
      rpc.dispose();
      cleanup();
      broker.dispose();
      await endpoint.dispose();
      await child.exited;
    }
  });
});
