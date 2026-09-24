import type {
  Plugin,
  PluginContext,
  PluginErrorEvent,
  PluginErrorReport,
  ResolvedSlotRenderer,
  SlotRenderer,
} from "./types.ts";

const DEFAULT_DEBUG_PLUGIN_ERRORS = false;
const DEFAULT_MAX_PLUGIN_ERRORS = 100;
const noop = (): void => {};

export interface SlotRegistryOptions {
  /** 开发排查用：把插件错误同步写到 stderr。默认关闭。 */
  onPluginError?: (event: PluginErrorEvent) => void;
  debugPluginErrors?: boolean;
  /** 最多保留多少条错误事件，默认 100。 */
  maxPluginErrors?: number;
}

interface PluginEntry<
  TNode,
  TSlots extends object,
  TContext extends PluginContext,
> {
  plugin: Plugin<TNode, TSlots, TContext>;
  registrationOrder: number;
  cachedOrder: number;
  cachedId: string;
  setupCleanup?: () => void;
}

/**
 * 插件 Slot 注册表。
 *
 * 设计目标是让「应用壳」和「功能贡献」解耦：应用只声明 Slot 的位置，插件
 * 通过 `slots` 提供片段，注册 / 卸载都走同一套响应式通知。它是纯 TS 的，
 * 不绑定终端、Solid 或任何具体 renderer。
 */
export class SlotRegistry<
  TNode,
  TSlots extends object,
  TContext extends PluginContext = PluginContext,
