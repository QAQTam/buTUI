import { describe, expect, test } from "bun:test";
import {
  CapabilityBroker,
  createPathPrefixAuthorizer,
  createRateLimitAuthorizer,
  serveWorkerCapabilities,
} from "@butui/plugins";
import type {
  WorkerCapabilityDeniedEvent,
  WorkerRpcEndpoint,
  WorkerRpcEndpointEvent,
  WorkerRpcMessage,
} from "@butui/plugins";

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
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
      listener({ data } as MessageEvent);
    }
  }
}

async function settle(): Promise<void> {
  await Bun.sleep(0);
}

describe("capability policies", () => {
  test("path prefix 只允许 root 内路径，越界不执行 handler", async () => {
    const endpoint = new TestEndpoint();
    const broker = new CapabilityBroker();
    broker.grant("plugin", "fs:read");
    const denied: WorkerCapabilityDeniedEvent[] = [];
    let reads = 0;
    const cleanup = serveWorkerCapabilities(endpoint, {
      pluginId: "plugin",
      broker,
      bindings: {
        readFile: {
          capability: "fs:read",
          authorize: createPathPrefixAuthorizer({
            roots: ["allowed"],
            cwd: "/repo",
          }),
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

    endpoint.emit({
      type: "call",
      id: 1,
      method: "readFile",
      args: ["allowed/a.txt"],
    });
    await settle();
    expect(endpoint.messages[0]).toEqual({
      type: "result",
      id: 1,
      value: "read:allowed/a.txt",
    });

    endpoint.emit({
      type: "call",
      id: 2,
      method: "readFile",
      args: ["allowed-evil/a.txt"],
    });
    await settle();
    expect(endpoint.messages[1]).toMatchObject({
      type: "error",
      id: 2,
      error: { message: expect.stringContaining("path outside allowed roots") },
    });
    expect(reads).toBe(1);
    expect(denied).toEqual([
      {
        pluginId: "plugin",
        method: "readFile",
        capability: "fs:read",
        args: ["allowed-evil/a.txt"],
        reason: "policy",
        detail: "path outside allowed roots: /repo/allowed-evil/a.txt",
      },
    ]);

    cleanup();
    broker.dispose();
  });

  test("rate limit 按 plugin + method 限流，窗口后可恢复", async () => {
    const endpoint = new TestEndpoint();
    const broker = new CapabilityBroker();
    broker.grant("plugin", "process");
    let now = 1_000;
    const denied: WorkerCapabilityDeniedEvent[] = [];
    const cleanup = serveWorkerCapabilities(endpoint, {
      pluginId: "plugin",
      broker,
      bindings: {
        tick: {
          capability: "process",
          authorize: createRateLimitAuthorizer({
            limit: 2,
            windowMs: 100,
            now: () => now,
          }),
          handler() {
            return "tick";
          },
        },
      },
      onDenied(event) {
        denied.push(event);
      },
    });

    for (let id = 1; id <= 3; id++) {
      endpoint.emit({ type: "call", id, method: "tick", args: [] });
    }
    await settle();
    expect(endpoint.messages[0]).toMatchObject({ type: "result", id: 1 });
    expect(endpoint.messages[1]).toMatchObject({ type: "result", id: 2 });
    expect(endpoint.messages[2]).toMatchObject({
      type: "error",
      id: 3,
      error: { message: expect.stringContaining("rate limit exceeded") },
    });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      pluginId: "plugin",
      method: "tick",
      capability: "process",
      reason: "policy",
    });

    now += 100;
    endpoint.emit({ type: "call", id: 4, method: "tick", args: [] });
    await settle();
    expect(endpoint.messages[3]).toMatchObject({ type: "result", id: 4 });

    cleanup();
    broker.dispose();
  });

  test("自定义 async authorize 可动态拒绝", async () => {
    const endpoint = new TestEndpoint();
    const broker = new CapabilityBroker();
    broker.grant("plugin", "network");
    const cleanup = serveWorkerCapabilities(endpoint, {
      pluginId: "plugin",
      broker,
      bindings: {
        request: {
          capability: "network",
          async authorize(request) {
            await Bun.sleep(0);
            return request.args[0] === "allowed"
              ? true
              : { allowed: false, reason: "host policy" };
          },
          handler(url: string) {
            return `fetched:${url}`;
          },
        },
      },
    });

    endpoint.emit({
      type: "call",
      id: 1,
      method: "request",
      args: ["denied"],
    });
    endpoint.emit({
      type: "call",
      id: 2,
      method: "request",
      args: ["allowed"],
    });
    await settle();
    expect(endpoint.messages[0]).toMatchObject({
      type: "error",
      id: 1,
      error: { message: expect.stringContaining("host policy") },
    });
    expect(endpoint.messages[1]).toEqual({
      type: "result",
      id: 2,
      value: "fetched:allowed",
    });

    cleanup();
    broker.dispose();
  });
});
