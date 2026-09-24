import type { AuditLog } from "./audit.ts";
import { safeRecordAudit } from "./audit.ts";
import type { CgroupLease } from "./cgroup.ts";
import { attachProcessRpc } from "./process-rpc.ts";
import type {
  NdjsonRpcEndpoint,
  ProcessRpcSubprocess,
} from "./process-rpc.ts";

export interface ProcessRpcResourcePolicy {
  /** Bun.spawn timeout；到点后按 killSignal 终止。 */
  timeoutMs?: number;
  /** stdout + stderr 总输出上限，映射到 Bun.spawn maxBuffer。 */
  maxOutputBytes?: number;
  /** stdout 单帧上限，映射到 NDJSON endpoint。 */
  maxFrameBytes?: number;
  /** stdout bytes/s token bucket 上限，由 host 侧强制。 */
  maxBytesPerSecond?: number;
  killSignal?: string | number;
  /**
   * 已有 cgroup 目录、fd 或 manager lease。
   *
   * 传 lease 时会在子进程退出后自动 release；字符串 / fd 只透传给 Bun。
   */
  cgroup?: string | number | CgroupLease;
}

export interface SpawnProcessRpcOptions {
  cmd: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  resources?: ProcessRpcResourcePolicy;
  onStderr?: (chunk: string) => void;
  audit?: AuditLog;
}

export interface SpawnedProcessRpcProcess extends ProcessRpcSubprocess {
  readonly pid: number;
  resourceUsage(): unknown;
}

export interface SpawnedProcessRpc {
  process: SpawnedProcessRpcProcess;
  endpoint: NdjsonRpcEndpoint;
  cgroup?: CgroupLease;
}

/**
 * 创建带资源策略的 Bun 子进程 RPC。
 *
 * timeout / maxBuffer 由 Bun 直接执行；maxBytesPerSecond 由 host 侧监控并 kill。
 * heap / CPU / pids 的硬上限依赖外部 cgroup 配置，本函数只负责传递 cgroup。
 */
export function spawnProcessRpc(
  options: SpawnProcessRpcOptions
): SpawnedProcessRpc {
  const resources = options.resources ?? {};
  const cgroupLease = isCgroupLease(resources.cgroup)
    ? resources.cgroup
    : undefined;
  const cgroupTarget: string | number | undefined = cgroupLease
    ? cgroupLease.path
    : typeof resources.cgroup === "string" ||
        typeof resources.cgroup === "number"
      ? resources.cgroup
      : undefined;
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn({
      cmd: [...options.cmd],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(resources.timeoutMs !== undefined
        ? { timeout: normalizePositive(resources.timeoutMs, "timeoutMs") }
        : {}),
      ...(resources.maxOutputBytes !== undefined
        ? {
            maxBuffer: normalizePositive(
              resources.maxOutputBytes,
              "maxOutputBytes"
            ),
          }
        : {}),
      ...(resources.killSignal !== undefined
        ? { killSignal: resources.killSignal }
        : {}),
      ...(cgroupTarget !== undefined ? { cgroup: cgroupTarget } : {}),
    });
  } catch (error) {
    safeRecordAudit(options.audit, {
      type: "process.spawn_failed",
      cmd: [...options.cmd],
      error: asError(error).message,
    });
    if (cgroupLease) void cgroupLease.release().catch(() => {});
    throw error;
  }
  if (!child.stdin || !child.stdout) {
    if (cgroupLease) void cgroupLease.release().catch(() => {});
    throw new Error("[butui] spawnProcessRpc requires pipe stdio");
  }

  safeRecordAudit(options.audit, {
    type: "process.started",
    pid: child.pid,
    cmd: [...options.cmd],
    ...(cgroupTarget !== undefined ? { cgroup: String(cgroupTarget) } : {}),
  });
  void child.exited
    .then(code => {
      safeRecordAudit(options.audit, {
        type: "process.exited",
        pid: child.pid,
        code,
      });
      if (code !== 0) {
        safeRecordAudit(options.audit, {
          type: "process.killed",
          pid: child.pid,
          code,
        });
      }
    })
    .catch(error => {
      safeRecordAudit(options.audit, {
        type: "process.exit_error",
        pid: child.pid,
        error: asError(error).message,
      });
    });

  if (cgroupLease) {
    void child.exited
      .then(() => cgroupLease.release())
      .catch(() => cgroupLease.release())
      .catch(() => {});
  }

  const endpoint = attachProcessRpc(child, {
    ...(resources.maxFrameBytes !== undefined
      ? { maxFrameBytes: resources.maxFrameBytes }
      : {}),
    ...(resources.maxOutputBytes !== undefined
      ? { maxTotalBytes: resources.maxOutputBytes }
      : {}),
    ...(resources.maxBytesPerSecond !== undefined
      ? {
          maxBytesPerSecond: normalizePositive(
            resources.maxBytesPerSecond,
            "maxBytesPerSecond"
          ),
        }
      : {}),
  });
  endpoint.addEventListener("error", event => {
    const error = (event as ErrorEvent).error;
    safeRecordAudit(options.audit, {
      type: "process.error",
      pid: child.pid,
      error: error?.message ?? (event as ErrorEvent).message ?? "process error",
    });
  });

  if (child.stderr) {
    void pumpStderr(child.stderr, options.onStderr);
  }

  return {
    process: child,
    endpoint,
    ...(cgroupLease ? { cgroup: cgroupLease } : {}),
  };
}

async function pumpStderr(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text && onChunk) onChunk(text);
    }
    const tail = decoder.decode();
    if (tail && onChunk) onChunk(tail);
  } catch {
    // stderr 是诊断通道；读取失败不能覆盖 RPC 的主状态。
  } finally {
    reader.releaseLock();
  }
}

function normalizePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[butui] ${name} must be a positive finite number`);
  }
  return Math.floor(value);
}

function isCgroupLease(value: unknown): value is CgroupLease {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { release?: unknown }).release === "function"
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
