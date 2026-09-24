import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLedger } from "@butui/core";
import {
  MemorySpillStore,
  StreamLedger,
  type LineId,
  type SpillRecord,
  type StreamEnvelope,
  type StreamOperation,
} from "@butui/stream";

class TrackingSpillStore extends MemorySpillStore {
  readManyCalls = 0;

  override readMany(
    streamId: string,
    lineIds: readonly LineId[]
  ): (SpillRecord | undefined)[] {
    this.readManyCalls++;
    return super.readMany(streamId, lineIds);
  }
}

function envelope(
  seq: number,
  op: StreamOperation,
  overrides: Partial<StreamEnvelope> = {}
): StreamEnvelope {
  return {
    sessionId: "session-1",
    streamId: "stream-1",
    seq,
    baseRevision: seq - 1,
    kind: "text",
    priority: 1,
    op,
    createdAt: seq,
    ...overrides,
  };
}

function ledger(): StreamLedger {
  const value = new StreamLedger();
  value.open({
    streamId: "stream-1",
    kind: "text",
    priority: 1,
    createdAt: 0,
  });
  return value;
}

describe("StreamLedger", () => {
  test("append 区分 stable lines 与 volatile tail", () => {
    const streams = ledger();

    expect(
      streams.apply(envelope(1, { type: "append", delta: "hello" }))
    ).toEqual({ status: "applied", revision: 1, linesAdded: 0 });
    expect(streams.project("stream-1").stableLines).toEqual([]);
    expect(streams.project("stream-1").volatileTail[0]?.text).toBe("hello");

    expect(
      streams.apply(envelope(2, { type: "append", delta: "\nworld" }))
    ).toEqual({ status: "applied", revision: 2, linesAdded: 1 });
    const projection = streams.project("stream-1");
    expect(projection.stableLines.map(line => line.text)).toEqual(["hello"]);
    expect(projection.volatileTail.map(line => line.text)).toEqual(["world"]);
  });

  test("重复 seq 幂等，同 seq 不同 op 冲突，缺口显式拒绝", () => {
    const streams = ledger();
    const first = envelope(1, { type: "append", delta: "a" });
    expect(streams.apply(first).status).toBe("applied");
    expect(streams.apply(first)).toEqual({ status: "duplicate", seq: 1 });
    expect(
      streams.apply(envelope(1, { type: "append", delta: "b" }))
    ).toEqual({ status: "rejected", reason: "conflict" });
    expect(
      streams.apply(envelope(3, { type: "append", delta: "c" }))
    ).toEqual({ status: "rejected", reason: "gap" });
  });

  test("跨 chunk 的 applied digest 仍可识别旧 duplicate / conflict", () => {
    const streams = ledger();
    for (let seq = 1; seq <= 5_000; seq++) {
      expect(
        streams.apply(envelope(seq, { type: "append", delta: "x\n" })).status
      ).toBe("applied");
    }

    const first = envelope(1, { type: "append", delta: "x\n" });
    expect(streams.apply(first)).toEqual({ status: "duplicate", seq: 1 });
    expect(
      streams.apply(envelope(1, { type: "append", delta: "different\n" }))
    ).toEqual({ status: "rejected", reason: "conflict" });
  });

  test("applied digest 可磁盘换出并保持精确 duplicate / conflict", () => {
    const dir = mkdtempSync(join(tmpdir(), "butui-applied-"));
    const path = join(dir, "applied.bin");
    try {
      const streams = new StreamLedger({
        appliedStorePath: path,
        appliedCacheChunks: 1,
      });
      streams.open({
        streamId: "stream-1",
        kind: "text",
        priority: 1,
        createdAt: 0,
      });

      for (let seq = 1; seq <= 5_000; seq++) {
        streams.apply(envelope(seq, { type: "append", delta: "" }));
      }

      const first = envelope(1, { type: "append", delta: "" });
      expect(streams.apply(first)).toEqual({ status: "duplicate", seq: 1 });
      expect(
        streams.apply(envelope(1, { type: "append", delta: "conflict" }))
      ).toEqual({ status: "rejected", reason: "conflict" });
      streams.dispose();
      expect(existsSync(`${path}.stream-1`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appliedStorePath 为每个 stream 使用独立 sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "butui-applied-multi-"));
    const path = join(dir, "applied.bin");
    try {
      const streams = new StreamLedger({
        appliedStorePath: path,
        appliedCacheChunks: 1,
      });
      for (const streamId of ["stream-a", "stream-b"]) {
        streams.open({ streamId, kind: "text", priority: 1, createdAt: 0 });
      }

      for (let seq = 1; seq <= 2_000; seq++) {
        streams.apply(
          envelope(seq, { type: "append", delta: "" }, { streamId: "stream-a" })
        );
        streams.apply(
          envelope(seq, { type: "append", delta: "" }, { streamId: "stream-b" })
        );
      }

      expect(
        streams.apply(
          envelope(1, { type: "append", delta: "" }, { streamId: "stream-a" })
        )
      ).toEqual({ status: "duplicate", seq: 1 });
      expect(
        streams.apply(
          envelope(1, { type: "append", delta: "conflict" }, {
            streamId: "stream-b",
          })
        )
      ).toEqual({ status: "rejected", reason: "conflict" });
      streams.dispose();
      expect(existsSync(`${path}.stream-a`)).toBe(true);
      expect(existsSync(`${path}.stream-b`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replace-tail 可替换 volatile tail，但不能越过 stable line", () => {
    const streams = ledger();
    streams.apply(envelope(1, { type: "append", delta: "hello world" }));
    const tail = streams.project("stream-1").volatileTail[0]!;

    expect(
      streams.apply(
        envelope(2, {
          type: "replace-tail",
          from: { lineId: tail.id, grapheme: 5 },
          text: " there",
        })
      )
    ).toEqual({ status: "applied", revision: 2, linesAdded: 0 });
    expect(streams.project("stream-1").volatileTail[0]?.text).toBe("hello there");

    streams.apply(envelope(3, { type: "append", delta: "\nstable" }));
    const stable = streams.project("stream-1").stableLines[0]!;
    expect(
      streams.apply(
        envelope(4, {
          type: "replace-tail",
          from: { lineId: stable.id, grapheme: 0 },
          text: "bad",
        })
      )
    ).toEqual({
      status: "rejected",
      reason: "anchor-outside-volatile-tail",
    });
  });

  test("from=null 清空 volatile tail 后替换", () => {
    const streams = ledger();
    streams.apply(envelope(1, { type: "append", delta: "old" }));
    expect(
      streams.apply(
        envelope(2, { type: "replace-tail", from: null, text: "new" })
      )
    ).toEqual({ status: "applied", revision: 2, linesAdded: 0 });
    expect(streams.project("stream-1").volatileTail[0]?.text).toBe("new");
  });

  test("finish 将 tail 定稿并关闭 stream", () => {
    const streams = ledger();
    streams.apply(envelope(1, { type: "append", delta: "done" }));
    expect(streams.apply(envelope(2, { type: "finish" }))).toEqual({
      status: "applied",
      revision: 2,
      linesAdded: 1,
    });

    const projection = streams.project("stream-1");
    expect(projection.status).toBe("finished");
    expect(projection.volatileTail).toEqual([]);
    expect(projection.stableLines.map(line => line.text)).toEqual(["done"]);
    expect(
      streams.apply(envelope(3, { type: "append", delta: "late" }))
    ).toEqual({ status: "rejected", reason: "closed" });
  });

  test("cancel 保留 tombstone，后续 op 返回 cancelled", () => {
    const streams = ledger();
    streams.apply(envelope(1, { type: "append", delta: "partial" }));
    expect(
      streams.apply(envelope(2, { type: "cancel", reason: "user" }))
    ).toEqual({ status: "applied", revision: 2, linesAdded: 0 });

    const projection = streams.project("stream-1");
    expect(projection.status).toBe("cancelled");
    expect(projection.tombstones).toEqual([
      { streamId: "stream-1", reason: "user", atRevision: 2 },
    ]);
    expect(
      streams.apply(envelope(3, { type: "append", delta: "late" }))
    ).toEqual({ status: "rejected", reason: "cancelled" });
  });

  test("可选 MemoryLedger 预算不足时拒绝 op，dispose 释放 reservation", () => {
    const memory = new MemoryLedger({ totalBytes: 5 });
    const streams = new StreamLedger({ memory, memoryOwner: "test-stream" });
    streams.open({
      streamId: "stream-1",
      kind: "text",
      priority: 1,
      createdAt: 0,
    });

    expect(
      streams.apply(envelope(1, { type: "append", delta: "hello" })).status
    ).toBe("applied");
    expect(streams.stats().reservedBytes).toBe(5);
    expect(
      streams.apply(envelope(2, { type: "append", delta: "!" }))
    ).toEqual({ status: "rejected", reason: "budget-exceeded" });
    expect(streams.project("stream-1").volatileTail[0]?.text).toBe("hello");

    streams.dispose();
    expect(memory.stats().usedBytes).toBe(0);
  });

  test("applyWithSpill 会释放旧 stable line 后重试成功", async () => {
    const memory = new MemoryLedger({ totalBytes: 6 });
    const store = new MemorySpillStore();
    const streams = new StreamLedger({
      memory,
      memoryOwner: "test-stream",
      spill: { store, policy: { maxBytes: 0 } },
    });
    streams.open({
      streamId: "stream-1",
      kind: "text",
      priority: 1,
      createdAt: 0,
    });

    expect(
      (await streams.applyWithSpill(
        envelope(1, { type: "append", delta: "hello\n" })
      )).status
    ).toBe("applied");
    expect(streams.project("stream-1").stableLines[0]?.text).toBe("hello");

    expect(
      (await streams.applyWithSpill(
        envelope(2, { type: "append", delta: "!" })
      )).status
    ).toBe("applied");
    const projection = streams.project("stream-1");
    expect(projection.stableLines).toEqual([]);
    expect(projection.spilledSegments).toMatchObject([
      {
        streamId: "stream-1",
        firstLineId: "line-1",
        lastLineId: "line-1",
        count: 1,
        bytes: 5,
      },
    ]);
    expect(store.stats()).toEqual({ records: 1, bytes: 5 });
    expect(memory.stats().usedBytes).toBe(1);

    expect(await streams.hydrate("stream-1")).toBe(1);
    expect(streams.project("stream-1").stableLines[0]?.text).toBe("hello");
    expect(streams.project("stream-1").spilledSegments).toEqual([]);
  });

  test("hydrate 使用有界批读并保持 spilled segment 顺序", async () => {
    const memory = new MemoryLedger({ totalBytes: 256 });
    const store = new TrackingSpillStore();
    const streams = new StreamLedger({
      memory,
      memoryOwner: "test-stream",
      spill: { store, policy: { maxBytes: 0 } },
    });
    streams.open({
      streamId: "stream-1",
      kind: "text",
      priority: 1,
      createdAt: 0,
    });

    for (let seq = 1; seq <= 3_000; seq++) {
      const result = await streams.applyWithSpill(
        envelope(seq, { type: "append", delta: "x\n" })
      );
      expect(result.status).toBe("applied");
    }

    const before = streams.stats();
    expect(before.spilledLines).toBeGreaterThan(1024);
    store.readManyCalls = 0;

    const window = await streams.readStableRange("stream-1", 1024, 4);
    expect(window).toMatchObject({
      offset: 1024,
      totalLines: 3_000,
    });
    expect(window.lines.map(line => line.id)).toEqual([
      "line-1025",
      "line-1026",
      "line-1027",
      "line-1028",
    ]);
    expect(window.lines.map(line => line.text)).toEqual(["x", "x", "x", "x"]);
    expect(streams.stats().spilledLines).toBe(before.spilledLines);
    store.readManyCalls = 0;

    expect(await streams.hydrate("stream-1")).toBe(before.spilledLines);
    expect(store.readManyCalls).toBe(Math.ceil(before.spilledLines / 1024));

    const projection = streams.project("stream-1");
    expect(projection.spilledSegments).toEqual([]);
    expect(projection.stableLines).toHaveLength(3_000);
    expect(projection.stableLines[0]?.id).toBe("line-1");
    expect(projection.stableLines[1024]?.id).toBe("line-1025");
    expect(projection.stableLines[2999]?.id).toBe("line-3000");

    const clamped = await streams.readStableRange("stream-1", 99_999, 10);
    expect(clamped).toMatchObject({ offset: 3_000, totalLines: 3_000, lines: [] });
  });

  test("hydrate 批读缺失记录时显式 cold-read-error", async () => {
    const memory = new MemoryLedger({ totalBytes: 64 });
    const store = new TrackingSpillStore();
    const streams = new StreamLedger({
      memory,
      memoryOwner: "test-stream",
      spill: { store, policy: { maxBytes: 0 } },
    });
    streams.open({
      streamId: "stream-1",
      kind: "text",
      priority: 1,
      createdAt: 0,
    });

    for (let seq = 1; seq <= 1_300; seq++) {
      await streams.applyWithSpill(
        envelope(seq, { type: "append", delta: "x\n" })
      );
    }
    store.delete("stream-1", "line-1");

    await expect(streams.hydrate("stream-1")).rejects.toThrow(
      "cold-read-error: stream-1/line-1"
    );
  });

  test("多 stream 交错 LineId 后仍可完整 hydrate", async () => {
    const memory = new MemoryLedger({ totalBytes: 128 });
    const store = new MemorySpillStore();
    const streams = new StreamLedger({
      memory,
      memoryOwner: "test-stream",
      spill: { store, policy: { maxBytes: 0 } },
    });
    streams.open({
      streamId: "stream-a",
      kind: "text",
      priority: 1,
      createdAt: 0,
    });
    streams.open({
      streamId: "stream-b",
      kind: "text",
      priority: 1,
      createdAt: 0,
    });

    for (let seq = 1; seq <= 200; seq++) {
      await streams.applyWithSpill(
        envelope(seq, { type: "append", delta: "a\n" }, { streamId: "stream-a" })
      );
      await streams.applyWithSpill(
        envelope(seq, { type: "append", delta: "b\n" }, { streamId: "stream-b" })
      );
    }

    const aBefore = streams.project("stream-a");
    const bBefore = streams.project("stream-b");
    expect(aBefore.spilledSegments.length).toBeGreaterThan(0);
    expect(bBefore.spilledSegments.length).toBeGreaterThan(0);
    expect(aBefore.spilledSegments[0]?.lineIds).toBeUndefined();
    expect(aBefore.spilledSegments[0]?.lineRuns).toEqual([
      {
        prefix: "line-",
        start: 1,
        step: 2,
        count: aBefore.spilledSegments[0]!.count,
      },
    ]);
    expect(bBefore.spilledSegments[0]?.lineRuns).toEqual([
      {
        prefix: "line-",
        start: 2,
        step: 2,
        count: bBefore.spilledSegments[0]!.count,
      },
    ]);

    const coldA = await streams.readCold("stream-a", ["line-1", "line-3"]);
    const coldB = await streams.readCold("stream-b", ["line-2", "line-4"]);
    const lastColdA = await streams.readCold("stream-a", [
      aBefore.spilledSegments[aBefore.spilledSegments.length - 1]!.lastLineId,
    ]);
    const lastColdB = await streams.readCold("stream-b", [
      bBefore.spilledSegments[bBefore.spilledSegments.length - 1]!.lastLineId,
    ]);
    expect(coldA.map(line => line.text)).toEqual(["a", "a"]);
    expect(coldB.map(line => line.text)).toEqual(["b", "b"]);
    expect(lastColdA[0]?.text).toBe("a");
    expect(lastColdB[0]?.text).toBe("b");

    const windowA = await streams.readStableRange("stream-a", 0, 4);
    const windowB = await streams.readStableRange("stream-b", 0, 4);
    expect(windowA.lines.map(line => line.id)).toEqual([
      "line-1",
      "line-3",
      "line-5",
      "line-7",
    ]);
    expect(windowB.lines.map(line => line.id)).toEqual([
      "line-2",
      "line-4",
      "line-6",
      "line-8",
    ]);
    expect(windowA.lines.map(line => line.text)).toEqual(["a", "a", "a", "a"]);
    expect(windowB.lines.map(line => line.text)).toEqual(["b", "b", "b", "b"]);
    expect(streams.project("stream-a").stableLines).toHaveLength(
      aBefore.stableLines.length
    );
    expect(streams.project("stream-b").stableLines).toHaveLength(
      bBefore.stableLines.length
    );
    await expect(streams.readCold("stream-a", ["line-400"])).rejects.toThrow(
      "line-not-cold: stream-a/line-400"
    );

    const aRestored = await streams.hydrate("stream-a");
    const bRestored = await streams.hydrate("stream-b");
    expect(aRestored).toBe(aBefore.spilledSegments.reduce(
      (sum, segment) => sum + segment.count,
      0
    ));
    expect(bRestored).toBe(bBefore.spilledSegments.reduce(
      (sum, segment) => sum + segment.count,
      0
    ));

    const aLines = streams.project("stream-a").stableLines;
    const bLines = streams.project("stream-b").stableLines;
    expect(aLines.map(line => line.text)).toEqual(
      Array.from({ length: 200 }, () => "a")
    );
    expect(bLines.map(line => line.text)).toEqual(
      Array.from({ length: 200 }, () => "b")
    );
    expect(aLines.map(line => line.id)).toEqual(
      Array.from({ length: 200 }, (_, index) => `line-${index * 2 + 1}`)
    );
    expect(bLines.map(line => line.id)).toEqual(
      Array.from({ length: 200 }, (_, index) => `line-${index * 2 + 2}`)
    );
  });

  test("多 stream 非均匀交错时 lineRuns 仍保持完整顺序", async () => {
    const memory = new MemoryLedger({ totalBytes: 192 });
    const store = new MemorySpillStore();
    const streams = new StreamLedger({
      memory,
      memoryOwner: "test-stream",
      spill: { store, policy: { maxBytes: 0 } },
    });
    for (const streamId of ["stream-a", "stream-b", "stream-c"]) {
      streams.open({
        streamId,
        kind: "text",
        priority: 1,
        createdAt: 0,
      });
    }

    const seq = { "stream-a": 1, "stream-b": 1, "stream-c": 1 };
    const expected = {
      "stream-a": [] as string[],
      "stream-b": [] as string[],
      "stream-c": [] as string[],
    };
    const append = async (streamId: keyof typeof seq, text: string) => {
      await streams.applyWithSpill(
        envelope(seq[streamId]++, { type: "append", delta: `${text}\n` }, {
          streamId,
        })
      );
      expected[streamId].push(text);
    };

    for (let round = 0; round < 80; round++) {
      await append("stream-a", `a-${round}-0`);
      await append("stream-a", `a-${round}-1`);
      await append("stream-b", `b-${round}`);
      await append("stream-c", `c-${round}-0`);
      await append("stream-c", `c-${round}-1`);
      await append("stream-c", `c-${round}-2`);
    }

    for (const streamId of ["stream-a", "stream-b", "stream-c"] as const) {
      const before = streams.project(streamId);
      expect(before.spilledSegments.some(segment => segment.lineRuns)).toBe(true);
      await streams.hydrate(streamId);
      expect(streams.project(streamId).stableLines.map(line => line.text)).toEqual(
        expected[streamId]
      );
    }
  });

  test("stats 汇总 streams / lines / tombstones", () => {
    const streams = ledger();
    streams.apply(envelope(1, { type: "append", delta: "a\nb" }));
    streams.apply(envelope(2, { type: "cancel", reason: "test" }));
    expect(streams.stats()).toEqual({
      streams: 1,
      openStreams: 0,
      stableLines: 1,
      inMemoryLines: 1,
      spilledLines: 0,
      tailLines: 0,
      tombstones: 1,
      reservedBytes: 0,
    });
  });
});
