import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLedger } from "@butui/core";
import {
  DEFAULT_RETENTION_POLICY,
  FileSpillStore,
  StreamLedger,
  type SpillRecord,
  type StreamEnvelope,
} from "@butui/stream";

function record(lineId: string, text = lineId): SpillRecord {
  return {
    streamId: "stream-1",
    lineId,
    text,
    digest: "00000000",
    stableAtRevision: 1,
    bytes: Buffer.byteLength(text),
  };
}

function envelope(seq: number, delta: string): StreamEnvelope {
  return {
    sessionId: "retention-test",
    streamId: "stream-1",
    seq,
    baseRevision: seq - 1,
    kind: "text",
    priority: 1,
    op: { type: "append", delta },
    createdAt: seq,
  };
}

describe("v0.2 retention defaults", () => {
  test("默认预算冻结且保持单层配置", () => {
    expect(Object.isFrozen(DEFAULT_RETENTION_POLICY)).toBe(true);
    expect(DEFAULT_RETENTION_POLICY).toEqual({
      hotBytes: 4 * 1024 * 1024,
      keepTailLines: 256,
      appliedCacheChunks: 64,
      indexCacheChunks: 64,
      compactAfterDeletes: 10_000,
    });
  });

  test("FileSpillStore flush 持久化 numeric index sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "butui-retention-"));
    const path = join(dir, "spill.ndjson");
    const indexPath = join(dir, "index");
    try {
      const store = new FileSpillStore(path, {
        indexPath,
        indexCacheChunks: 1,
      });
      store.writeMany([record("line-1"), record("line-2")]);
      store.flush();

      const indexFile = join(
        indexPath,
        `${encodeURIComponent("stream-1")}.${encodeURIComponent("line-")}.idx`
      );
      expect(existsSync(indexFile)).toBe(true);

      store.dispose({ remove: true });
      expect(existsSync(path)).toBe(false);
      expect(existsSync(indexFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleanupSidecars=true 在 dispose 时清理 spill / applied sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butui-retention-cleanup-"));
    const spillPath = join(dir, "spill.ndjson");
    const indexPath = join(dir, "index");
    const appliedPath = join(dir, "applied.bin");
    const store = new FileSpillStore(spillPath, { indexPath });
    const ledger = new StreamLedger({
      memory: new MemoryLedger({ totalBytes: 128 }),
      memoryOwner: "retention-test",
      spill: { store, policy: { maxBytes: 0 } },
      appliedStorePath: appliedPath,
      appliedCacheChunks: 1,
      cleanupSidecars: true,
    });
    ledger.open({
      streamId: "stream-1",
      kind: "text",
      priority: 1,
      createdAt: 0,
    });

    try {
      for (let seq = 1; seq <= 200; seq++) {
        const result = await ledger.applyWithSpill(
          envelope(seq, `line-${seq}\n`)
        );
        expect(result.status).toBe("applied");
      }
      expect(existsSync(spillPath)).toBe(true);

      ledger.dispose();
      expect(existsSync(spillPath)).toBe(false);
      expect(existsSync(`${appliedPath}.stream-1`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