> {
  private readonly hostInstance: object;
  private readonly hostContext: TContext;
  private plugins: Array<PluginEntry<TNode, TSlots, TContext>> = [];
  private sortedPluginsCache: Array<PluginEntry<TNode, TSlots, TContext>> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly errorListeners = new Set<(event: PluginErrorEvent) => void>();
  private pluginErrors: PluginErrorEvent[] = [];
  private registrationOrder = 0;
  private batchDepth = 0;
  private batchedNotify = false;
  private options: Required<Omit<SlotRegistryOptions, "onPluginError">> &
    Pick<SlotRegistryOptions, "onPluginError">;
  private isDisposed = false;

  constructor(
    host: object,
    context: TContext,
    options: SlotRegistryOptions = {}
  ) {
    this.hostInstance = host;
    this.hostContext = context;
    this.options = {
      debugPluginErrors: options.debugPluginErrors ?? DEFAULT_DEBUG_PLUGIN_ERRORS,
      maxPluginErrors: options.maxPluginErrors ?? DEFAULT_MAX_PLUGIN_ERRORS,
      onPluginError: options.onPluginError,
    };
  }

  /** 宿主对象。Solid / runtime / headless 测试都只需要一个稳定对象。 */
  get host(): object {
    return this.hostInstance;
  }

  get context(): Readonly<TContext> {
    return this.hostContext;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  configure(options: SlotRegistryOptions): void {
    if ("debugPluginErrors" in options) {
      this.options.debugPluginErrors =
        options.debugPluginErrors ?? DEFAULT_DEBUG_PLUGIN_ERRORS;
    }
    if ("maxPluginErrors" in options) {
      this.options.maxPluginErrors =
        options.maxPluginErrors ?? DEFAULT_MAX_PLUGIN_ERRORS;
    }
    if ("onPluginError" in options) {
      this.options.onPluginError = options.onPluginError;
    }
  }

  /**
   * 注册一个插件。
   *
   * 返回的函数只卸载这次注册的条目；即使同一 id 被重新注册，也不会误删新条目。
   * `setup` 失败时不会留下半注册状态，并返回 no-op。
   */
  register(plugin: Plugin<TNode, TSlots, TContext>): () => void {
    this.assertActive();
    if (!plugin.id) throw new Error("Plugin id must be a non-empty string");
    if (this.plugins.some(entry => entry.plugin.id === plugin.id)) {
      throw new Error(`Plugin with id "${plugin.id}" is already registered`);
    }

    let setupCleanup: (() => void) | undefined;
    try {
      const result = plugin.setup?.(this.hostContext, this.hostInstance);
      if (typeof result === "function") setupCleanup = result;
    } catch (error) {
      this.reportPluginError({
        pluginId: plugin.id,
        phase: "setup",
        source: "registry",
        error,
      });
      return noop;
    }

    const entry: PluginEntry<TNode, TSlots, TContext> = {
      plugin,
      registrationOrder: this.registrationOrder++,
      cachedOrder: plugin.order ?? 0,
      cachedId: plugin.id,
      ...(setupCleanup ? { setupCleanup } : {}),
    };
    this.plugins.push(entry);
    this.invalidateSortedPluginsCache();
    this.notifyListeners();
    return () => {
      this.unregisterEntry(entry);
    };
  }

  unregister(id: string): boolean {
    const entry = this.plugins.find(item => item.plugin.id === id);
    if (!entry) return false;
    return this.unregisterEntry(entry);
  }

  updateOrder(id: string, order: number): boolean {
    const entry = this.plugins.find(item => item.plugin.id === id);
    if (!entry) return false;
    if ((entry.plugin.order ?? 0) === order) return true;
    entry.plugin.order = order;
    entry.cachedOrder = order;
    this.invalidateSortedPluginsCache();
    this.notifyListeners();
    return true;
  }

  clear(): void {
    if (this.plugins.length === 0) return;
    const entries = this.plugins;
    this.plugins = [];
    this.invalidateSortedPluginsCache();
    for (const entry of entries) this.disposeEntry(entry);
    this.notifyListeners();
  }

  /** 清空插件、监听器和错误缓存。之后不能再次注册。 */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.clear();
    this.listeners.clear();
    this.errorListeners.clear();
  }

  subscribe(listener: () => void): () => void {
    if (this.isDisposed) return noop;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onPluginError(listener: (event: PluginErrorEvent) => void): () => void {
    if (this.isDisposed) return noop;
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /**
   * 把一组注册 / 卸载合并成一次通知。
   *
   * 适合应用启动时批量注册插件，避免 Solid `<Slot>` 连续重建多次。
   */
  batch<T>(run: () => T): T {
    this.batchDepth += 1;
    try {
      return run();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batchedNotify) {
        this.batchedNotify = false;
        this.flushListeners();
      }
    }
  }

  getPluginErrors(): readonly PluginErrorEvent[] {
    return this.pluginErrors;
  }

  clearPluginErrors(): void {
    this.pluginErrors = [];
  }

  reportPluginError(report: PluginErrorReport): PluginErrorEvent {
    const event: PluginErrorEvent = {
      pluginId: report.pluginId,
      ...(report.slot !== undefined ? { slot: report.slot } : {}),
      phase: report.phase,
      source: report.source ?? "registry",
      error: normalizeError(report.error),
      timestamp: Date.now(),
    };

    this.pluginErrors.push(event);
    if (this.pluginErrors.length > this.options.maxPluginErrors) {
      this.pluginErrors.splice(
        0,
        this.pluginErrors.length - this.options.maxPluginErrors
      );
    }

    if (this.options.debugPluginErrors) {
      const slotLabel = event.slot ? ` slot="${event.slot}"` : "";
      console.debug(
        `[SlotRegistry][PluginError] plugin="${event.pluginId}" ` +
          `phase="${event.phase}" source="${event.source}"${slotLabel}`
      );
      console.debug(event.error);
    }

    for (const listener of this.errorListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Error in plugin error listener:", error);
      }
    }

    try {
      this.options.onPluginError?.(event);
    } catch (error) {
      console.error("Error in plugin error callback:", error);
    }

    return event;
  }

  resolve<K extends keyof TSlots>(
    slot: K
  ): Array<SlotRenderer<TNode, TSlots[K], TContext>> {
    return this.resolveEntries(slot).map(entry => entry.renderer);
  }

  resolveEntries<K extends keyof TSlots>(
    slot: K
  ): Array<ResolvedSlotRenderer<TNode, TSlots[K], TContext>> {
    const result: Array<ResolvedSlotRenderer<TNode, TSlots[K], TContext>> = [];
    for (const entry of this.getSortedPlugins()) {
      const renderer = entry.plugin.slots[slot] as
        | SlotRenderer<TNode, TSlots[K], TContext>
        | undefined;
      if (renderer) {
        result.push({ id: entry.plugin.id, renderer });
      }
    }
    return result;
  }

  private unregisterEntry(
    entry: PluginEntry<TNode, TSlots, TContext>
  ): boolean {
    const index = this.plugins.indexOf(entry);
    if (index === -1) return false;
    this.plugins.splice(index, 1);
    this.invalidateSortedPluginsCache();
    this.disposeEntry(entry);
    this.notifyListeners();
    return true;
  }

  private disposeEntry(entry: PluginEntry<TNode, TSlots, TContext>): void {
    if (entry.setupCleanup) {
      try {
        entry.setupCleanup();
      } catch (error) {
        this.reportPluginError({
          pluginId: entry.plugin.id,
          phase: "dispose",
          source: "registry",
          error,
        });
      }
    }

    try {
      entry.plugin.dispose?.();
    } catch (error) {
      this.reportPluginError({
        pluginId: entry.plugin.id,
        phase: "dispose",
        source: "registry",
        error,
      });
    }
  }

  private getSortedPlugins(): Array<PluginEntry<TNode, TSlots, TContext>> {
    this.syncPluginSortMetadata();
    if (this.sortedPluginsCache) return this.sortedPluginsCache;
    this.sortedPluginsCache = [...this.plugins].sort((left, right) => {
      if (left.cachedOrder !== right.cachedOrder) {
        return left.cachedOrder - right.cachedOrder;
      }
      if (left.registrationOrder !== right.registrationOrder) {
        return left.registrationOrder - right.registrationOrder;
      }
      return left.cachedId.localeCompare(right.cachedId);
    });
    return this.sortedPluginsCache;
  }

  private syncPluginSortMetadata(): void {
    let changed = false;
    for (const entry of this.plugins) {
      const nextOrder = entry.plugin.order ?? 0;
      const nextId = entry.plugin.id;
      if (entry.cachedOrder !== nextOrder || entry.cachedId !== nextId) {
        entry.cachedOrder = nextOrder;
        entry.cachedId = nextId;
        changed = true;
      }
    }
    if (changed) this.invalidateSortedPluginsCache();
  }

  private invalidateSortedPluginsCache(): void {
    this.sortedPluginsCache = null;
  }

  private notifyListeners(): void {
    if (this.batchDepth > 0) {
      this.batchedNotify = true;
      return;
    }
    this.flushListeners();
  }

  private flushListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Error in slot registry listener:", error);
      }
    }
  }

  private assertActive(): void {
    if (this.isDisposed) throw new Error("SlotRegistry is disposed");
  }
}

