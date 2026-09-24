import { describe, expect, test } from "bun:test";
import {
  MemorySpillStore,
  StreamRetention,
  type SpillManifest,
  type SpillRecord,
  type SpillStore,
  type StreamLineRecord,
} from "@butui/stream";

function line(
  id: string,
  text: string,
  stableAtRevision = 1
): StreamLineRecord {
  return {
    id,
    text,
    stableAtRevision,
    digest: `digest:${id}`,
  };
}

describe("StreamRetention", () => {
  test("按 bytes 保留尾部，并保持 spill 顺序", () => {
    const retention = new StreamRetention(new MemorySpillStore(), {
      maxBytes: 10,
      keepTailLines: 1,
    });
    const plan = retention.plan([
      line("a", "aaaa"),
      line("b", "bbbb"),
      line("c", "cccc"),
    ]);

    expect(plan.spill.map(value => value.id)).toEqual(["a"]);
    expect(plan.keep.map(value => value.id)).toEqual(["b", "c"]);
    expect(plan.keptBytes).toBe(8);
    expect(plan.spillBytes).toBe(4);
  });

  test("spill / restore 保持 LineId、顺序和 digest", async () => {
    const store = new MemorySpillStore();
    const retention = new StreamRetention(store, { maxBytes: 0 });
    const lines = [line("a", "alpha"), line("b", "beta")];

    const result = await retention.spill("stream-1", lines);
    expect(result.manifest).toMatchObject({
      streamId: "stream-1",
      lineIds: ["a", "b"],
      firstLineId: "a",
      lastLineId: "b",
      count: 2,
      bytes: 9,
    });
    expect(store.stats()).toEqual({ records: 2, bytes: 9 });

    const restored = await retention.restore(result.manifest);
    expect(restored.map(record => [record.lineId, record.text, record.digest])).toEqual([
      ["a", "alpha", "digest:a"],
      ["b", "beta", "digest:b"],
    ]);
  });

  test("cold read 缺失明确抛 cold-read-error", async () => {
    const retention = new StreamRetention(new MemorySpillStore(), {
      maxBytes: 0,
    });
    const manifest: SpillManifest = {
      streamId: "stream-1",
      lineIds: ["missing"],
      firstLineId: "missing",
      lastLineId: "missing",
      count: 1,
      bytes: 7,
    };

    await expect(retention.restore(manifest)).rejects.toThrow("cold-read-error");
  });

  test("spill 写后校验失败不会静默成功", async () => {
    const broken: SpillStore = {
      write() {},
      read(streamId, lineId) {
        return {
          streamId,
          lineId,
          text: "corrupted",
          digest: "bad",
          stableAtRevision: 1,
          bytes: 9,
        } satisfies SpillRecord;
      },
    };
    const retention = new StreamRetention(broken, { maxBytes: 0 });

    await expect(retention.spill("stream-1", [line("a", "alpha")])).rejects.toThrow(
      "spill verification failed"
    );
  });
});
