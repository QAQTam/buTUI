import { describe, expect, test } from "bun:test";
import {
  createAuditDeduper,
  createAuditOrderBuffer,
  createAuditReceiver,
  createFileAuditLog,
  createFileAuditOrderStore,
  createHttpAuditSink,
  createMemoryAuditLog,
  openPersistentAuditReceiver,
  readAuditLog,
  verifyAuditEvents,
  withAuditSinks,
} from "@butui/plugins";
import type { AuditEvent, AuditRotationSummary } from "@butui/plugins";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function sourceEvent(
  sourceId: string,
  sourceSeq: number,
  seq: number
): AuditEvent {
  return { seq, at: 1, type: "event", sourceId, sourceSeq };
}

describe("audit log", () => {
  test("memory log 维护 seq / at 并支持查询过滤", () => {
    const audit = createMemoryAuditLog({ now: () => 100 });
    audit.record({ type: "capability.granted", pluginId: "a" });
    audit.record({ type: "capability.denied", pluginId: "b", at: 200 });

    expect(audit.size).toBe(2);
    expect(audit.query()).toEqual([
      { type: "capability.granted", pluginId: "a", seq: 1, at: 100 },
      { type: "capability.denied", pluginId: "b", seq: 2, at: 200 },
    ]);
    expect(audit.query({ pluginId: "a" })).toHaveLength(1);
    expect(audit.query({ type: "capability.denied" })).toHaveLength(1);
    expect(audit.query({ since: 150 })).toEqual([
      { type: "capability.denied", pluginId: "b", seq: 2, at: 200 },
    ]);
  });

  test("hash chain 可检测篡改与重排", () => {
    const audit = createMemoryAuditLog({ now: () => 1, hashChain: true });
    const first = audit.record({ type: "a" });
    const second = audit.record({ type: "b" });

    expect(first.prevHash).toBe("");
    expect(first.hash).toHaveLength(64);
    expect(second.prevHash).toBe(first.hash);
    expect(verifyAuditEvents(audit.query())).toMatchObject({
      valid: true,
      events: 2,
      headHash: second.hash,
    });

    const tampered = audit.query().map(event =>
      event.seq === 2 ? { ...event, type: "tampered" } : event
    );
    expect(verifyAuditEvents(tampered)).toMatchObject({
      valid: false,
      failedSeq: 2,
      error: "hash mismatch",
    });
    expect(verifyAuditEvents([second, first])).toMatchObject({
      valid: false,
      failedSeq: 2,
      error: "prevHash mismatch",
    });
  });

  test("HMAC signature 使用独立密钥校验", () => {
    const audit = createMemoryAuditLog({
      now: () => 1,
      signatureKey: "secret",
    });
    audit.record({ type: "a" });
    audit.record({ type: "b" });

    expect(verifyAuditEvents(audit.query(), { signatureKey: "secret" }).valid).toBe(
      true
    );
    expect(verifyAuditEvents(audit.query(), { signatureKey: "wrong" })).toMatchObject(
      {
        valid: false,
        error: "signature mismatch",
      }
    );
  });

  test("file log 持久化 NDJSON，可从磁盘重新查询", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "butui-audit-"));
    const file = path.join(dir, "audit.ndjson");
    const audit = createFileAuditLog({
      path: file,
      now: () => 100,
    });
    try {
      audit.record({ type: "cgroup.created", path: "/cgroup/a" });
      audit.record({ type: "cgroup.released", path: "/cgroup/a" });
      await audit.flush();

      expect(await readAuditLog(file)).toEqual([
        {
          type: "cgroup.created",
          path: "/cgroup/a",
          seq: 1,
          at: 100,
        },
        {
          type: "cgroup.released",
          path: "/cgroup/a",
          seq: 2,
          at: 100,
        },
      ]);
      expect(await readAuditLog(file, { type: "cgroup.released" })).toEqual([
        {
          type: "cgroup.released",
          path: "/cgroup/a",
          seq: 2,
          at: 100,
        },
      ]);
    } finally {
      await audit.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("file log 超过大小后 rotation，并保留 summary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "butui-audit-"));
    const file = path.join(dir, "audit.ndjson");
    const summaries: AuditRotationSummary[] = [];
    const audit = createFileAuditLog({
      path: file,
      maxFileBytes: 90,
      retainedFiles: 2,
      now: () => 100,
      hashChain: true,
      onRotate(summary) {
        summaries.push(summary);
      },
    });
    try {
      audit.record({ type: "event.one", payload: "x".repeat(20) });
      await audit.flush();
      audit.record({ type: "event.two", payload: "x".repeat(20) });
      await audit.flush();

      const rotated = (await fs.readdir(dir)).filter(entry =>
        entry.startsWith("audit.ndjson.")
      );
      expect(rotated).toHaveLength(1);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        path: file,
        events: 1,
      });

      const oldEvents = await readAuditLog(path.join(dir, rotated[0]!));
      expect(oldEvents.map(event => event.type)).toEqual(["event.one"]);
      const current = await readAuditLog(file);
      expect(current.map(event => event.type)).toEqual([
        "event.two",
        "audit.rotated",
      ]);
      expect(verifyAuditEvents([...oldEvents, ...current])).toMatchObject({
        valid: true,
        events: 3,
      });
    } finally {
      await audit.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("AuditSink fan-out 批量发送 NDJSON，失败后指数退避重试", async () => {
    const requests: Array<{
      url: string;
      body: string;
      headers: Record<string, string>;
    }> = [];
    let failures = 2;
    const delays: number[] = [];
    const sink = createHttpAuditSink({
      url: "https://audit.example/ingest",
      async fetch(url, init) {
        requests.push({
          url: String(url),
          body: String(init?.body ?? ""),
          headers: init?.headers as Record<string, string>,
        });
        if (failures-- > 0) {
          return new Response("retry", { status: 503 });
        }
        return new Response(null, { status: 204 });
      },
    });
    const audit = withAuditSinks(
      createMemoryAuditLog({ now: () => 1 }),
      [sink],
      {
        maxRetries: 2,
        retryDelayMs: 10,
        async sleep(delay) {
          delays.push(delay);
        },
      }
    );
    audit.record({ type: "capability.granted", pluginId: "p" });
    audit.record({ type: "capability.denied", pluginId: "p" });

    await audit.flush();
    expect(requests).toHaveLength(3);
    expect(delays).toEqual([10, 20]);
    expect(requests[2]!.url).toBe("https://audit.example/ingest");
    expect(requests[2]!.headers["x-butui-audit-count"]).toBe("2");
    expect(requests[2]!.headers["x-butui-audit-batch"]).toMatch(
      /^1-2-[0-9a-f]{16}$/
    );
    expect(
      requests[2]!.body
        .trim()
        .split("\n")
        .map(line => JSON.parse(line).type)
    ).toEqual(["capability.granted", "capability.denied"]);
    await audit.dispose();
  });

  test("partial ack 只重试未确认尾部，并尊重 retryAfterMs", async () => {
    const calls: number[][] = [];
    const delays: number[] = [];
    const sink = {
      async write(events: readonly { seq: number }[]) {
        calls.push(events.map(event => event.seq));
        if (calls.length === 1) {
          return {
            committedSeq: events[0]!.seq,
            accepted: 1,
            retry: true,
            retryAfterMs: 7,
          };
        }
        return {
          committedSeq: events[events.length - 1]!.seq,
          accepted: events.length,
        };
      },
    };
    const audit = withAuditSinks(
      createMemoryAuditLog({ now: () => 1 }),
      [sink],
      {
        maxRetries: 1,
        retryDelayMs: 100,
        async sleep(delay) {
          delays.push(delay);
        },
      }
    );
    audit.record({ type: "a" });
    audit.record({ type: "b" });
    audit.record({ type: "c" });

    await audit.flush();
    expect(calls).toEqual([
      [1, 2, 3],
      [2, 3],
    ]);
    expect(delays).toEqual([7]);
    await audit.dispose();
  });

  test("deduper 按 seq + hash 丢弃重复批次", () => {
    const audit = createMemoryAuditLog({
      now: () => 1,
      hashChain: true,
    });
    audit.record({ type: "a" });
    audit.record({ type: "b" });
    const deduper = createAuditDeduper({ maxEntries: 2 });

    expect(deduper.accept(audit.query()).map(event => event.seq)).toEqual([
      1, 2,
    ]);
    expect(deduper.accept(audit.query())).toEqual([]);
    expect(deduper.size).toBe(2);
  });

  test("order buffer 按 sourceSeq 暂存缺口并在补齐后连续提交", () => {
    const receiver = createAuditReceiver();
    const first = receiver.receive([
      sourceEvent("a", 2, 2),
      sourceEvent("b", 1, 3),
    ]);
    expect(first.committed.map(event => event.seq)).toEqual([3]);
    expect(first.pending.map(event => event.seq)).toEqual([2]);
    expect(first.gaps).toEqual([{ sourceId: "a", from: 1, to: 1 }]);
    expect(first.ack).toMatchObject({
      accepted: 1,
      retry: true,
      missing: [{ sourceId: "a", from: 1, to: 1 }],
    });

    const second = receiver.receive([sourceEvent("a", 1, 1)]);
    expect(second.committed.map(event => event.sourceSeq)).toEqual([1, 2]);
    expect(second.gaps).toEqual([]);
    expect(second.ack).toMatchObject({ accepted: 2 });
    expect(second.ack.retry).toBeUndefined();
    expect(second.watermarks).toEqual({ a: 2, b: 1 });
  });

  test("order buffer 丢弃 watermark 以下和重复 pending", () => {
    const buffer = createAuditOrderBuffer();
    expect(buffer.accept([sourceEvent("a", 1, 1)]).committed).toHaveLength(1);
    expect(buffer.accept([sourceEvent("a", 1, 2)]).duplicates).toHaveLength(1);

    const pending = buffer.accept([sourceEvent("a", 3, 3)]);
    expect(pending.pending).toHaveLength(1);
    expect(pending.gaps).toEqual([{ sourceId: "a", from: 2, to: 2 }]);
    expect(buffer.accept([sourceEvent("a", 3, 4)]).duplicates).toHaveLength(1);
  });

  test("order buffer TTL 过期 pending，避免永久保留缺口", () => {
    let now = 0;
    const buffer = createAuditOrderBuffer({
      pendingTtlMs: 10,
      now: () => now,
    });
    expect(buffer.accept([sourceEvent("a", 2, 2)]).pending).toHaveLength(1);

    now = 11;
    const result = buffer.accept([sourceEvent("b", 1, 3)]);
    expect(result.expired.map(event => event.sourceSeq)).toEqual([2]);
    expect(result.pending).toEqual([]);
    expect(result.watermarks).toEqual({ b: 1 });
  });

  test("order buffer 容量上限淘汰最旧 pending，compact 清除完成 source", () => {
    const buffer = createAuditOrderBuffer({ maxPendingPerSource: 1 });
    const evicted = buffer.accept([
      sourceEvent("a", 2, 2),
      sourceEvent("a", 3, 3),
    ]);
    expect(evicted.evicted.map(event => event.sourceSeq)).toEqual([2]);
    expect(evicted.pending.map(event => event.sourceSeq)).toEqual([3]);

    const completed = createAuditOrderBuffer();
    completed.accept([sourceEvent("a", 1, 1)]);
    expect(completed.watermark("a")).toBe(1);
    expect(completed.compact("a")).toBe(true);
    expect(completed.watermark("a")).toBe(0);
    expect(completed.accept([sourceEvent("a", 1, 2)]).committed).toHaveLength(1);
    expect(completed.compact("missing")).toBe(false);
  });

  test("persistent receiver 重启后恢复 watermark 与 pending 缺口", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "butui-order-"));
    const file = path.join(dir, "order.json");
    const store = createFileAuditOrderStore({ path: file });
    try {
      const first = await openPersistentAuditReceiver({ store });
      expect(first.receive([sourceEvent("a", 2, 2)]).gaps).toEqual([
        { sourceId: "a", from: 1, to: 1 },
      ]);
      await first.flush();

      const second = await openPersistentAuditReceiver({ store });
      const result = second.receive([sourceEvent("a", 1, 1)]);
      expect(result.committed.map(event => event.sourceSeq)).toEqual([1, 2]);
      expect(result.gaps).toEqual([]);
      await second.flush();

      expect(await store.load()).toEqual({
        watermarks: { a: 2 },
        pending: [],
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("memory 上限只保留最新事件，但 seq 不倒退", () => {
    const audit = createMemoryAuditLog({ maxEvents: 2, now: () => 1 });
    audit.record({ type: "a" });
    audit.record({ type: "b" });
    audit.record({ type: "c" });

    expect(audit.size).toBe(3);
    expect(audit.query().map(event => event.seq)).toEqual([2, 3]);
  });
});
