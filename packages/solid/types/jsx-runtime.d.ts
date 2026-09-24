/**
 * buTUI JSX 类型（SPEC §14「JSX intrinsic elements」）。
 *
 * Solid 2 不拥有 renderer 的 JSX 类型：自定义 renderer 必须自带
 * `jsx-runtime` 类型入口，应用侧把 `jsxImportSource` 指向它。
 *
 * 注意：这里只描述**类型**。运行时的 JSX 由 `@butui/solid/plugin` 用
 * `@solidjs/compiler` 的 `generate: "universal"` 编译成 host ops 调用。
 */
import type { Element as SolidElement, ArrayElement as SolidArrayElement } from "solid-js";
import type {
  Node,
  FocusEvent as BtnFocusEvent,
  KeyEvent,
  MouseEvent as BtnMouseEvent,
  MousePointerStyle,
  PasteEvent,
} from "@butui/core";

export namespace JSX {
  type Element = SolidElement | Node | SolidArrayElement;
  interface ArrayElement extends Array<Element> {}
  interface ElementChildrenAttribute {
    children: {};
  }

  type Accessor<T> = () => T;

  /**
   * 元素引用。回调收到的是 buTUI 的 `Node`。
   *
   * 这是「组件需要知道自己的节点」的唯一途径 —— 焦点判断（`useFocus()`）、
   * 手动 `focusNode`、测量都靠它。
   */
  interface RefProp {
    ref?: (node: Node) => void;
  }

  /** SPEC §4.2：hit test 返回的语义标识，如 `message:<id>` / `tool:<callId>` */
  type Semantic = string;

  interface BoxProps extends RefProp {
    children?: Element;
    /** 布局方向。`box` 默认 column，等价于 `column` */
    direction?: "row" | "column";
    width?: number | `${number}%`;
    height?: number | `${number}%`;
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    padding?: number | [number, number] | Partial<Insets>;
    margin?: number | [number, number] | Partial<Insets>;
    gap?: number;
    flexGrow?: number;
    flexShrink?: number;
    flexBasis?: number | `${number}%`;
    align?: "start" | "center" | "end" | "stretch";
    justify?: "start" | "center" | "end" | "between" | "around";
    border?: boolean | "single" | "round" | "double" | "heavy";
    borderColor?: string;
    overflow?: "visible" | "hidden" | "scroll";
    scrollOffset?: number;
    fg?: string;
    bg?: string;
    /** 主题 token 名，优先于 fg/bg 解析 */
    color?: string;
    focusable?: boolean;
    disabled?: boolean;
    /** false = 鼠标文本选择不从这个节点 / 子树启动（scrollbar、控件用） */
    selectable?: boolean;
    /** OSC 22 鼠标指针形状；`auto` 根据节点交互能力决定 */
    cursor?: MousePointerStyle;
    semantic?: Semantic;
    onMouseDown?: (event: BtnMouseEvent) => void;
    onMouseUp?: (event: BtnMouseEvent) => void;
    onMouseMove?: (event: BtnMouseEvent) => void;
    onMouseEnter?: (event: BtnMouseEvent) => void;
    onMouseLeave?: (event: BtnMouseEvent) => void;
    onClick?: (event: BtnMouseEvent) => void;
    onDoubleClick?: (event: BtnMouseEvent) => void;
    onContextMenu?: (event: BtnMouseEvent) => void;
    onDragStart?: (event: BtnMouseEvent) => void;
    onDrag?: (event: BtnMouseEvent) => void;
    onDragEnd?: (event: BtnMouseEvent) => void;
    onKey?: (event: KeyEvent) => void;
    onPaste?: (event: PasteEvent) => void;
    onWheel?: (event: BtnMouseEvent) => void;
  }

  interface Insets {
    top: number;
    right: number;
    bottom: number;
    left: number;
  }

  interface RowProps extends BoxProps {}
  interface ColumnProps extends BoxProps {}

