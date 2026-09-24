import { describe, expect, test } from "bun:test";
import { MemoryLedger } from "@butui/core";
import {
  MemorySpillStore,
  StreamLedger,
  type StreamEnvelope,
  type StreamOperation,
} from "@butui/stream";

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
