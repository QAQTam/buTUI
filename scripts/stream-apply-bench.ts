/**
 * StreamLedger apply / replay metadata 压测。
 *
 * 使用空 append 隔离文本与 cold storage，只测 seq / revision /
 * AppliedDigestIndex 的长期成本。
 *
 * 用法：
 *   bun --conditions=browser run scripts/stream-apply-bench.ts --events=1000000
 *   bun --conditions=browser run scripts/stream-apply-bench.ts --events=5000000 --cache-chunks=1
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamLedger, type StreamEnvelope } from "@butui/stream";

function option(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix));
  if (!raw) return fallback;
  const parsed = Number(raw.slice(prefix.length));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const events = option("events", 1_000_000);
const cacheChunks = option("cache-chunks", 0);
const dir =
  cacheChunks > 0 ? mkdtempSync(join(tmpdir(), "butui-applied-bench-")) : undefined;
const appliedStorePath = dir ? join(dir, "applied.bin") : undefined;
const ledger = new StreamLedger({
  ...(appliedStorePath ? { appliedStorePath } : {}),
  ...(cacheChunks > 0 ? { appliedCacheChunks: cacheChunks } : {}),
});
const streamId = "bench";
const appliedStoreFile = appliedStorePath
  ? `${appliedStorePath}.${encodeURIComponent(streamId)}`
  : undefined;
ledger.open({ streamId, kind: "text", priority: 1, createdAt: 0 });

function envelope(seq: number): StreamEnvelope {
  return {
    sessionId: "apply-bench",
    streamId,
    seq,
    baseRevision: seq - 1,
    kind: "text",
    priority: 1,
    op: { type: "append", delta: "" },
    createdAt: seq,
  };
}

(Bun as typeof Bun & { gc?: (force?: boolean) => void }).gc?.(true);
const before = process.memoryUsage();
const started = performance.now();

for (let seq = 1; seq <= events; seq++) {
  const result = ledger.apply(envelope(seq));
  if (result.status !== "applied") {
    throw new Error(`apply failed at ${seq}: ${JSON.stringify(result)}`);
  }
}

const elapsedMs = performance.now() - started;
const duplicate = ledger.apply(envelope(1));
(Bun as typeof Bun & { gc?: (force?: boolean) => void }).gc?.(true);
const after = process.memoryUsage();
const stats = ledger.stats();
ledger.dispose();
const appliedFileBytes = appliedStoreFile ? statSync(appliedStoreFile).size : 0;

console.log(
  JSON.stringify(
    {
      events,
      cacheChunks,
      elapsedMs,
      eventsPerSecond: events / (elapsedMs / 1000),
      heapBefore: before.heapUsed,
      heapAfter: after.heapUsed,
      heapDelta: after.heapUsed - before.heapUsed,
      heapBytesPerEvent: (after.heapUsed - before.heapUsed) / events,
      rssAfter: after.rss,
      appliedFileBytes,
      stats,
      duplicate,
    },
    null,
    2
  )
);

if (dir) rmSync(dir, { recursive: true, force: true });
