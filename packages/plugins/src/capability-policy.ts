import path from "node:path";
import type {
  WorkerCapabilityAuthorization,
  WorkerCapabilityAuthorizer,
  WorkerCapabilityRequest,
} from "./capability-proxy.ts";

export interface PathPrefixAuthorizerOptions {
  roots: readonly string[];
  cwd?: string;
  /** 默认取 args[0]；也可以指定参数下标或自定义提取器。 */
  pathArg?: number | ((request: WorkerCapabilityRequest) => unknown);
  /** 默认 path.resolve(cwd, value)，便于测试或自定义虚拟路径空间。 */
  resolve?: (value: string) => string;
}

/**
 * 词法路径前缀策略。
 *
 * 这是 capability 级 defense-in-depth，不解析 symlink；需要真实文件系统隔离时，
 * 仍应使用 realpath / fd-based API 或 OS sandbox。
 */
export function createPathPrefixAuthorizer(
  options: PathPrefixAuthorizerOptions
): WorkerCapabilityAuthorizer {
  if (options.roots.length === 0) {
    throw new Error("[butui] path capability requires at least one root");
  }
  const cwd = options.cwd ?? process.cwd();
  const resolve =
    options.resolve ?? ((value: string) => path.resolve(cwd, value));
  const roots = options.roots.map(resolve);
  const pathArg = options.pathArg ?? 0;

  return request => {
    const value =
      typeof pathArg === "function"
        ? pathArg(request)
        : request.args[pathArg];
    if (typeof value !== "string") {
      return {
        allowed: false,
        reason: "path argument must be a string",
      };
    }
    const candidate = resolve(value);
    for (const root of roots) {
      if (isWithin(root, candidate)) return true;
    }
    return {
      allowed: false,
      reason: `path outside allowed roots: ${candidate}`,
    };
  };
}

export interface RateLimitAuthorizerOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export function createRateLimitAuthorizer(
  options: RateLimitAuthorizerOptions
): WorkerCapabilityAuthorizer {
  if (!Number.isFinite(options.limit) || options.limit < 1) {
    throw new Error("[butui] rate limit must be a positive finite number");
  }
  if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
    throw new Error("[butui] rate window must be a positive finite number");
  }
  const limit = Math.floor(options.limit);
  const windowMs = Math.floor(options.windowMs);
  const now = options.now ?? (() => performance.now());
  const hits = new Map<string, number[]>();

  return (request: WorkerCapabilityRequest): WorkerCapabilityAuthorization => {
    const timestamp = now();
    const key = `${request.pluginId}\0${request.method}`;
    const values = hits.get(key) ?? [];
    const cutoff = timestamp - windowMs;
    let expired = 0;
    while (expired < values.length && values[expired]! <= cutoff) expired++;
    if (expired > 0) values.splice(0, expired);

    if (values.length >= limit) {
      return {
        allowed: false,
        reason: `rate limit exceeded: ${limit}/${windowMs}ms`,
      };
    }
    values.push(timestamp);
    hits.set(key, values);
    return true;
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
