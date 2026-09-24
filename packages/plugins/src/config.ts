import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginCapability } from "./types.ts";

/**
 * 单条插件配置。
 *
 * `module` 是相对配置文件的路径或包名。`id` / `order` 可覆盖 manifest 与插件
 * 自身的默认值，方便同一模块注册多个实例（配合工厂插件）。
 */
export interface PluginConfigEntry {
  module: string;
  id?: string;
  order?: number;
  enabled?: boolean;
  options?: unknown;
  /** 本条目的能力白名单；缺省时使用 loader 的 `allowedCapabilities`。 */
  capabilities?: readonly PluginCapability[];
}

export interface ButuiPluginConfig {
  plugins?: ReadonlyArray<string | PluginConfigEntry>;
}

export type PluginConfigInput =
  | ButuiPluginConfig
  | ReadonlyArray<string | PluginConfigEntry>;

/** identity helper：让配置文件获得类型提示，不改变运行时对象。 */
export function definePluginConfig(config: ButuiPluginConfig): ButuiPluginConfig {
  return config;
}

/** 把字符串简写和完整条目统一成 `PluginConfigEntry[]`。 */
export function normalizePluginEntries(
  input: PluginConfigInput
): PluginConfigEntry[] {
  const raw: ReadonlyArray<string | PluginConfigEntry> = Array.isArray(input)
    ? input
    : ((input as ButuiPluginConfig).plugins ?? []);
  return raw.map((entry, index) => normalizeEntry(entry, index));
}

/**
 * 读取 `butui.config.json` / `butui.config.ts` / `butui.config.js`。
 *
 * TS / JS 模块支持 `export default`，也支持直接导出 `plugins` 数组。
 */
export async function readPluginConfig(
  file: string,
  cwd: string = process.cwd()
): Promise<ButuiPluginConfig> {
  const resolved = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  if (!(await Bun.file(resolved).exists())) {
    throw new Error(`buTUI plugin config not found: ${resolved}`);
  }

  let loaded: unknown;
  if (path.extname(resolved).toLowerCase() === ".json") {
    loaded = await Bun.file(resolved).json();
  } else {
    const module: unknown = await import(pathToFileURL(resolved).href);
    loaded =
      isRecord(module) && module.default !== undefined ? module.default : module;
  }

  if (!isRecord(loaded)) {
    throw new Error(`Invalid buTUI plugin config at ${resolved}: expected object`);
  }
  if (loaded.plugins !== undefined && !Array.isArray(loaded.plugins)) {
    throw new Error(
      `Invalid buTUI plugin config at ${resolved}: "plugins" must be an array`
    );
  }

  return {
    ...(loaded.plugins !== undefined
      ? { plugins: loaded.plugins as Array<string | PluginConfigEntry> }
      : {}),
  };
}

function normalizeEntry(
  value: string | PluginConfigEntry,
  index: number
): PluginConfigEntry {
  if (typeof value === "string") {
    if (!value) throw new Error(`Plugin entry #${index}: module must be non-empty`);
    return { module: value };
  }
  if (!isRecord(value)) {
    throw new Error(`Plugin entry #${index}: expected string or object`);
  }
  const module = value.module;
  if (typeof module !== "string" || module.length === 0) {
    throw new Error(`Plugin entry #${index}: "module" must be a non-empty string`);
  }
  if (value.id !== undefined && (typeof value.id !== "string" || !value.id)) {
    throw new Error(`Plugin entry #${index}: "id" must be a non-empty string`);
  }
  if (value.order !== undefined && !Number.isFinite(value.order)) {
    throw new Error(`Plugin entry #${index}: "order" must be a finite number`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`Plugin entry #${index}: "enabled" must be boolean`);
  }
  const capabilities = normalizeCapabilities(value.capabilities, index);

  return {
    module,
    ...(value.id !== undefined ? { id: value.id as string } : {}),
    ...(value.order !== undefined ? { order: value.order as number } : {}),
    ...(value.enabled !== undefined ? { enabled: value.enabled as boolean } : {}),
    ...("options" in value ? { options: value.options } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

function normalizeCapabilities(
  value: unknown,
  index: number
): PluginCapability[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) {
    throw new Error(
      `Plugin entry #${index}: "capabilities" must be an array of non-empty strings`
    );
  }
  return [...new Set(value as string[])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