  interface TextProps extends RefProp {
    children?: Element;
    /** 内联样式：text 是 inline 容器，子节点横向流动 */
    fg?: string;
    bg?: string;
    color?: string;
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    wrap?: boolean;
    truncate?: boolean;
    semantic?: Semantic;
    onMouseDown?: (event: BtnMouseEvent) => void;
    onMouseUp?: (event: BtnMouseEvent) => void;
    onMouseMove?: (event: BtnMouseEvent) => void;
    onMouseEnter?: (event: BtnMouseEvent) => void;
    onMouseLeave?: (event: BtnMouseEvent) => void;
    onClick?: (event: BtnMouseEvent) => void;
    onDoubleClick?: (event: BtnMouseEvent) => void;
    onContextMenu?: (event: BtnMouseEvent) => void;
    onDragStart?: (event: BtnMouseEvent) => void;
    onDrag?: (event: BtnMouseEvent) => void;
    onDragEnd?: (event: BtnMouseEvent) => void;
    /**
     * 交互属性与 `BoxProps` 对齐。
     *
     * `text` 是最常用的可聚焦单元（列表项、按钮、菜单行），不该逼着作者为了
     * 「能 Tab 到」而多包一层 `<box>`。
     */
    focusable?: boolean;
    disabled?: boolean;
    selectable?: boolean;
    /** OSC 22 鼠标指针形状；`auto` 根据节点交互能力决定 */
    cursor?: MousePointerStyle;
    onKey?: (event: KeyEvent) => void;
    onFocus?: (event: BtnFocusEvent) => void;
    onBlur?: (event: BtnFocusEvent) => void;
    onPaste?: (event: PasteEvent) => void;
    onWheel?: (event: BtnMouseEvent) => void;
  }

  interface SpacerProps {
    /** 固定宽度；省略表示 flex 撑满 */
    size?: number;
  }

  interface ScrollBoxProps extends BoxProps {
    scrollOffset?: number;
  }

  /**
   * 低层 `<image>` 节点（SPEC §12）。
   *
   * 它不是给人直接写的 —— 用 `@butui/image` 的 `<Image src=… />` 组件。
   * 组件负责异步加载 + 编码，产出的就是这里两种形态之一：
   *
   *   - cell 协议（half-block / 占位符）→ `lines`，走普通 cell 渲染
   *   - 原生协议（Kitty / iTerm2 / Sixel）→ `graphic` + `rect`，
   *     布局只补空白占位 cell 并打标记，真正的图形由 ImageLayer 叠加
   */
  interface ImageNodeProps extends RefProp {
    /** 每行一个 ANSI 字符串；行内 SGR 会被布局解析成 per-cell 样式 */
    lines?: readonly string[];
    /** 原生图形 id；布局把它盖在 `rect` 覆盖的 cell 上 */
    graphic?: string;
    /** 绘制区相对节点左上角的偏移与尺寸（contain 时用于居中） */
    rect?: { left: number; top: number; cols: number; rows: number };
    /** 节点占位尺寸（cell） */
    cols?: number;
    rows?: number;
    semantic?: Semantic;
  }

  interface StreamProps extends RefProp {
    /**
     * 只增不改的行数组（同一个引用）。`version` 变化时布局会增量读取新增行。
     */
    lines?: readonly { text: string }[];
    /** 触发重新测量的版本号 */
    version?: number;
    /** 未定稿的尾部文本（可能多行） */
    tail?: string;
    color?: string;
    semantic?: Semantic;
  }

  interface LayerProps extends BoxProps {
    /** 相对父节点左上角的偏移（cell 单位） */
    x?: number;
    y?: number;
  }

  interface IntrinsicElements {
    box: BoxProps;
    row: RowProps;
    column: ColumnProps;
    text: TextProps;
    spacer: SpacerProps;
    scrollbox: ScrollBoxProps;
    image: ImageNodeProps;
    /** 出流覆盖层：不参与 flow，按 (x, y) 合成到父节点之上 */
    layer: LayerProps;
    /** 流式文本节点：O(1) 追加 */
    stream: StreamProps;
  }
}
