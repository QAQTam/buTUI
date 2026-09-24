import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  normalizePluginEntries,
  type PluginConfigEntry,
  type PluginConfigInput,
} from "./config.ts";
import {
  findPluginManifest,
  resolveManifestEntry,
  type PluginManifest,
} from "./manifest.ts";
import type { SlotRegistry } from "./registry.ts";
import type {
  Plugin,
  PluginContext,
  PluginErrorEvent,
} from "./types.ts";

export interface PluginLoadContext<TContext extends PluginContext = PluginContext> {
  /** 配置 / manifest 推导出的 id；工厂可以用它注册资源。 */
  id: string;
  /** 原始模块说明符（相对路径或包名）。 */
  module: string;
  /** 实际加载的文件绝对路径。 */
  path: string;
  /** 配置解析基准目录。 */
  cwd: string;
  /** 该条目的自定义 options。 */
  options: unknown;
  /** 应用共享上下文。 */
  context: Readonly<TContext>;
  /** 如果插件包提供了 manifest，会一并传入。 */
  manifest?: PluginManifest;
}

export type PluginModuleFactory<
  TNode,
  TSlots extends object,
  TContext extends PluginContext = PluginContext,
> = (
  load: PluginLoadContext<TContext>
) =>
  | Plugin<TNode, TSlots, TContext>
  | Promise<Plugin<TNode, TSlots, TContext>>;

export type PluginModuleExport<
  TNode,
  TSlots extends object,
  TContext extends PluginContext = PluginContext,
> =
  | Plugin<TNode, TSlots, TContext>
  | PluginModuleFactory<TNode, TSlots, TContext>;

export interface LoadPluginsOptions<
  TNode,
  TSlots extends object,
  TContext extends PluginContext = PluginContext,
> {
  registry: SlotRegistry<TNode, TSlots, TContext>;
  host: object;
  context: TContext;
  /** 配置对象、条目数组，或已经规范化的条目数组。 */
  entries: PluginConfigInput;
  /** 相对模块解析基准，默认 `process.cwd()`。 */
  cwd?: string;
  /** 测试 / 自定义 bundler 注入点；默认用原生 `import()`。 */
  importer?: (url: string) => Promise<unknown>;
}

export interface LoadedPlugins {
  ids: readonly string[];
  errors: readonly PluginErrorEvent[];
  /** 只卸载本次 load 成功注册的插件，逆序执行。 */
  dispose(): void;
}

/**
 * 加载并注册一批插件。
 *
 * 单条插件失败只会进入 registry 的错误缓存和返回的 `errors`，不会中断后面的
 * 插件。配置语法错误、重复 id、模块不存在、工厂抛错都走这一条隔离路径。
 */
export async function loadPlugins<
  TNode,
  TSlots extends object,
  TContext extends PluginContext = PluginContext,
>(
  options: LoadPluginsOptions<TNode, TSlots, TContext>
): Promise<LoadedPlugins> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (options.registry.host !== options.host) {
    throw new Error("loadPlugins: registry.host must be the same object as options.host");
  }
  const entries = normalizePluginEntries(options.entries);
  const importer =
    options.importer ?? ((url: string) => import(url) as Promise<unknown>);
  const ids: string[] = [];
  const errors: PluginErrorEvent[] = [];
  const disposers: Array<() => void> = [];

  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const label = entry.id ?? entry.module;
    try {
      const resolved = await resolvePluginEntry(entry, cwd);
      const module = await importer(pathToFileURL(resolved.path).href);
      const candidate = extractPluginExport(module);
      if (candidate === undefined) {
        throw new Error(
          `Plugin module "${entry.module}" did not export a plugin (expected default, named "plugin", or a factory)`
        );
      }

      const provisionalId =
        entry.id ?? resolved.manifest?.id ?? entry.module;
      const loadContext: PluginLoadContext<TContext> = {
        id: provisionalId,
        module: entry.module,
        path: resolved.path,
        cwd,
        options: entry.options,
        context: options.context,
        ...(resolved.manifest ? { manifest: resolved.manifest } : {}),
      };

      const loaded =
        typeof candidate === "function"
          ? await candidate(loadContext)
          : candidate;
      if (!isPlugin<TNode, TSlots, TContext>(loaded)) {
        throw new Error(
          `Plugin module "${entry.module}" returned an invalid plugin`
        );
      }

      const plugin: Plugin<TNode, TSlots, TContext> = {
        ...loaded,
        id: entry.id ?? loaded.id ?? resolved.manifest?.id ?? entry.module,
        order:
          entry.order ?? resolved.manifest?.order ?? loaded.order,
      };

      const errorStart = options.registry.getPluginErrors().length;
      const dispose = options.registry.register(plugin);
      if (!options.registry.has(plugin.id)) {
        errors.push(...options.registry.getPluginErrors().slice(errorStart));
        continue;
      }

      ids.push(plugin.id);
      disposers.push(dispose);
    } catch (error) {
      const event = options.registry.reportPluginError({
        pluginId: label,
        phase: "load",
        source: "loader",
        error,
      });
      errors.push(event);
    }
  }

  let disposed = false;
  return {
    ids,
    errors,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

async function resolvePluginEntry(
  entry: PluginConfigEntry,
  cwd: string
): Promise<{ path: string; manifest?: PluginManifest }> {
  let resolved = resolveModule(entry.module, cwd);
  const manifestFile = await findPluginManifest(path.dirname(resolved));
  if (manifestFile) {
    const manifestEntry = resolveManifestEntry(manifestFile);
    if (await Bun.file(manifestEntry).exists()) resolved = manifestEntry;
    return { path: resolved, manifest: manifestFile.manifest };
  }
  return { path: resolved };
}

function resolveModule(specifier: string, cwd: string): string {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (path.isAbsolute(specifier)) return specifier;
  return Bun.resolveSync(specifier, cwd);
}

function extractPluginExport(module: unknown): unknown {
  if (!isRecord(module)) return module;
  if ("plugin" in module) return module.plugin;
  if ("default" in module) return module.default;
  return module;
}

type LoadedPlugin<
  TNode,
  TSlots extends object,
  TContext extends PluginContext,
> = Omit<Plugin<TNode, TSlots, TContext>, "id"> & { id?: string };

function isPlugin<
  TNode,
  TSlots extends object,
  TContext extends PluginContext,
>(value: unknown): value is LoadedPlugin<TNode, TSlots, TContext> {
  return isRecord(value) && isRecord(value.slots);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export * from "./config.ts";
export * from "./manifest.ts";
