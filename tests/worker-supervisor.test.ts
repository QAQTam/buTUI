import { describe, expect, test } from "bun:test";
import {
  CapabilityBroker,
  createWorkerSupervisor,
  serveWorkerCapabilities,
} from "@butui/plugins";
import type {
  WorkerRpcEndpoint,
  WorkerRpcEndpointEvent,
  WorkerRpcMessage,
  WorkerSupervisor,
  WorkerSupervisorEvent,
} from "@butui/plugins";

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
  terminated = 0;

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

  terminate(): void {
    this.terminated++;
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

function crashEvent(): ErrorEvent {
  return {
    type: "error",
    error: new Error("worker crashed"),
    message: "worker crashed",
  } as ErrorEvent;
}

function waitForEvent(
  supervisor: WorkerSupervisor,
  type: WorkerSupervisorEvent["type"]
): Promise<WorkerSupervisorEvent> {
  return new Promise(resolve => {
    const unsubscribe = supervisor.onEvent(event => {
      if (event.type !== type) return;
      unsubscribe();
      resolve(event);
    });
  });
}

describe("Worker supervisor", () => {
  test("崩溃后自动重建，重启期间的调用等待新 generation", async () => {
    const endpoints: TestEndpoint[] = [];
    const setups: TestEndpoint[] = [];
    const supervisor = createWorkerSupervisor({
      create() {
        const endpoint = new TestEndpoint();
        endpoints.push(endpoint);
        return endpoint;
      },
      setup(endpoint) {
        setups.push(endpoint);
      },
      terminate(endpoint) {
        endpoint.terminate();
      },
      timeoutMs: 1_000,
      restartDelayMs: 10,
      maxRestarts: 2,
    });

    const first = endpoints[0]!;
    const rejected = captureRejection(supervisor.call("never"));
    const restarted = waitForEvent(supervisor, "restarted");
    first.emitEvent("error", crashEvent());

    expect((await rejected).message).toContain("worker crashed");
    const waiting = supervisor.call<number>("value");
    await restarted;
    await supervisor.ready();

    expect(endpoints).toHaveLength(2);
    expect(setups).toEqual(endpoints);
    expect(first.terminated).toBe(1);
    expect(supervisor.state).toBe("running");
    expect(supervisor.generation).toBe(2);
    expect(supervisor.restarts).toBe(1);

    const second = endpoints[1]!;
    expect(second.messages[0]).toMatchObject({
      type: "call",
      id: 1,
      method: "value",
      args: [],
    });
    second.emit({ type: "result", id: 1, value: 42 });
    expect(await waiting).toBe(42);

    await supervisor.dispose();
    expect(supervisor.state).toBe("stopped");
    expect(second.terminated).toBe(1);
  });

  test("自动重启预算耗尽后进入 failed，不再创建新 worker", async () => {
    const endpoints: TestEndpoint[] = [];
    const supervisor = createWorkerSupervisor({
      create() {
        const endpoint = new TestEndpoint();
        endpoints.push(endpoint);
        return endpoint;
      },
      terminate(endpoint) {
        endpoint.terminate();
      },
      maxRestarts: 1,
    });

    const restarted = waitForEvent(supervisor, "restarted");
    endpoints[0]!.emitEvent("error", crashEvent());
    await restarted;
    await supervisor.ready();

    const failed = waitForEvent(supervisor, "failed");
    endpoints[1]!.emitEvent("error", crashEvent());
    const failure = await failed;

    expect(failure).toMatchObject({
      type: "failed",
      generation: 2,
      restarts: 1,
    });
    expect(supervisor.state).toBe("failed");
    expect(endpoints).toHaveLength(2);
    expect((await captureRejection(supervisor.call("value"))).message).toContain(
      "worker crashed"
    );

    await supervisor.dispose();
  });

  test("failed 后手动 restart 可恢复并重置自动重启预算", async () => {
    const endpoints: TestEndpoint[] = [];
    const supervisor = createWorkerSupervisor({
      create() {
        const endpoint = new TestEndpoint();
        endpoints.push(endpoint);
        return endpoint;
      },
      terminate(endpoint) {
        endpoint.terminate();
      },
      maxRestarts: 0,
    });

    const failed = waitForEvent(supervisor, "failed");
    endpoints[0]!.emitEvent("error", crashEvent());
    await failed;
    expect(supervisor.state).toBe("failed");
    expect(endpoints).toHaveLength(1);

    await supervisor.restart();
    expect(supervisor.state).toBe("running");
    expect(supervisor.generation).toBe(2);
    expect(supervisor.restarts).toBe(0);
    expect(endpoints).toHaveLength(2);

    await supervisor.dispose();
  });

  test("手动 restart 会重新挂载 capability proxy", async () => {
    const broker = new CapabilityBroker();
    const lease = broker.grant("worker-plugin", "fs:read");
    const endpoints: TestEndpoint[] = [];
    const setups: TestEndpoint[] = [];
    const supervisor = createWorkerSupervisor({
      create() {
        const endpoint = new TestEndpoint();
        endpoints.push(endpoint);
        return endpoint;
      },
      setup(endpoint) {
        setups.push(endpoint);
        return serveWorkerCapabilities(endpoint, {
          pluginId: "worker-plugin",
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
      },
      terminate(endpoint) {
        endpoint.terminate();
      },
    });

    const first = endpoints[0]!;
    first.emit({ type: "call", id: 1, method: "readFile", args: ["a.txt"] });
    await Promise.resolve();
    expect(first.messages[0]).toEqual({
      type: "result",
      id: 1,
      value: "read:a.txt",
    });

    await supervisor.restart();
    expect(supervisor.generation).toBe(2);
    expect(supervisor.restarts).toBe(0);
    expect(setups).toEqual(endpoints);

    const second = endpoints[1]!;
    second.emit({ type: "call", id: 2, method: "readFile", args: ["b.txt"] });
    await Promise.resolve();
    expect(second.messages[0]).toEqual({
      type: "result",
      id: 2,
      value: "read:b.txt",
    });

    broker.revoke(lease, "test");
    second.emit({ type: "call", id: 3, method: "readFile", args: ["c.txt"] });
    await Promise.resolve();
    expect(second.messages[1]).toMatchObject({
      type: "error",
      id: 3,
      error: { message: expect.stringContaining("capability denied") },
    });

    await supervisor.dispose();
    broker.dispose();
  });

  test("dispose 会取消待执行的重启", async () => {
    const endpoints: TestEndpoint[] = [];
    const supervisor = createWorkerSupervisor({
      create() {
        const endpoint = new TestEndpoint();
        endpoints.push(endpoint);
        return endpoint;
      },
      terminate(endpoint) {
        endpoint.terminate();
      },
      restartDelayMs: 50,
    });

    endpoints[0]!.emitEvent("error", crashEvent());
    await supervisor.dispose();

    expect(supervisor.state).toBe("stopped");
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.terminated).toBe(1);
  });
});
