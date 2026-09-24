/**
 * Stream retention / spill 压测。
 *
 * 用法：
 *   bun --conditions=browser run scripts/stream-retention-bench.ts --lines=100000
 *   bun --conditions=browser run scripts/stream-retention-bench.ts --lines=1000000 --batch=500
 *   bun --conditions=browser run scripts/stream-retention-bench.ts --lines=1000000 --reopen
 *   bun --conditions=browser run scripts/stream-retention-bench.ts --lines=1000000 --hydrate
 *   bun --conditions=browser run scripts/stream-retention-bench.ts --lines=1000000 --cold-read=1000
 *   bun --conditions=browser run scripts/stream-retention-bench.ts --lines=1000000 --window=1000
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLedger } from "@butui/core";
import {
  FileSpillStore,
  StreamLedger,
  type StreamEnvelope,
  type StreamOperation,
} from "@butui/stream";

function option(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix));
  if (!raw) return fallback;
  const parsed = Number(raw.slice(prefix.length));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const totalLines = option("lines", 100_000);
const batchLines = Math.min(totalLines, option("batch", 100));
const memoryBudget = option("memory", 64 * 1024);
const retainedBytes = Math.min(memoryBudget, option("retain", 32 * 1024));
const coldReadCount = option("cold-read", 0);
const stableWindowCount = option("window", 0);
const dir = mkdtempSync(join(tmpdir(), "butui-retention-"));
const path = join(dir, "cold.ndjson");
const memory = new MemoryLedger({ totalBytes: memoryBudget });
const store = new FileSpillStore(path);
const streams = new StreamLedger({
  memory,
  memoryOwner: "retention-bench",
  spill: { store, policy: { maxBytes: retainedBytes } },
});
const streamId = "bench";

streams.open({
  streamId,
  kind: "text",
  priority: 1,
  createdAt: 0,
});

function envelope(seq: number, op: StreamOperation): StreamEnvelope {
  return {
    sessionId: "bench-session",
    streamId,
    seq,
    baseRevision: seq - 1,
    kind: "text",
    priority: 1,
    op,
    createdAt: seq,
  };
}

function snapshot(seq: number) {
  (Bun as typeof Bun & { gc?: (force?: boolean) => void }).gc?.(true);
  const usage = process.memoryUsage();
  const stats = streams.stats();
  return {
    seq,
    lines: seq,
    heapUsed: usage.heapUsed,
    rss: usage.rss,
    ledgerUsed: memory.stats().usedBytes,
    reservedBytes: stats.reservedBytes,
    stableLines: stats.stableLines,
    inMemoryLines: stats.inMemoryLines,
    spilledLines: stats.spilledLines,
    fileBytes: store.stats().fileBytes,
  };
}

function reopenStore() {
  (Bun as typeof Bun & { gc?: (force?: boolean) => void }).gc?.(true);
  const before = process.memoryUsage();
  const started = performance.now();
  const reopened = new FileSpillStore(path);
  const elapsedMs = performance.now() - started;
  const spilledLines = streams.stats().spilledLines;
  const lastLineId = `line-${spilledLines}`;
  const record = reopened.read(streamId, lastLineId);
  if (!record) {
    throw new Error(`reopen 后无法读取 ${lastLineId}`);
  }
  const usage = process.memoryUsage();
  return {
    elapsedMs,
    heapBefore: before.heapUsed,
    heapAfter: usage.heapUsed,
    rssAfter: usage.rss,
    stats: reopened.stats(),
    lastLine: record.text.trim(),
  };
}

async function coldReadStore() {
  const spilledLines = streams.stats().spilledLines;
  const count = Math.min(coldReadCount, spilledLines);
  const lineIds = Array.from({ length: count }, (_, index) => {
    const at =
      count <= 1 ? 0 : Math.floor((index * (spilledLines - 1)) / (count - 1));
    return `line-${at + 1}`;
  });
  (Bun as typeof Bun & { gc?: (force?: boolean) => void }).gc?.(true);
  const before = process.memoryUsage();
  const started = performance.now();
  const records = await streams.readCold(streamId, lineIds);
  const elapsedMs = performance.now() - started;
  const usage = process.memoryUsage();
  return {
    requested: lineIds.length,
    restored: records.length,
    elapsedMs,
    heapBefore: before.heapUsed,
    heapAfter: usage.heapUsed,
    first: records[0]?.text.trim(),
    last: records[records.length - 1]?.text.trim(),
  };
}

async function stableWindowStore() {
  const stats = streams.stats();
  const offset = Math.max(0, stats.spilledLines - Math.floor(stableWindowCount / 2));
  (Bun as typeof Bun & { gc?: (force?: boolean) => void }).gc?.(true);
  const before = process.memoryUsage();
  const started = performance.now();
  const window = await streams.readStableRange(streamId, offset, stableWindowCount);
  const elapsedMs = performance.now() - started;
  const usage = process.memoryUsage();
  return {
    requested: stableWindowCount,
    offset: window.offset,
    totalLines: window.totalLines,
    returned: window.lines.length,
    elapsedMs,
    heapBefore: before.heapUsed,
    heapAfter: usage.heapUsed,
    first: window.lines[0]?.id,
    last: window.lines[window.lines.length - 1]?.id,
  };
}

async function hydrateStore() {
  (Bun as typeof Bun & { gc?: (force?: boolean) => void }).gc?.(true);
  const before = process.memoryUsage();
  const started = performance.now();
  const restored = await streams.hydrate(streamId);
  const elapsedMs = performance.now() - started;
  const usage = process.memoryUsage();
  const projection = streams.project(streamId);
  return {
    elapsedMs,
    restored,
    heapBefore: before.heapUsed,
    heapAfter: usage.heapUsed,
    rssAfter: usage.rss,
    stableLines: projection.stableLines.length,
    spilledSegments: projection.spilledSegments.length,
  };
}

const startedAt = performance.now();
let seq = 0;
let processedLines = 0;
const samples: ReturnType<typeof snapshot>[] = [];
const reportEvery = Math.max(batchLines, Math.floor(totalLines / 10));

try {
  while (processedLines < totalLines) {
    const count = Math.min(batchLines, totalLines - processedLines);
    let text = "";
    for (let index = 0; index < count; index++) {
      text += `line ${processedLines + index}\n`;
    }
    seq++;
    const result = await streams.applyWithSpill(
      envelope(seq, { type: "append", delta: text })
    );
    if (result.status !== "applied") {
      throw new Error(`apply failed at ${seq}: ${JSON.stringify(result)}`);
    }
    processedLines += count;
    if (processedLines % reportEvery === 0 || processedLines === totalLines) {
      samples.push(snapshot(processedLines));
    }
  }

  const final = snapshot(totalLines);
  const elapsedMs = performance.now() - startedAt;
  const coldRead = coldReadCount > 0 ? await coldReadStore() : undefined;
  const stableWindow =
    stableWindowCount > 0 ? await stableWindowStore() : undefined;
  const hydrate = process.argv.includes("--hydrate")
    ? await hydrateStore()
    : undefined;
  const reopen = process.argv.includes("--reopen") ? reopenStore() : undefined;
  console.log(
    JSON.stringify(
      {
        totalLines,
        batchLines,
        memoryBudget,
        retainedBytes,
        elapsedMs,
        final,
        ...(coldRead ? { coldRead } : {}),
        ...(stableWindow ? { stableWindow } : {}),
        ...(hydrate ? { hydrate } : {}),
        ...(reopen ? { reopen } : {}),
        samples,
      },
      null,
      2
    )
  );
} finally {
  streams.dispose();
  rmSync(dir, { recursive: true, force: true });
}
