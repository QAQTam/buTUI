import { describe, expect, test } from "bun:test";
import { createCgroupManager, createMemoryAuditLog } from "@butui/plugins";
import type { CgroupFs } from "@butui/plugins";

const ROOT = "/sys/fs/cgroup";

class MemoryCgroupFs implements CgroupFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly writes: Array<{ path: string; data: string }> = [];
  writable = true;
  rmFailures = 0;

  constructor() {
    this.dirs.add(ROOT);
    this.files.set(`${ROOT}/cgroup.controllers`, "cpu memory pids\n");
  }

  async access(path: string): Promise<void> {
    if (!this.writable) throw new Error("EACCES: permission denied");
    if (!this.dirs.has(path) && !this.files.has(path)) {
      throw new Error(`ENOENT: ${path}`);
    }
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data);
    this.writes.push({ path, data });
  }

  async mkdir(path: string): Promise<void> {
    if (this.dirs.has(path)) throw new Error(`EEXIST: ${path}`);
    this.dirs.add(path);
  }

  async rm(path: string): Promise<void> {
    if (this.rmFailures > 0) {
      this.rmFailures--;
      throw new Error("EBUSY: cgroup still populated");
    }
    const prefix = `${path}/`;
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(prefix)) this.files.delete(key);
    }
    for (const key of [...this.dirs]) {
      if (key === path || key.startsWith(prefix)) this.dirs.delete(key);
    }
  }

  async readdir(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of [...this.dirs, ...this.files.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes("/")) names.add(rest);
    }
    return [...names];
  }
}

describe("cgroup manager", () => {
  test("无写权限时明确 unsupported，不伪造硬限制", async () => {
    const io = new MemoryCgroupFs();
    io.writable = false;
    const manager = createCgroupManager({ root: ROOT, fs: io });

    const support = await manager.detect();
    expect(support).toMatchObject({
      available: false,
      version: "unsupported",
      root: ROOT,
    });
    await expect(manager.create("plugin")).rejects.toThrow(
      "cgroup v2 unavailable"
    );
  });

  test("create 写入 memory / cpu / pids，release 先 kill 再删除", async () => {
    const io = new MemoryCgroupFs();
    const audit = createMemoryAuditLog({ now: () => 1 });
    const manager = createCgroupManager({ root: ROOT, fs: io, audit });
    const lease = await manager.create("plugin", {
      memoryMaxBytes: 64 * 1024 * 1024,
      cpuMax: { quotaUs: 50_000, periodUs: 100_000 },
      pidsMax: 8,
    });
    const target = `${ROOT}/butui-plugin`;

    expect(lease.path).toBe(target);
    expect(io.files.get(`${target}/memory.max`)).toBe("67108864");
    expect(io.files.get(`${target}/cpu.max`)).toBe("50000 100000");
    expect(io.files.get(`${target}/pids.max`)).toBe("8");
    expect(lease.released).toBe(false);

    await lease.release();
    expect(io.writes).toContainEqual({
      path: `${target}/cgroup.kill`,
      data: "1",
    });
    expect(io.dirs.has(target)).toBe(false);
    expect(lease.released).toBe(true);
    expect(audit.query().map(event => event.type)).toEqual([
      "cgroup.created",
      "cgroup.released",
    ]);
  });

  test("release 对 EBUSY 重试后删除", async () => {
    const io = new MemoryCgroupFs();
    io.rmFailures = 2;
    const manager = createCgroupManager({
      root: ROOT,
      fs: io,
      sleep: async () => {},
    });
    const lease = await manager.create("retry", { pidsMax: 4 });

    await lease.release();
    expect(lease.released).toBe(true);
    expect(io.dirs.has(`${ROOT}/butui-retry`)).toBe(false);
  });

  test("recover 只清理自有前缀的 stale cgroup", async () => {
    const io = new MemoryCgroupFs();
    io.dirs.add(`${ROOT}/butui-old`);
    io.dirs.add(`${ROOT}/butui-old/child`);
    io.dirs.add(`${ROOT}/other`);
    const audit = createMemoryAuditLog({ now: () => 2 });
    const manager = createCgroupManager({ root: ROOT, fs: io, audit });

    const report = await manager.recover();
    expect(report.recovered).toEqual([`${ROOT}/butui-old`]);
    expect(report.failed).toEqual([]);
    expect(io.dirs.has(`${ROOT}/butui-old`)).toBe(false);
    expect(io.dirs.has(`${ROOT}/other`)).toBe(true);
    expect(audit.query({ type: "cgroup.recovered" })).toHaveLength(1);
  });

  test("拒绝路径穿越和非法 limit", async () => {
    const io = new MemoryCgroupFs();
    const manager = createCgroupManager({ root: ROOT, fs: io });
    await expect(manager.create("../escape")).rejects.toThrow(
      "cgroup name may only contain"
    );
    await expect(manager.create("plugin", { pidsMax: 0 })).rejects.toThrow(
      "pidsMax must be a positive"
    );
  });
});
