import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSpillStore,
  StreamRetention,
  type SpillRecord,
  type StreamLineRecord,
} from "@butui/stream";

function line(id: string, text: string): StreamLineRecord {
  return {
    id,
    text,
    stableAtRevision: 1,
    digest: `digest:${id}`,
  };
}

function record(id: string, text: string): SpillRecord {
  return {
    streamId: "stream-1",
    lineId: id,
    text,
    digest: `digest:${id}`,
    stableAtRevision: 1,
    bytes: Buffer.byteLength(text),
  };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "butui-spill-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("FileSpillStore", () => {
  test("spill / restore 可跨 store 实例恢复", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butui-spill-"));
    try {
      const path = join(dir, "cold.ndjson");
      const store = new FileSpillStore(path);
      const retention = new StreamRetention(store, { maxBytes: 0 });

      const result = await retention.spill("stream-1", [
        line("a", "alpha"),
        line("b", "beta"),
      ]);
      const restored = await retention.restore(result.manifest);
      expect(restored.map(value => [value.lineId, value.text])).toEqual([
        ["a", "alpha"],
        ["b", "beta"],
      ]);

      const reopened = new FileSpillStore(path);
      expect(reopened.read("stream-1", "a")?.text).toBe("alpha");
      expect(reopened.stats()).toMatchObject({ records: 2, bytes: 9 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("delete tombstone 在 reopen 后仍生效", () => {
    withTempDir(dir => {
      const path = join(dir, "cold.ndjson");
      const store = new FileSpillStore(path);
      store.write(record("a", "alpha"));
      store.write(record("b", "beta"));
      store.delete("stream-1", "a");

      expect(store.read("stream-1", "a")).toBeUndefined();
      const reopened = new FileSpillStore(path);
      expect(reopened.read("stream-1", "a")).toBeUndefined();
      expect(reopened.read("stream-1", "b")?.text).toBe("beta");
      expect(reopened.stats()).toMatchObject({ records: 1, bytes: 4 });
    });
  });

  test("compact 只保留 live records", () => {
    withTempDir(dir => {
      const path = join(dir, "cold.ndjson");
      const store = new FileSpillStore(path);
      store.write(record("a", "alpha"));
      store.write(record("b", "beta"));
      store.delete("stream-1", "a");
      const before = store.stats().fileBytes;
      store.compact();

      expect(store.stats().records).toBe(1);
      expect(store.stats().fileBytes).toBeLessThan(before);
      expect(new FileSpillStore(path).read("stream-1", "b")?.text).toBe("beta");
    });
  });
});
