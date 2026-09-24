/**
 * 多 stream 交错 LineId 的 spill metadata 压测。
 *
 * 用法：
 *   bun --conditions=browser run scripts/stream-multiplex-bench.ts --lines=100000 --streams=4
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLedger } from "@butui/core";
import {
  FileSpillStore,
  StreamLedger,
  type StreamEnvelope,
} from "@butui/stream";

function option(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix));
  if (!raw) return fallback;
  const parsed = Number(raw.slice(prefix.length));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const totalLines = option("lines", 100_000);
const streamCount = Math.min(totalLines, option("streams", 4));
const memoryBudget = option("memory", 64 * 1024);
const retainedBytes = Math.min(memoryBudget, option("retain", 32 * 1024));
const dir = mkdtempSync(join(tmpdir(), "butui-multiplex-"));
const path = join(dir, "cold.ndjson");
const memory = new MemoryLedger({ totalBytes: memoryBudget });
const store = new FileSpillStore(path);
const streams = new StreamLedger({
  memory,
  memoryOwner: "multiplex-bench",
  spill: { store, policy: { maxBytes: retainedBytes } },
});

const streamIds = Array.from({ length: streamCount }, (_, index) => `stream-${index}`);
const lineCounts = streamIds.map((_, index) => {
  const base = Math.floor(totalLines / streamCount);
  return base + (index < totalLines % streamCount ? 1 : 0);
});
const seq = streamIds.map(() => 1);

for (const streamId of streamIds) {
  streams.open({ streamId, kind: "text", priority: 1, createdAt: 0 });
}

function envelope(
  streamId: string,
  currentSeq: number,
  delta: string
): StreamEnvelope {
  return {
    sessionId: "multiplex-session",
    streamId,
    seq: currentSeq,
    baseRevision: currentSeq - 1,
    kind: "text",
    priority: 1,
    op: { type: "append", delta },
    createdAt: currentSeq,
  };
}

const startedAt = performance.now();
try {
  for (let line = 0; line < totalLines; line++) {
    const streamIndex = line % streamCount;
    if (seq[streamIndex]! > lineCounts[streamIndex]!) continue;
    const streamId = streamIds[streamIndex]!;
    const result = await streams.applyWithSpill(
      envelope(streamId, seq[streamIndex]!, `s${streamIndex}:${seq[streamIndex]}\n`)
    );
    if (result.status !== "applied") {
      throw new Error(`apply failed: ${streamId}/${seq[streamIndex]}: ${result.status}`);
    }
    seq[streamIndex]!++;
  }

  (Bun as typeof Bun & { gc?: (force?: boolean) => void }).gc?.(true);
  const usage = process.memoryUsage();
  const stats = streams.stats();
  const segments = streamIds.map(streamId => {
    const projection = streams.project(streamId);
    return {
      streamId,
      inMemoryLines: projection.stableLines.length,
      spilledLines: projection.spilledSegments.reduce(
        (sum, segment) => sum + segment.count,
        0
      ),
      segments: projection.spilledSegments.length,
      lineRuns: projection.spilledSegments.reduce(
        (sum, segment) => sum + (segment.lineRuns?.length ?? 0),
        0
      ),
      explicitLineIds: projection.spilledSegments.reduce(
        (sum, segment) => sum + (segment.lineIds?.length ?? 0),
        0
      ),
    };
  });

  const coldSamples = await Promise.all(
    streamIds.map(async (streamId, index) => {
      if (lineCounts[index] === 0) return null;
      const record = (await streams.readCold(streamId, [`line-${index + 1}`]))[0];
      return record?.text.trim() ?? null;
    })
  );

  console.log(
    JSON.stringify(
      {
        totalLines,
        streamCount,
        memoryBudget,
        retainedBytes,
        elapsedMs: performance.now() - startedAt,
        heapUsed: usage.heapUsed,
        rss: usage.rss,
        ledger: stats,
        fileBytes: store.stats().fileBytes,
        segments,
        coldSamples,
      },
      null,
      2
    )
  );
} finally {
  streams.dispose();
  rmSync(dir, { recursive: true, force: true });
}
