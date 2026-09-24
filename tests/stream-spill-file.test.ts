import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

  test("numeric index 支持跨 chunk、稀疏编号和规范前导零", () => {
    withTempDir(dir => {
      const path = join(dir, "cold.ndjson");
      const store = new FileSpillStore(path);
      store.write(record("line-1023", "a"));
      store.write(record("line-1024", "b"));
      store.write(record("line-1000000000", "sparse"));
      store.write(record("line-01", "leading-zero"));

      expect(store.read("stream-1", "line-1023")?.text).toBe("a");
      expect(store.read("stream-1", "line-1024")?.text).toBe("b");
      expect(store.read("stream-1", "line-1000000000")?.text).toBe("sparse");
      expect(store.read("stream-1", "line-01")?.text).toBe("leading-zero");
      expect(store.stats()).toMatchObject({ records: 4, bytes: 20 });

      store.delete("stream-1", "line-01");
      expect(store.read("stream-1", "line-01")).toBeUndefined();
      expect(new FileSpillStore(path).read("stream-1", "line-1024")?.text).toBe(
        "b"
      );
    });
  });

  test("bulk write/read 与 compact 保留最新记录顺序", () => {
    withTempDir(dir => {
      const path = join(dir, "cold.ndjson");
      const store = new FileSpillStore(path);
      const records = Array.from({ length: 2_500 }, (_, index) =>
        record(`line-${index + 1}`, `value-${index}`)
      );
      store.writeMany(records);
      expect(store.readMany("stream-1", records.map(value => value.lineId))).toEqual(
        records
      );

      store.write(record("line-2", "replacement"));
      store.write(record("named", "fallback"));
      store.compact();

      expect(store.stats()).toMatchObject({ records: 2_501, deletes: 0 });
      expect(store.read("stream-1", "line-1")?.text).toBe("value-0");
      expect(store.read("stream-1", "line-2")?.text).toBe("replacement");
      expect(store.read("stream-1", "named")?.text).toBe("fallback");
      expect(store.read("stream-1", "line-2500")?.text).toBe("value-2499");

      const reopened = new FileSpillStore(path);
      expect(reopened.stats().records).toBe(2_501);
      expect(reopened.read("stream-1", "line-2")?.text).toBe("replacement");
    });
  });

  test("numeric index 可磁盘换出并在 reopen 后重建", () => {
    withTempDir(dir => {
      const path = join(dir, "cold.ndjson");
      const indexPath = join(dir, "index");
      const records = Array.from({ length: 3_000 }, (_, index) =>
        record(`line-${index + 1}`, `value-${index}`)
      );
      const store = new FileSpillStore(path, {
        indexPath,
        indexCacheChunks: 1,
      });
      store.writeMany(records);

      expect(store.read("stream-1", "line-1")?.text).toBe("value-0");
      expect(store.read("stream-1", "line-2500")?.text).toBe("value-2499");
      expect(readdirSync(indexPath).length).toBeGreaterThan(0);

      const reopened = new FileSpillStore(path, {
        indexPath,
        indexCacheChunks: 1,
      });
      expect(reopened.read("stream-1", "line-1")?.text).toBe("value-0");
      expect(reopened.read("stream-1", "line-3000")?.text).toBe("value-2999");
      expect(reopened.stats().records).toBe(3_000);
    });
  });

  test("reopen 流式扫描可跨 read chunk 处理 UTF-8 记录", () => {
    withTempDir(dir => {
      const path = join(dir, "cold.ndjson");
      const store = new FileSpillStore(path);
      const text = `开头${"🙂汉字".repeat(20_000)}结尾`;
      store.write(record("line-1", text));

      const reopened = new FileSpillStore(path);
      expect(reopened.read("stream-1", "line-1")?.text).toBe(text);
      expect(reopened.stats().records).toBe(1);
    });
  });
});
