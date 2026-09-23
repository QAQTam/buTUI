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
import type { Node, KeyEvent, MouseEvent as BtnMouseEvent, PasteEvent } from "@butui/core";

export namespace JSX {
  type Element = SolidElement | Node | SolidArrayElement;
  interface ArrayElement extends Array<Element> {}
  interface ElementChildrenAttribute {
    children: {};
  }

  type Accessor<T> = () => T;

  /** SPEC §4.2：hit test 返回的语义标识，如 `message:<id>` / `tool:<callId>` */
  type Semantic = string;

  interface BoxProps {
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
    semantic?: Semantic;
    onClick?: (event: BtnMouseEvent) => void;
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

  interface TextProps {
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
    onClick?: (event: BtnMouseEvent) => void;
  }

  interface SpacerProps {
    /** 固定宽度；省略表示 flex 撑满 */
    size?: number;
  }

  interface ScrollBoxProps extends BoxProps {
    scrollOffset?: number;
  }

  interface InputProps {
    value?: string;
    placeholder?: string;
    focusable?: boolean;
    disabled?: boolean;
    fg?: string;
    color?: string;
    /** 光标字符，默认 `▏` */
    cursor?: string;
    semantic?: Semantic;
    onInput?: (value: string) => void;
    onSubmit?: (value: string) => void;
    onKey?: (event: KeyEvent) => void;
  }

  interface MarkdownProps {
    children?: Element;
    /** markdown 源文本 */
    source?: string;
    width?: number;
    color?: string;
    semantic?: Semantic;
  }

  interface CodeProps {
    children?: Element;
    source?: string;
    language?: string;
    lineNumbers?: boolean;
    color?: string;
  }

  interface ImageProps {
    /** 只允许白名单路径或明确授权的 URL（SPEC §12.3） */
    src?: string;
    alt?: string;
    width?: number;
    height?: number;
    fit?: "contain" | "cover" | "fill";
  }

  interface StreamProps {
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
    input: InputProps;
    markdown: MarkdownProps;
    code: CodeProps;
    image: ImageProps;
    /** 出流覆盖层：不参与 flow，按 (x, y) 合成到父节点之上 */
    layer: LayerProps;
    /** 流式文本节点：O(1) 追加 */
    stream: StreamProps;
  }
}
