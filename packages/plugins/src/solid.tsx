import type { JSX } from "@butui/solid/jsx-runtime";
import {
  children,
  createErrorBoundary,
  createMemo,
  createSignal,
  For,
  merge,
  omit,
  onCleanup,
} from "solid-js";
import {
  createSlotRegistry,
  type SlotRegistry,
  type SlotRegistryOptions,
} from "./registry.ts";
import type {
  Plugin,
  PluginContext,
  PluginErrorEvent,
  ResolvedSlotRenderer,
  SlotMode,
} from "./types.ts";

type SlotMap = object;
type AnySlotProps<TSlots extends SlotMap> = TSlots[keyof TSlots];

export type SolidPlugin<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
> = Plugin<JSX.Element, TSlots, TContext>;

export type SolidSlotProps<
  TSlots extends SlotMap,
  K extends keyof TSlots,
  TContext extends PluginContext = PluginContext,
> = {
  registry: SlotRegistry<JSX.Element, TSlots, TContext>;
  name: K;
  mode?: SlotMode;
  children?: JSX.Element;
  pluginFailurePlaceholder?: (failure: PluginErrorEvent) => JSX.Element;
} & TSlots[K];

export type SolidBoundSlotProps<
  TSlots extends SlotMap,
  K extends keyof TSlots,
> = {
  name: K;
  mode?: SlotMode;
  children?: JSX.Element;
} & TSlots[K];

export type SolidRegistrySlotComponent<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
> = <K extends keyof TSlots>(
  props: SolidSlotProps<TSlots, K, TContext>
) => JSX.Element;

export type SolidSlotComponent<TSlots extends SlotMap> = <
  K extends keyof TSlots,
>(
  props: SolidBoundSlotProps<TSlots, K>
) => JSX.Element;

export interface SolidSlotOptions {
  pluginFailurePlaceholder?: (failure: PluginErrorEvent) => JSX.Element;
}

const RESERVED_SLOT_KEYS = [
  "registry",
  "name",
  "mode",
  "children",
  "pluginFailurePlaceholder",
] as const;

/**
 * 创建绑定到某个宿主的 Solid 注册表。
 *
 * 同一个 host 上只会存在一个 `solid:slot-registry`；多次调用会返回同一实例，
 * 因此应用壳和插件都从同一份注册表解析。
 */
export function createSolidSlotRegistry<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
>(
  host: object,
  context: TContext,
  options: SlotRegistryOptions = {}
): SlotRegistry<JSX.Element, TSlots, TContext> {
  return createSlotRegistry<JSX.Element, TSlots, TContext>(
    host,
    "solid:slot-registry",
    context,
    options
  );
}

/**
 * 把注册表绑定成一个只接收 Slot 数据的组件。
 *
 * ```tsx
 * const Header = createSlot(registry);
 * <Header name="header" title="buTUI" />
 * ```
 */
export function createSlot<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
>(
  registry: SlotRegistry<JSX.Element, TSlots, TContext>,
  options: SolidSlotOptions = {}
): SolidSlotComponent<TSlots> {
  return function BoundSlot<K extends keyof TSlots>(
    props: SolidBoundSlotProps<TSlots, K>
  ): JSX.Element {
    return Slot(
      merge(props, {
        registry,
        pluginFailurePlaceholder: options.pluginFailurePlaceholder,
      }) as SolidSlotProps<TSlots, K, TContext>
    );
  };
}

/**
 * 通用 Slot。
 *
 * 默认 `append`：先渲染 `children` fallback，再按插件顺序追加。
 * `replace`：有插件贡献时只渲染插件，否则回退到 children。
 * `single_winner`：只渲染第一个插件，输出为空时回退。
 */
export function Slot<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
  K extends keyof TSlots = keyof TSlots,
