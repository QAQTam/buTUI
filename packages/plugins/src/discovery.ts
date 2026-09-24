import path from "node:path";
import { readdir } from "node:fs/promises";
import type { PluginConfigEntry } from "./config.ts";
import {
  readPluginManifest,
  type PluginManifest,
} from "./manifest.ts";

export interface DiscoverPluginsOptions {
  /** 项目根目录，默认 `process.cwd()`。 */
  cwd?: string;
  /** 额外扫描的插件包目录（每个目录本身是一个插件包）。 */
  extraDirs?: readonly string[];
  /**
   * 是否扫描 node_modules 中所有包。
   *
   * 默认只检查项目 `dependencies` / `optionalDependencies` 声明的包；设置为
   * true 时会扫描全部已安装包，适合插件市场 / 调试环境。
   */
  includeAllInstalled?: boolean;
}

export interface DiscoveredPlugin {
  /** 可直接交给 `loadPlugins()` 的模块说明符。 */
  module: string;
  /** 插件包根目录。 */
  dir: string;
  /** manifest 文件路径。 */
  manifestPath: string;
  manifest: PluginManifest;
}

export interface PluginDiscoveryResult {
  plugins: readonly DiscoveredPlugin[];
  /** 已转换成配置条目的结果，可直接传给 `loadPlugins({ entries })`。 */
  entries: readonly PluginConfigEntry[];
}

/**
 * 从项目直接依赖与额外目录中发现带 buTUI manifest 的插件包。
 *
 * 默认不扫描所有 node_modules，避免把传递依赖里的插件意外加载进来；需要时
 * 打开 `includeAllInstalled`。
 */
export async function discoverPlugins(
  options: DiscoverPluginsOptions = {}
): Promise<PluginDiscoveryResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const found = new Map<string, DiscoveredPlugin>();

  for (const dir of options.extraDirs ?? []) {
    const absolute = path.resolve(cwd, dir);
    const plugin = await inspectPackage(absolute, absolute);
    if (plugin) {
      found.set(
        plugin.dir,
        await withAbsoluteModule(plugin)
      );
    }
  }

  const nodeModules = path.join(cwd, "node_modules");
  if (options.includeAllInstalled) {
    for (const candidate of await scanInstalled(nodeModules)) {
      const plugin = await inspectPackage(candidate.dir, candidate.module);
      if (plugin) found.set(plugin.dir, plugin);
    }
  } else {
    for (const name of await declaredDependencies(cwd)) {
      const dir = path.join(nodeModules, ...name.split("/"));
      const plugin = await inspectPackage(dir, name);
      if (plugin) found.set(plugin.dir, plugin);
    }
  }

  const plugins = [...found.values()].sort(comparePlugins);
  return {
    plugins,
    entries: plugins.map(plugin => ({
      module: plugin.module,
      ...(plugin.manifest.id !== undefined ? { id: plugin.manifest.id } : {}),
      ...(plugin.manifest.order !== undefined
        ? { order: plugin.manifest.order }
        : {}),
    })),
  };
}

async function inspectPackage(
  dir: string,
  module: string
): Promise<DiscoveredPlugin | null> {
  const manifestFile = await readPluginManifest(dir);
  if (!manifestFile) return null;
  return {
    module,
    dir: manifestFile.dir,
    manifestPath: manifestFile.path,
    manifest: manifestFile.manifest,
  };
}

async function withAbsoluteModule(
  plugin: DiscoveredPlugin
): Promise<DiscoveredPlugin> {
  return {
    ...plugin,
    module: path.resolve(plugin.dir, plugin.manifest.entry),
  };
}

async function declaredDependencies(cwd: string): Promise<string[]> {
  const packagePath = path.join(cwd, "package.json");
  if (!(await Bun.file(packagePath).exists())) return [];
  const packageJson: unknown = await Bun.file(packagePath).json();
  if (!isRecord(packageJson)) return [];

  const names = new Set<string>();
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const value = packageJson[field];
    if (!isRecord(value)) continue;
    for (const name of Object.keys(value)) names.add(name);
  }
  return [...names];
}

async function scanInstalled(
  nodeModules: string
): Promise<Array<{ dir: string; module: string }>> {
  let entries;
  try {
    entries = await readdir(nodeModules, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: Array<{ dir: string; module: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(nodeModules, entry.name);
      let scoped;
      try {
        scoped = await readdir(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of scoped) {
        if (!child.isDirectory() || child.name.startsWith(".")) continue;
        result.push({
          dir: path.join(scopeDir, child.name),
          module: `${entry.name}/${child.name}`,
        });
      }
      continue;
    }
    result.push({
      dir: path.join(nodeModules, entry.name),
      module: entry.name,
    });
  }
  return result;
}

function comparePlugins(left: DiscoveredPlugin, right: DiscoveredPlugin): number {
  const order = (left.manifest.order ?? 0) - (right.manifest.order ?? 0);
  if (order !== 0) return order;
  const leftId = left.manifest.id ?? left.module;
  const rightId = right.manifest.id ?? right.module;
  return leftId.localeCompare(rightId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
