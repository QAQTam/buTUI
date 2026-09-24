/**
 * 插件协议。
 *
 * 这套接口参考 OpenTUI 的 `Plugin` / `SlotRegistry`，但实现完全不依赖原生
 * 代码：宿主只需要是一个对象，Slot 返回的节点类型由调用方决定。Solid 适配
 * 在 `@butui/plugins/solid`，纯文本 / headless / 其他 renderer 可以直接使用
 * 根入口。
 */

export type PluginContext = object;

/**
 * 插件能力名。
 *
 * 这是**加载同意门**，不是沙箱：loader 会在动态 import 前检查 manifest 声明的
 * 能力，但没有能力在运行时阻断插件调用任意 Bun API。只应加载受信任代码。
 */
export type PluginCapability =
  | "slots"
  | "fs:read"
  | "fs:write"
  | "network"
  | "process"
  | (string & {});

export const PLUGIN_CAPABILITIES = {
  slots: "slots",
  fsRead: "fs:read",
  fsWrite: "fs:write",
  network: "network",
  process: "process",
} as const satisfies Record<string, PluginCapability>;

/** 多个插件贡献同一个 Slot 时的合成方式。 */
export type SlotMode = "append" | "replace" | "single_winner";

export type PluginErrorPhase =
  | "load"
  | "setup"
  | "render"
  | "dispose"
  | "error_placeholder";

/** `"registry"` / `"core"` 是内置来源；第三方适配器可以传自己的字符串。 */
export type PluginErrorSource = "registry" | "core" | (string & {});

export interface PluginErrorEvent {
  pluginId: string;
  slot?: string;
  phase: PluginErrorPhase;
  source: PluginErrorSource;
  error: Error;
  timestamp: number;
}

export interface PluginErrorReport {
  pluginId: string;
  slot?: string;
  phase: PluginErrorPhase;
  source?: PluginErrorSource;
  error: unknown;
}

/**
 * Slot 渲染函数。
 *
 * `context` 是宿主共享的只读上下文；`props` 是该 Slot 的贡献数据。
 */
export type SlotRenderer<
  TNode,
  TProps,
  TContext extends PluginContext = PluginContext,
> = (ctx: Readonly<TContext>, props: TProps) => TNode;

/**
 * 一个插件。
 *
 * `setup` 只在注册成功前执行一次；返回的函数会作为该插件自己的清理函数，
 * 在卸载时先于 `dispose` 执行。这样插件可以把运行时订阅和静态清理分开写。
 */
export interface Plugin<
  TNode,
  TSlots extends object,
  TContext extends PluginContext = PluginContext,
> {
  id: string;
  /** 越小越先执行；相同 order 按注册顺序，再按 id 字典序稳定排序。 */
  order?: number;
  setup?: (ctx: Readonly<TContext>, host: object) => void | (() => void);
  dispose?: () => void;
  slots: {
    [K in keyof TSlots]?: SlotRenderer<TNode, TSlots[K], TContext>;
  };
}

export interface ResolvedSlotRenderer<
  TNode,
  TProps,
  TContext extends PluginContext = PluginContext,
> {
  id: string;
  renderer: SlotRenderer<TNode, TProps, TContext>;
}
