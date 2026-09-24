/**
 * Worker / process RPC 隔离基准。
 *
 *   bun --conditions=browser run scripts/plugin-isolation-bench.ts
 *   bun --conditions=browser run scripts/plugin-isolation-bench.ts --calls=5000 --json
 */
import { fileURLToPath } from "node:url";
import { attachProcessRpc } from "../packages/plugins/src/process-rpc.ts";
import { createWorkerRpc } from "../packages/plugins/src/worker-rpc.ts";

interface Result {
  mode: "worker" | "process";
  startupMs: number;
  calls: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  concurrentCallsPerSecond: number;
  parentHeapDeltaBytes: number;
  maxRSSBytes?: number;
}

const args = new Map(
  process.argv.slice(2).map(value => {
    const [key, raw] = value.split("=", 2);
    return [key!.replace(/^--/, ""), raw ?? "true"];
  })
);
const calls = positiveArg("calls", 2_000);
const warmup = positiveArg("warmup", 100);
const concurrency = positiveArg("concurrency", 32);
const json = args.get("json") === "true";

function positiveArg(name: string, fallback: number): number {
  const value = Number(args.get(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  );
  return sorted[index] ?? 0;
}

async function runLoad(
  rpc: ReturnType<typeof createWorkerRpc>
): Promise<{
  latencies: number[];
  concurrentCallsPerSecond: number;
}> {
  for (let index = 0; index < warmup; index++) {
    await rpc.call("echo", index);
  }

  const latencies: number[] = [];
  for (let index = 0; index < calls; index++) {
    const started = performance.now();
    await rpc.call("echo", index);
    latencies.push(performance.now() - started);
  }

  const started = performance.now();
  for (let index = 0; index < calls; index += concurrency) {
    const batch: Promise<unknown>[] = [];
    for (
      let offset = 0;
      offset < concurrency && index + offset < calls;
      offset++
    ) {
      batch.push(rpc.call("echo", index + offset));
    }
    await Promise.all(batch);
  }
  const elapsed = performance.now() - started;
  return {
    latencies,
    concurrentCallsPerSecond: elapsed > 0 ? (calls / elapsed) * 1_000 : 0,
  };
}

async function benchWorker(): Promise<Result> {
  const before = process.memoryUsage();
  const started = performance.now();
  const worker = new Worker(
    new URL("./helpers/isolation-worker.ts", import.meta.url)
  );
  const rpc = createWorkerRpc(worker, { timeoutMs: 10_000 });
  try {
    await rpc.call("echo", 0);
    const startupMs = performance.now() - started;
    const load = await runLoad(rpc);
    const after = process.memoryUsage();
    return {
      mode: "worker",
      startupMs,
      calls,
      p50Ms: percentile(load.latencies, 0.5),
      p95Ms: percentile(load.latencies, 0.95),
      p99Ms: percentile(load.latencies, 0.99),
      concurrentCallsPerSecond: load.concurrentCallsPerSecond,
      parentHeapDeltaBytes: after.heapUsed - before.heapUsed,
    };
  } finally {
    rpc.dispose();
    worker.terminate();
  }
}

async function benchProcess(): Promise<Result> {
  const before = process.memoryUsage();
  const started = performance.now();
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--conditions=browser",
      fileURLToPath(new URL("./helpers/isolation-process.ts", import.meta.url)),
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const endpoint = attachProcessRpc(child);
  const rpc = createWorkerRpc(endpoint, { timeoutMs: 10_000 });
  try {
    await rpc.call("echo", 0);
    const startupMs = performance.now() - started;
    const load = await runLoad(rpc);
    const after = process.memoryUsage();
    rpc.dispose();
    await endpoint.dispose();
    await child.exited;
    return {
      mode: "process",
      startupMs,
      calls,
      p50Ms: percentile(load.latencies, 0.5),
      p95Ms: percentile(load.latencies, 0.95),
      p99Ms: percentile(load.latencies, 0.99),
      concurrentCallsPerSecond: load.concurrentCallsPerSecond,
      parentHeapDeltaBytes: after.heapUsed - before.heapUsed,
      maxRSSBytes: child.resourceUsage()?.maxRSS,
    };
  } finally {
    rpc.dispose();
    await endpoint.dispose();
    await child.exited;
  }
}

const results = [await benchWorker(), await benchProcess()];
if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(
    `calls=${calls} warmup=${warmup} concurrency=${concurrency}\n`
  );
  console.log(
    "| mode | startup | p50 | p95 | p99 | concurrent rpc/s | parent heap Δ | maxRSS |"
  );
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const result of results) {
    console.log(
      `| ${result.mode} | ${result.startupMs.toFixed(2)} ms | ` +
        `${result.p50Ms.toFixed(3)} ms | ${result.p95Ms.toFixed(3)} ms | ` +
        `${result.p99Ms.toFixed(3)} ms | ` +
        `${Math.round(result.concurrentCallsPerSecond)} | ` +
        `${(result.parentHeapDeltaBytes / 1024 / 1024).toFixed(2)} MB | ` +
        `${
          result.maxRSSBytes === undefined
            ? "-"
            : `${(result.maxRSSBytes / 1024 / 1024).toFixed(1)} MB`
        } |`
    );
  }
}
