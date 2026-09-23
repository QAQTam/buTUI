/**
 * `<List>` / `<VirtualList>` —— SPEC §10.1。
 *
 * 应用只需要给「数据 + 选择模型 + 每行怎么画」，剩下的滚动跟随、虚拟化、
 * 按键、鼠标、空状态都在这里。
 *
 * ```tsx
 * const sel = createSelection({ count: () => files().length, onChange: i => preview(i) });
 * <List
 *   items={files()}
 *   selection={sel}
 *   height={12}
 *   renderItem={item => <text color={...}>{item}</text>}
 *   onActivate={item => open(item)}
 * />
 * ```
 *
 * **为什么 `List` 和 `VirtualList` 是同一份实现。** 两者只差「窗口开多大」：
 * `List` 渲染全部条目、靠外层裁剪（适合几十行的菜单）；`VirtualList` 只渲染
 * 可见的 `viewport` 行（适合上万条的历史 / 文件树）。渲染路径完全一样，
 * 都用 Solid 2 的 `<Repeat count from>` —— 它在窗口整体平移时会**复用重叠区间
 * 的节点**，所以往下滚一行是「建一行 + 销毁一行」，与总条数无关。
 *
 * 三条实现约束：
 *
 * 1. **不能按「创建时快照」渲染行**。`<Repeat>` 只在 `count` / `from` 变化时
 *    重跑，`items` 换了但长度没变时它一行都不重建 —— 所以行内容必须读
 *    `items()[index]` 这种访问器，让 Solid 自己去追依赖。写成
 *    `renderItem(items[i])` 会让「同长度的过滤结果」显示成上一批数据。
 * 2. **窗口顶部是组件自己的状态**，不是从选中项推出来的。用户滚开之后，
 *    只要不动选中项，窗口就不该被弹回去（`followScroll` 保证这一点）。
 * 3. **高度必须显式**。没有 `height` 就没有视口，也就没有「跟随滚动」可言，
 *    这时退化成「全部渲染 + 交给父容器滚动」。
 */
import { type KeyEvent, type MouseEvent, type Node } from "@butui/core";
import { useFocusScope } from "@butui/solid";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Repeat, Show, createEffect, createSignal } from "solid-js";
import { followScroll, type Selection } from "./selection.ts";

export interface ListItemState {
  /**
   * 这一行当前是否选中。
   *
   * 是**访问器**不是布尔值：行节点只创建一次，选中态要能就地更新。这样
   * 「移动一格」只会让两行的文本节点重算，而不是重建整个列表。
   */
  selected: () => boolean;
}

export interface ListProps<T> {
  items: readonly T[];
  selection: Selection;
  /**
   * 画一行。返回的内容接在标记符后面，行本身的颜色 / 背景 / 语义由 `<List>`
   * 负责。`state.selected()` 用于「选中时才显示」的附加内容。
   */
  renderItem: (item: T, index: number, state: ListItemState) => unknown;
  /** 视口高度（cell 行）。不传 = 不裁剪、不跟随滚动 */
  height?: number;
  /** 每行占几行 cell，默认 1 */
  itemHeight?: number;
  /**
   * 只渲染可见窗口。默认 false。
   *
   * `<VirtualList>` 等价于 `virtual`，只是名字更直白。窗口外的条目**不存在于
   * 节点树里**，所以行内组件（编辑器、图片）在滚出视口时会被卸载。
   */
  virtual?: boolean;
  /** 选中行的标记符，默认 `>` */
  marker?: string;
  /** 未选中行的文字颜色，默认 muted */
  color?: string;
  /** 选中行的文字颜色，默认 focus */
  selectedColor?: string;
  /** 选中行的背景（整行铺满）。不设则只变色不铺底 */
  selectedBg?: string;
  /** 挂载后自动聚焦 */
  autoFocus?: boolean;
  /** 点击某行是否顺带把焦点交给列表，默认 true */
  focusOnClick?: boolean;
  /** 点击某行是否等同于 Enter（选中 + 激活），默认 false（只选中） */
  activateOnClick?: boolean;
  /** 滚轮一次移动几格，默认 1 */
  wheelStep?: number;
  /** Enter 激活 */
  onActivate?: (item: T, index: number) => void;
  /** 额外按键处理：先于选择模型；返回 true 表示已消费 */
  onKey?: (event: KeyEvent) => boolean | void;
  /** 空列表时显示的内容 */
  empty?: JSX.Element;
  /** 根节点语义标识，默认 `list` */
  semantic?: string;
  /** 行语义标识，默认 `list-item:<index>` */
  itemSemantic?: (item: T, index: number) => string;
}