>(props: SolidSlotProps<TSlots, K, TContext>): JSX.Element {
  const registry = (): SlotRegistry<JSX.Element, TSlots, TContext> =>
    props.registry;
  const [version, setVersion] = createSignal(0);
  const unsubscribe = registry().subscribe(() =>
    setVersion(current => current + 1)
  );
  onCleanup(unsubscribe);

  let previousEntries: Array<
    ResolvedSlotRenderer<JSX.Element, AnySlotProps<TSlots>, TContext>
  > = [];
  const entries = createMemo<
    Array<ResolvedSlotRenderer<JSX.Element, AnySlotProps<TSlots>, TContext>>
  >(() => {
    version();
    const resolved = registry().resolveEntries(
      props.name
    ) as Array<
      ResolvedSlotRenderer<JSX.Element, AnySlotProps<TSlots>, TContext>
    >;
    if (resolved.length === 0) {
      return previousEntries.length === 0 ? previousEntries : (previousEntries = []);
    }

    const previousById = new Map(
      previousEntries.map(entry => [entry.id, entry])
    );
    const nextEntries = resolved.map(entry => {
      const previous = previousById.get(entry.id);
      return previous && previous.renderer === entry.renderer
        ? previous
        : entry;
    });
    const unchanged =
      nextEntries.length === previousEntries.length &&
      nextEntries.every((entry, index) => entry === previousEntries[index]);
    return unchanged ? previousEntries : (previousEntries = nextEntries);
  });
  const entryIds = createMemo(() => entries().map(entry => entry.id));
  const entriesById = createMemo(
    () => new Map(entries().map(entry => [entry.id, entry]))
  );
  const resolvedFallback = children(() => props.children);
  const renderFallback = (): JSX.Element => resolvedFallback() ?? null;
  const slotProps = omit(props, ...RESERVED_SLOT_KEYS) as AnySlotProps<TSlots>;

  const renderFailure = (
    pluginId: string,
    error: unknown,
    fallbackOnError?: () => JSX.Element
  ): JSX.Element => {
    const failure = registry().reportPluginError({
      pluginId,
      slot: String(props.name),
      phase: "render",
      source: "solid",
      error,
    });

    const placeholder = props.pluginFailurePlaceholder;
    if (placeholder) {
      try {
        return placeholder(failure);
      } catch (placeholderError) {
        registry().reportPluginError({
          pluginId,
          slot: String(props.name),
          phase: "error_placeholder",
          source: "solid",
          error: placeholderError,
        });
      }
    }

    return fallbackOnError ? fallbackOnError() : null;
  };

  const renderEntry = (
    entry: ResolvedSlotRenderer<
      JSX.Element,
      AnySlotProps<TSlots>,
      TContext
    >,
    fallbackOnError?: () => JSX.Element
  ): JSX.Element => {
    const boundary = createErrorBoundary(
      () => {
        const initial = entry.renderer(
          registry().context,
          slotProps as AnySlotProps<TSlots>
        );
        const resolved = children(() => initial);
        const hasOutput = resolved
          .toArray()
          .some(node => node !== null && node !== undefined && node !== false);
        if (!hasOutput) {
          return fallbackOnError ? fallbackOnError() : null;
        }
        return resolved();
      },
      (error: () => unknown) =>
        renderFailure(entry.id, error(), fallbackOnError)
    );
    return boundary as unknown as JSX.Element;
  };

  const content = createMemo<JSX.Element>(() => {
    const resolved = entries();
    const mode = props.mode ?? "append";
    if (resolved.length === 0) return renderFallback();

    if (mode === "single_winner") {
      const winner = resolved[0];
      return winner ? renderEntry(winner, renderFallback) : renderFallback();
    }

    if (mode === "replace") {
      const rendered = resolved.map(entry => renderEntry(entry));
      const hasPluginOutput = rendered.some(
        node => node !== null && node !== undefined && node !== false
      );
      return hasPluginOutput ? rendered : renderFallback();
    }

    return [
      renderFallback(),
      <For each={entryIds()}>
        {entryId => {
          const entry = entriesById().get(entryId);
          return entry ? renderEntry(entry, renderFallback) : null;
        }}
      </For>,
    ];
  });

  return content as unknown as JSX.Element;
}
