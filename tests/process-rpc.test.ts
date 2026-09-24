import { describe, expect, test } from "bun:test";
import {
  CapabilityBroker,
  attachProcessRpc,
  createNdjsonRpcEndpoint,
  createWorkerRpc,
  createWorkerSupervisor,
  serveWorkerCapabilities,
} from "@butui/plugins";
import type { WorkerSupervisorEvent } from "@butui/plugins";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("./helpers/process-rpc-fixture.ts", import.meta.url)
);
const SERVER_FIXTURE = fileURLToPath(
  new URL("./helpers/process-server-fixture.ts", import.meta.url)
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

function spawnFixture(path = FIXTURE) {
  const child = Bun.spawn({
    cmd: [process.execPath, "--conditions=browser", path],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    child,
    endpoint: attachProcessRpc(child),
  };
}

function waitForEvent(
  supervisor: ReturnType<typeof createWorkerSupervisor>,
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

describe("NDJSON process RPC", () => {
  test("子进程可复用 call / result / error", async () => {
    const { child, endpoint } = spawnFixture();
    const rpc = createWorkerRpc(endpoint, { timeoutMs: 3_000 });
    try {
      expect(
        await rpc.call<{ value: number }>("echo", { value: 1 })
      ).toEqual({ value: 1 });
      expect(await rpc.call<number>("sum", 2, 3)).toBe(5);
      expect((await captureRejection(rpc.call("fail"))).message).toContain(
        "process failed"
      );
    } finally {
      rpc.dispose();
      await endpoint.dispose();
      await child.exited;
    }
  });

  test("serveProcessRpc 可作为纯 server 入口", async () => {
    const { child, endpoint } = spawnFixture(SERVER_FIXTURE);
    const rpc = createWorkerRpc(endpoint, { timeoutMs: 3_000 });
    try {
      expect(await rpc.call<number>("sum", 4, 5)).toBe(9);
    } finally {
      rpc.dispose();
      await endpoint.dispose();
      await child.exited;
    }
  });

  test("host capability proxy 可跨越 process stdio", async () => {
    const { child, endpoint } = spawnFixture();
    const broker = new CapabilityBroker();
    const lease = broker.grant("process-plugin", "fs:read");
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
      expect(await rpc.call<string>("readViaHost", "a.txt")).toBe("read:a.txt");
      broker.revoke(lease, "test");
      expect(
        (await captureRejection(rpc.call("readViaHost", "b.txt"))).message
      ).toContain("capability denied");
    } finally {
      rpc.dispose();
      cleanup();
      broker.dispose();
      await endpoint.dispose();
      await child.exited;
    }
  });

  test("supervisor 可在 process crash 后重建并恢复 capability", async () => {
    const broker = new CapabilityBroker();
    broker.grant("process-plugin", "fs:read");
    const supervisor = createWorkerSupervisor({
      create() {
        return spawnFixture().endpoint;
      },
      setup(endpoint) {
        return serveWorkerCapabilities(endpoint, {
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
      },
      terminate(endpoint) {
        return endpoint.dispose();
      },
      timeoutMs: 3_000,
      maxRestarts: 1,
    });

    try {
      expect(await supervisor.call<string>("readViaHost", "a.txt")).toBe(
        "read:a.txt"
      );
      const restarted = waitForEvent(supervisor, "restarted");
      const failure = await captureRejection(supervisor.call("crash"));
      expect(failure.message).toContain("process RPC stream closed");
      await restarted;
      await supervisor.ready();
      expect(supervisor.generation).toBe(2);
      expect(await supervisor.call<string>("readViaHost", "b.txt")).toBe(
        "read:b.txt"
      );
    } finally {
      await supervisor.dispose();
      broker.dispose();
    }
  });

  test("NDJSON framing 支持任意分片并拒绝超长帧", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const output: string[] = [];
    const endpoint = createNdjsonRpcEndpoint({
      input,
      output: {
        write(chunk) {
          output.push(String(chunk));
        },
      },
      maxFrameBytes: 128,
    });
    const messages: unknown[] = [];
    const errors: Event[] = [];
    endpoint.addEventListener("message", event => {
      messages.push((event as MessageEvent).data);
    });
    endpoint.addEventListener("messageerror", event => errors.push(event));

    controller.enqueue(encoder.encode('{"type":"result","id":1,"value"'));
    controller.enqueue(encoder.encode(":42}\n"));
    await Bun.sleep(0);
    expect(messages).toEqual([{ type: "result", id: 1, value: 42 }]);

    endpoint.postMessage({ type: "call", id: 2, method: "x", args: [] });
    expect(output.join("")).toBe(
      '{"type":"call","id":2,"method":"x","args":[]}\n'
    );

    controller.enqueue(encoder.encode(`${"x".repeat(129)}\n`));
    await Bun.sleep(0);
    expect(errors).toHaveLength(1);
    expect(endpoint.closed).toBe(true);
    await endpoint.dispose();
  });
});
