import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface CgroupCpuLimit {
  quotaUs: number;
  periodUs?: number;
}

export interface CgroupLimits {
  memoryMaxBytes?: number;
  cpuMax?: CgroupCpuLimit | string;
  pidsMax?: number;
}

export interface CgroupSupport {
  available: boolean;
  version: "v2" | "unsupported";
  root: string;
  reason?: string;
}

export interface CgroupLease {
  readonly name: string;
  readonly path: string;
  readonly limits: Readonly<CgroupLimits>;
  readonly released: boolean;
  release(options?: { kill?: boolean }): Promise<void>;
}

export interface CgroupRecoveryReport {
  recovered: readonly string[];
  failed: ReadonlyArray<{ path: string; error: Error }>;
}

export interface CgroupFs {
  access(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

export interface CgroupManagerOptions {
  /** cgroup v2 mount root；默认 /sys/fs/cgroup。 */
  root?: string;
  /** 仅管理带此前缀的目录；默认 butui-。 */
  prefix?: string;
  fs?: CgroupFs;
  /** kill 后删除目录的尝试次数；默认 5。 */
  releaseRetries?: number;
  /** 删除重试间隔；默认 10ms。 */
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface CgroupManager {
  readonly root: string;
  readonly prefix: string;
  detect(): Promise<CgroupSupport>;
  create(name: string, limits?: CgroupLimits): Promise<CgroupLease>;
  recover(): Promise<CgroupRecoveryReport>;
  releaseAll(): Promise<void>;
}

const defaultFs: CgroupFs = {
  async access(value) {
    await fs.access(value, fsConstants.W_OK);
  },
  async readFile(value) {
    return fs.readFile(value, "utf8");
  },
  async writeFile(value, data) {
    await fs.writeFile(value, data, "utf8");
  },
  async mkdir(value) {
    await fs.mkdir(value);
  },
  async rm(value) {
    await fs.rm(value, { recursive: true, force: true });
  },
  async readdir(value) {
    return fs.readdir(value);
  },
};

export function createCgroupManager(
  options: CgroupManagerOptions = {}
): CgroupManager {
  const root = path.resolve(options.root ?? "/sys/fs/cgroup");
  const prefix = options.prefix ?? "butui-";
  const io = options.fs ?? defaultFs;
  const releaseRetries = normalizeRetries(options.releaseRetries ?? 5);
  const retryDelayMs = normalizeDelay(options.retryDelayMs ?? 10);
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  const leases = new Map<string, MutableCgroupLease>();

  const detect = async (): Promise<CgroupSupport> => {
    try {
      await io.access(root);
      await io.readFile(path.join(root, "cgroup.controllers"));
      return { available: true, version: "v2", root };
    } catch (error) {
      return {
        available: false,
        version: "unsupported",
        root,
        reason: asError(error).message,
      };
    }
  };

  const create = async (
    name: string,
    limits: CgroupLimits = {}
  ): Promise<CgroupLease> => {
    const support = await detect();
    if (!support.available) {
      throw new Error(`[butui] cgroup v2 unavailable: ${support.reason}`);
    }
    const normalizedName = normalizeName(name);
    const normalizedLimits = normalizeLimits(limits);
    const target = path.join(root, `${prefix}${normalizedName}`);
    await io.mkdir(target);
    try {
      await writeLimits(io, target, normalizedLimits);
    } catch (error) {
      await removeWithRetry(io, target, releaseRetries, retryDelayMs, sleep).catch(
        () => {}
      );
      throw error;
    }

    let released = false;
    const lease: MutableCgroupLease = {
      name: normalizedName,
      path: target,
      limits: Object.freeze({ ...normalizedLimits }),
      get released() {
        return released;
      },
      async release(releaseOptions = {}) {
        if (released) return;
        if (releaseOptions.kill !== false) {
          await io.writeFile(path.join(target, "cgroup.kill"), "1").catch(() => {});
        }
        await removeWithRetry(
          io,
          target,
          releaseRetries,
          retryDelayMs,
          sleep
        );
        released = true;
        leases.delete(target);
      },
    };
    leases.set(target, lease);
    return lease;
  };

  const recover = async (): Promise<CgroupRecoveryReport> => {
    const recovered: string[] = [];
    const failed: Array<{ path: string; error: Error }> = [];
    let entries: string[];
    try {
      entries = await io.readdir(root);
    } catch (error) {
      return {
        recovered,
        failed: [{ path: root, error: asError(error) }],
      };
    }

    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const target = path.join(root, entry);
      try {
        await io.writeFile(path.join(target, "cgroup.kill"), "1").catch(() => {});
        await removeWithRetry(
          io,
          target,
          releaseRetries,
          retryDelayMs,
          sleep
        );
        recovered.push(target);
      } catch (error) {
        failed.push({ path: target, error: asError(error) });
      }
    }
    return { recovered, failed };
  };

  const releaseAll = async (): Promise<void> => {
    const errors: Error[] = [];
    for (const lease of [...leases.values()]) {
      try {
        await lease.release();
      } catch (error) {
        errors.push(asError(error));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "[butui] failed to release cgroups");
    }
  };

  return {
    root,
    prefix,
    detect,
    create,
    recover,
    releaseAll,
  };
}

interface MutableCgroupLease extends CgroupLease {
  released: boolean;
}

async function writeLimits(
  io: CgroupFs,
  target: string,
  limits: CgroupLimits
): Promise<void> {
  if (limits.memoryMaxBytes !== undefined) {
    await io.writeFile(
      path.join(target, "memory.max"),
      String(limits.memoryMaxBytes)
    );
  }
  if (limits.cpuMax !== undefined) {
    await io.writeFile(
      path.join(target, "cpu.max"),
      typeof limits.cpuMax === "string"
        ? limits.cpuMax
        : `${limits.cpuMax.quotaUs} ${limits.cpuMax.periodUs ?? 100_000}`
    );
  }
  if (limits.pidsMax !== undefined) {
    await io.writeFile(path.join(target, "pids.max"), String(limits.pidsMax));
  }
}

function normalizeLimits(limits: CgroupLimits): CgroupLimits {
  return {
    ...(limits.memoryMaxBytes !== undefined
      ? {
          memoryMaxBytes: positiveInteger(
            limits.memoryMaxBytes,
            "memoryMaxBytes"
          ),
        }
      : {}),
    ...(limits.cpuMax !== undefined
      ? { cpuMax: normalizeCpuLimit(limits.cpuMax) }
      : {}),
    ...(limits.pidsMax !== undefined
      ? { pidsMax: positiveInteger(limits.pidsMax, "pidsMax") }
      : {}),
  };
}

function normalizeCpuLimit(value: CgroupCpuLimit | string): CgroupCpuLimit | string {
  if (typeof value === "string") {
    if (!/^(max|\d+)(\s+\d+)?$/.test(value)) {
      throw new Error("[butui] cpuMax string must match 'max|quota [period]'");
    }
    return value;
  }
  return {
    quotaUs: positiveInteger(value.quotaUs, "cpuMax.quotaUs"),
    periodUs:
      value.periodUs === undefined
        ? 100_000
        : positiveInteger(value.periodUs, "cpuMax.periodUs"),
  };
}

function normalizeName(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(
      "[butui] cgroup name may only contain letters, digits, '.', '_' and '-'"
    );
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[butui] ${name} must be a positive finite number`);
  }
  return Math.floor(value);
}

async function removeWithRetry(
  io: CgroupFs,
  target: string,
  retries: number,
  delayMs: number,
  sleep: (delayMs: number) => Promise<void>
): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await io.rm(target);
      return;
    } catch (error) {
      lastError = asError(error);
      if (attempt + 1 < retries) await sleep(delayMs);
    }
  }
  throw lastError ?? new Error(`[butui] failed to remove cgroup: ${target}`);
}

function normalizeRetries(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("[butui] releaseRetries must be a positive finite number");
  }
  return Math.max(1, Math.floor(value));
}

function normalizeDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("[butui] retryDelayMs must be a non-negative finite number");
  }
  return Math.floor(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
