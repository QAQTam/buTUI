/**
 * StreamWindowController 连续滚动压测。
 *
 * 用法：
 *   bun --conditions=browser run scripts/stream-window-scroll-bench.ts \
 *     --lines=200000 --frames=1000 --events=20
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameClock, MemoryLedger } from "@butui/core";
import {
  FileSpillStore,
  StreamLedger,
  createStreamWindowController,
  type LineId,
  type SpillRecord,
  type SpillStore,
  type StreamEnvelope,
} from "@butui/stream";

function option(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix));
  if (!raw) return fallback;
  const parsed = Number(raw.slice(prefix.length));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

class CountingSpillStore implements SpillStore {
  readonly inner: FileSpillStore;
  readManyCalls = 0;
  readManyRecords = 0;
  readManyMs = 0;

  constructor(path: string) {
    this.inner = new FileSpillStore(path);
  }

  write(record: SpillRecord): void {
    this.inner.write(record);
  }

  writeMany(records: readonly SpillRecord[]): void {
    this.inner.writeMany(records);
  }

  read(streamId: string, lineId: LineId): SpillRecord | undefined {
    return this.inner.read(streamId, lineId);
  }

  readMany(
    streamId: string,
    lineIds: readonly LineId[]
  ): (SpillRecord | undefined)[] {
    this.readManyCalls++;
    this.readManyRecords += lineIds.length;
    const started = performance.now();
    const records = this.inner.readMany(streamId, lineIds);
    this.readManyMs += performance.now() - started;
    return records;
  }

  delete(streamId: string, lineId: LineId): void {
    this.inner.delete(streamId, lineId);
  }

  reset(): void {
    this.readManyCalls = 0;
    this.readManyRecords = 0;
    this.readManyMs = 0;
  }
}

function manualFrameClock() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextHandle = 1;
  const clock = new FrameClock(
    { fps: 120 },
    {
      now: () => now,
      queueMicrotask: () => {},
      setTimeout: (callback, delay) => {
        const handle = nextHandle++;
        timers.set(handle, { at: now + delay, callback });
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: handle => {
        timers.delete(handle as unknown as number);
      },
    }
  );
  return {
    clock,
    advance(deltaMs: number) {
      now += deltaMs;
      clock.advanceTo(now);
    },
  };
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  );
  return sorted[index]!;
}

const totalLines = option("lines", 200_000);
const frameCount = option("frames", 1_000);
const eventsPerFrame = option("events", 20);
const viewportHeight = option("height", 40);
const prefetchPages = option("prefetch", 2);
const cacheSize = option("cache", 8);
const batchLines = option("batch", 500);
const memoryBudget = option("memory", 64 * 1024);
const retainedBytes = Math.min(memoryBudget, option("retain", 32 * 1024));
const dir = mkdtempSync(join(tmpdir(), "butui-scroll-"));
const path = join(dir, "cold.ndjson");
const store = new CountingSpillStore(path);
const memory = new MemoryLedger({ totalBytes: memoryBudget });
const ledger = new StreamLedger({
  memory,
  memoryOwner: "scroll-bench",
  spill: { store, policy: { maxBytes: retainedBytes } },
});
const streamId = "bench";
ledger.open({ streamId, kind: "text", priority: 1, createdAt: 0 });

function envelope(seq: number, delta: string): StreamEnvelope {
  return {
    sessionId: "scroll-bench",
    streamId,
    seq,
    baseRevision: seq - 1,
    kind: "text",
    priority: 1,
    op: { type: "append", delta },
    createdAt: seq,
  };
}

const setupStarted = performance.now();
try {
  let seq = 0;
  let processed = 0;
  while (processed < totalLines) {
    const count = Math.min(batchLines, totalLines - processed);
    let delta = "";
    for (let index = 0; index < count; index++) {
      delta += `line ${processed + index}\n`;
    }
    const result = await ledger.applyWithSpill(envelope(++seq, delta));
    if (result.status !== "applied") {
      throw new Error(`setup failed at ${processed}: ${JSON.stringify(result)}`);
    }
    processed += count;
  }
  const setupMs = performance.now() - setupStarted;

  const frame = manualFrameClock();
  const controller = createStreamWindowController({
    ledger,
    streamId,
    height: viewportHeight,
    prefetchPages,
    cacheSize,
    clock: frame.clock,
  });
  await controller.load();
  await controller.flushPrefetch();
  store.reset();

  const frameLatencies: number[] = [];
  let direction: 1 | -1 = 1;
  const scrollStarted = performance.now();

  for (let index = 0; index < frameCount; index++) {
    if (controller.atBottom()) direction = -1;
    else if (controller.atTop()) direction = 1;

    for (let event = 0; event < eventsPerFrame; event++) {
      controller.requestScrollBy(direction);
    }

    const started = performance.now();
    frame.advance(1000 / 120);
    await controller.flushRequestedScroll();
    frameLatencies.push(performance.now() - started);
    await controller.flushPrefetch();
  }

  const scrollMs = performance.now() - scrollStarted;
  const stats = ledger.stats();
  console.log(
    JSON.stringify(
      {
        totalLines,
        frameCount,
        eventsPerFrame,
        totalEvents: frameCount * eventsPerFrame,
        viewportHeight,
        prefetchPages,
        cacheSize,
        setupMs,
        scrollMs,
        frameMs: {
          p50: percentile(frameLatencies, 0.5),
          p95: percentile(frameLatencies, 0.95),
          max: Math.max(...frameLatencies),
        },
        coldRead: {
          calls: store.readManyCalls,
          records: store.readManyRecords,
          elapsedMs: store.readManyMs,
          callsPerFrame: store.readManyCalls / frameCount,
        },
        finalOffset: controller.offset(),
        totalStableLines: stats.stableLines,
        spilledLines: stats.spilledLines,
        fileBytes: store.inner.stats().fileBytes,
      },
      null,
      2
    )
  );
} finally {
  ledger.dispose();
  rmSync(dir, { recursive: true, force: true });
}
