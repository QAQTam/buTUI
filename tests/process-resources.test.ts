import { describe, expect, test } from "bun:test";
import {
  createMemoryAuditLog,
  createNdjsonRpcEndpoint,
  spawnProcessRpc,
} from "@butui/plugins";

async function exitsWithin(
  process: { exited: Promise<number> },
  timeoutMs = 2_000
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited,
      new Promise<number>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("process did not exit within limit")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("process resource limits", () => {
  test("NDJSON endpoint 强制执行总字节与 bytes/s token bucket", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const errors: Event[] = [];
    let closes = 0;
    const endpoint = createNdjsonRpcEndpoint({
      input,
      output: { write() {} },
      maxBytesPerSecond: 5,
      now: () => 1_000,
      close() {
        closes++;
      },
    });
    endpoint.addEventListener("error", event => errors.push(event));

    controller.enqueue(encoder.encode("null\n"));
    controller.enqueue(encoder.encode("null\n"));
    await Bun.sleep(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as ErrorEvent).error?.message).toContain(
      "output rate exceeds 5 bytes/s"
    );
    expect(endpoint.closed).toBe(true);
    expect(closes).toBe(1);
    await endpoint.dispose();

    let totalController!: ReadableStreamDefaultController<Uint8Array>;
    const totalInput = new ReadableStream<Uint8Array>({
      start(value) {
        totalController = value;
      },
    });
    const totalErrors: Event[] = [];
    const total = createNdjsonRpcEndpoint({
      input: totalInput,
      output: { write() {} },
      maxTotalBytes: 4,
    });
    total.addEventListener("error", event => totalErrors.push(event));
    totalController.enqueue(encoder.encode("null\n"));
    await Bun.sleep(0);
    expect(totalErrors).toHaveLength(1);
    expect((totalErrors[0] as ErrorEvent).error?.message).toContain(
      "total output exceeds 4 bytes"
    );
    await total.dispose();
  });

  test("spawnProcessRpc 的 rate limit 会 kill 失控子进程", async () => {
    const audit = createMemoryAuditLog({ now: () => 1 });
    const spawned = spawnProcessRpc({
      cmd: [
        process.execPath,
        "-e",
        'process.stdout.write(JSON.stringify({type:"result",id:1,value:"x".repeat(20000)})+"\\n");setInterval(()=>{},1000)',
      ],
      resources: {
        maxBytesPerSecond: 1_024,
        killSignal: "SIGKILL",
      },
      audit,
    });
    const errors: Error[] = [];
    spawned.endpoint.addEventListener("error", event => {
      const error = (event as ErrorEvent).error;
      if (error) errors.push(error);
    });

    try {
      const code = await exitsWithin(spawned.process);
      expect(code).not.toBe(0);
      expect(
        errors.some(error => error.message.includes("output rate exceeds"))
      ).toBe(true);
      const types = audit.query().map(event => event.type);
      expect(types).toContain("process.started");
      expect(types).toContain("process.error");
      expect(types).toContain("process.exited");
      expect(types).toContain("process.killed");
    } finally {
      await spawned.endpoint.dispose();
    }
  });

  test("spawnProcessRpc 的 timeout 会终止长驻子进程", async () => {
    const spawned = spawnProcessRpc({
      cmd: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      resources: {
        timeoutMs: 30,
        killSignal: "SIGKILL",
      },
    });

    try {
      const code = await exitsWithin(spawned.process);
      expect(code).not.toBe(0);
      expect(spawned.endpoint.closed).toBe(true);
    } finally {
      await spawned.endpoint.dispose();
    }
  });
});