const stores = new WeakMap<object, Map<string, SlotRegistry<any, any, any>>>();

/**
 * 获取（或创建）宿主对象上的命名注册表。
 *
 * 同一个 host + key 必须复用同一个 context 对象；传不同 context 会直接抛错，
 * 避免两个子系统各拿一份“看似相同”的注册表却收不到彼此的插件。
 */
export function createSlotRegistry<
  TNode,
  TSlots extends object,
  TContext extends PluginContext = PluginContext,
>(
  host: object,
  key: string,
  context: TContext,
  options: SlotRegistryOptions = {}
): SlotRegistry<TNode, TSlots, TContext> {
  let store = stores.get(host);
  if (!store) {
    store = new Map();
    stores.set(host, store);
  }

  const existing = store.get(key) as
    | SlotRegistry<TNode, TSlots, TContext>
    | undefined;
  if (existing && !existing.disposed) {
    if (existing.context !== context) {
      throw new Error(
        `createSlotRegistry called with a different context for host key "${key}". ` +
          "Reuse the original context object."
      );
    }
    existing.configure(options);
    return existing;
  }

  const created = new SlotRegistry<TNode, TSlots, TContext>(
    host,
    context,
    options
  );
  store.set(key, created);
  return created;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error(`Unknown plugin error: ${String(error)}`);
}