export function List<T>(props: ListProps<T>) {
  const scope = useFocusScope();
  const [node, setNode] = createSignal<Node>();
  const [top, setTop] = createSignal(0);

  const items = (): readonly T[] => props.items ?? [];
  const count = (): number => items().length;
  const itemHeight = (): number => Math.max(1, Math.floor(props.itemHeight ?? 1));
  const virtual = (): boolean => props.virtual === true;

  /** 一屏能放几行；没有 height 就没有视口，按「全放得下」处理 */
  const viewport = (): number => {
    const height = props.height;
    if (height === undefined || height <= 0) return Math.max(1, count());
    return Math.max(1, Math.floor(height / itemHeight()));
  };

  const maxTop = (): number => Math.max(0, count() - viewport());
  const scrollTop = (): number => Math.min(Math.max(0, top()), maxTop());
  const windowStart = (): number => (virtual() ? scrollTop() : 0);
  const windowSize = (): number =>
    virtual() ? Math.max(0, Math.min(viewport(), count() - windowStart())) : count();

  // 选中项跑出窗口 → 把窗口拉回来。只在 index / count / viewport 变化时算。
  createEffect(
    () => [props.selection.index(), count(), viewport()] as const,
    ([index, total, size]) => {
      setTop(current => followScroll(index, total, size, current));
    }
  );

  createEffect(
    () => ({ node: node(), auto: props.autoFocus }),
    ({ node: current, auto }) => {
      if (auto && current) scope?.focus(current);
    }
  );

  const focusList = (): void => {
    if (props.focusOnClick === false) return;
    scope?.focus(node());
  };

  const activate = (index: number): void => {
    const item = items()[index];
    if (item === undefined || !props.onActivate) return;
    props.onActivate(item, index);
  };

  const handleKey = (event: KeyEvent): void => {
    if (props.onKey?.(event) === true) return;
    if (event.name === "enter") {
      activate(props.selection.index());
      return;
    }
    props.selection.handleKey(event);
  };

  const handleWheel = (event: MouseEvent): void => {
    const dir = event.wheel;
    if (dir !== "up" && dir !== "down") return;
    const step = Math.max(1, Math.floor(props.wheelStep ?? 1));
    props.selection.move(dir === "down" ? step : -step);
  };

  const marker = (): string => props.marker ?? ">";
  const markerBlank = (): string => " ".repeat(Math.max(1, Bun.stringWidth(marker())));

  const row = (index: number) => {
    const selected = (): boolean => props.selection.index() === index;
    /** 行内容必须走访问器读 items —— 见文件头第 1 条约束 */
    const content = (): unknown => {
      const item = items()[index];
      if (item === undefined) return null;
      return props.renderItem(item, index, { selected });
    };
    /** 同上：列表缩短的那一瞬间，这一行可能还没有 item */
    const semantic = (): string => {
      const item = items()[index];
      if (item === undefined || !props.itemSemantic) return `list-item:${index}`;
      return props.itemSemantic(item, index);
    };
    return (
      <row
        width="100%"
        height={itemHeight()}
        bg={selected() ? props.selectedBg : undefined}
        semantic={semantic()}
        onClick={() => {
          focusList();
          props.selection.setIndex(index);
          if (props.activateOnClick) activate(index);
        }}
      >
        <text color={selected() ? (props.selectedColor ?? "focus") : (props.color ?? "muted")}>
          {selected() ? marker() : markerBlank()}
        </text>
        {content()}
      </row>
    );
  };

  return (
    <box
      ref={setNode}
      focusable
      semantic={props.semantic ?? "list"}
      height={props.height}
      overflow={props.height === undefined ? undefined : "hidden"}
      // 虚拟化已经把窗口挪到 0 了，只有非虚拟模式才需要布局层再切一刀
      scrollOffset={virtual() ? undefined : scrollTop() * itemHeight()}
      onKey={handleKey}
      onWheel={handleWheel}
    >
      <Show when={count() > 0} fallback={props.empty}>
        <Repeat count={windowSize()} from={windowStart()}>
          {index => row(index)}
        </Repeat>
      </Show>
    </box>
  );
}

/**
 * `<VirtualList>` —— 只渲染可见窗口的 `<List>`。
 *
 * 单独导出是为了让「这条列表可能很长」在代码里是**看得见**的：
 * 读到 `<VirtualList>` 就知道行数上万也没关系，读到 `<List>` 就知道它全渲染。
 */
export function VirtualList<T>(props: ListProps<T>) {
  return <List<T> {...props} virtual />;
}
