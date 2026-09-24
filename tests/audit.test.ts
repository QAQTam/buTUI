import { describe, expect, test } from "bun:test";
import {
  createFileAuditLog,
  createMemoryAuditLog,
  readAuditLog,
} from "@butui/plugins";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  test("memory 上限只保留最新事件，但 seq 不倒退", () => {
    const audit = createMemoryAuditLog({ maxEvents: 2, now: () => 1 });
    audit.record({ type: "a" });
    audit.record({ type: "b" });
    audit.record({ type: "c" });

    expect(audit.size).toBe(3);
    expect(audit.query().map(event => event.seq)).toEqual([2, 3]);
  });
});
