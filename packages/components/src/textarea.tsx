/**
 * `<Textarea>` —— 多行输入（SPEC §10.1）。
 *
 * 和 `<Input>` 共用同一个编辑器模型（`createTextEditor({ multiline: true })`），
 * 区别只在渲染：这里要**软换行 + 垂直滚动 + 光标定位**。
 *
 * 三条实现要点：
 *
 * 1. **软换行是纯函数**（`wrapText`）：把源文本按显示宽度切成视觉行，并记下
 *    每行在源文本里的 `[start, end)`。光标定位、滚动跟随都靠这个映射，不需要
 *    在组件里存一份「折行后的文本」。
 * 2. **光标按 grapheme 折行**：和编辑器一致，CJK / emoji 不会被劈成两半。
 * 3. **垂直滚动由光标驱动**：光标跑出视口才动窗口，和 `<List>` 的跟随策略
 *    一致（用户手动滚开不会被弹回来）。
 */
import { type KeyEvent, type MousePointerStyle, type Node } from "@butui/core";
import { useFocus, useFocusScope } from "@butui/solid";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show, createEffect, createMemo, createSignal } from "solid-js";
import type { TextEditor } from "./editor.ts";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface VisualLine {
  /** 这一视觉行的文本（不含行尾换行符） */
  text: string;
  /** 在源文本里的起始偏移 */
  start: number;
  /** 在源文本里的结束偏移（不含换行符） */
  end: number;
  /** 它属于第几个**逻辑**行（从 1 开始；软折行出来的延续行与首行同号） */
  lineNumber: number;
}

/**
 * 软换行：把文本按显示宽度切成视觉行。
 *
 * 宽度按 `Bun.stringWidth` 算（CJK / emoji 占 2 列），切点按 grapheme 走。
 * 空行也会产出一行（`""`），否则回车之后光标会没地方落。
 */
export function wrapText(text: string, width: number): VisualLine[] {
  const limit = Math.max(1, Math.floor(width));
  const lines: VisualLine[] = [];
  let lineStart = 0;
  let lineText = "";
  let lineWidth = 0;
  let lineNumber = 1;

  const flush = (end: number): void => {
    lines.push({ text: lineText, start: lineStart, end, lineNumber });
    lineText = "";
    lineWidth = 0;
  };

  for (const { segment, index } of SEGMENTER.segment(text)) {
    if (segment === "\n") {
      flush(index);
      lineStart = index + 1;
      lineNumber++;
      continue;
    }
    const cellWidth = Bun.stringWidth(segment);
    if (lineWidth + cellWidth > limit && lineText !== "") {
      flush(index);
      lineStart = index;
    }
    lineText += segment;
    lineWidth += cellWidth;
  }
  flush(text.length);
  return lines;
}

/** 光标（源文本偏移）落在第几个视觉行、行内第几列 */
export function locateCursor(
  lines: readonly VisualLine[],
  cursor: number
): { row: number; column: number } {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (cursor <= line.end) return { row: i, column: Math.max(0, cursor - line.start) };
  }
  const last = lines[lines.length - 1];
  return last
    ? { row: lines.length - 1, column: last.text.length }
    : { row: 0, column: 0 };
}

export interface TextareaProps {
  editor: TextEditor;
  /** 可见宽度（cell），默认 60 */
  width?: number;
  /** 可见行数，默认 5 */
  height?: number;
  placeholder?: string;
  color?: string;
  placeholderColor?: string;
  /** bar 光标用这个字符（默认 `▏`）；block 反显当前字符 */
  cursorChar?: string;
  /** 文本光标绘制方式（bar / block），不是鼠标指针 */
  cursorStyle?: "bar" | "block";
  /** OSC 22 鼠标指针形状，默认 `text` */
  cursor?: MousePointerStyle;
  focusColor?: string;
  /** 左侧行号 */
  lineNumbers?: boolean;
  lineNumberColor?: string;
  autoFocus?: boolean;
  /** 额外按键处理：先于编辑器；返回 true 表示已消费 */
  onKey?: (event: KeyEvent) => boolean | void;
  semantic?: string;
  ref?: (node: Node) => void;
}

export function Textarea(props: TextareaProps) {
  const scope = useFocusScope();
  const isFocused = useFocus();
  const [node, setNode] = createSignal<Node>();
  const focused = (): boolean => isFocused(node()) || scope === null;

  const width = (): number => Math.max(1, props.width ?? 60);
  const height = (): number => Math.max(1, props.height ?? 5);
  /**
   * 行号槽宽度。
   *
   * 必须由**逻辑行数**（源文本里几个 `\n`）算，不能由 `visualLines().length` 算 ——
   * 后者是软折行之后的视觉行数，而 `visualLines` 自己又要用槽宽，会绕成一个
   * 循环依赖（Solid 直接 `[REACTIVITY_HALTED]`）。
   */
  const logicalLines = (): number => (props.lineNumbers ? props.editor.value().split("\n").length : 0);
  const gutter = (): number => (props.lineNumbers ? String(logicalLines()).length + 1 : 0);

  const visualLines = createMemo(() => wrapText(props.editor.value(), width() - gutter()));
  const cursor = createMemo(() => locateCursor(visualLines(), props.editor.cursor()));

  /** 垂直窗口顶部（视觉行号） */
  const [top, setTop] = createSignal(0);
  const maxTop = (): number => Math.max(0, visualLines().length - height());
  const scrollTop = (): number => Math.min(Math.max(0, top()), maxTop());

  createEffect(
    () => ({ row: cursor().row, total: visualLines().length, view: height() }),
    ({ row, total, view }) => {
      // 只在光标跑出视口时动窗口
      setTop(current => {
        const max = Math.max(0, total - view);
        let next = Math.min(Math.max(0, current), max);
        if (row < next) next = row;
        else if (row >= next + view) next = row - view + 1;
        return Math.min(Math.max(0, next), max);
      });
    }
  );

  createEffect(
    () => ({ node: node(), auto: props.autoFocus }),
    ({ node: current, auto }) => {
      if (auto && current) scope?.focus(current);
    }
  );

  const visible = (): VisualLine[] => visualLines().slice(scrollTop(), scrollTop() + height());
  const showPlaceholder = (): boolean => props.editor.value() === "" && props.placeholder !== undefined;
  const isCursorRow = (index: number): boolean => index === cursor().row - scrollTop();
  const cursorColor = (): string => (focused() ? (props.focusColor ?? "focus") : "muted");

  /** 一行拆成「光标前 / 光标处 / 光标后」三段 */
  const segments = (line: VisualLine, index: number): { before: string; at: string; after: string } => {
    if (!isCursorRow(index)) return { before: line.text, at: "", after: "" };
    const at = Math.max(0, Math.min(cursor().column, line.text.length));
    const cells = [...SEGMENTER.segment(line.text)].map(s => s.segment);
    let acc = 0;
    let cut = cells.length;
    for (let i = 0; i < cells.length; i++) {
      if (acc >= at) {
        cut = i;
        break;
      }
      acc += cells[i]!.length;
    }
    return {
      before: cells.slice(0, cut).join(""),
      at: cells[cut] ?? "",
      after: cells.slice(cut + (cells[cut] === undefined ? 0 : 1)).join(""),
    };
  };

  return (
    <box
      ref={node => {
        setNode(node);
        props.ref?.(node);
      }}
      focusable
      cursor={props.cursor ?? "text"}
      semantic={props.semantic ?? "textarea"}
      onKey={(event: KeyEvent) => {
        if (props.onKey?.(event) === true) return;
        props.editor.handleKey(event);
      }}
      onPaste={event => props.editor.insert(event.text)}
    >
      {visible().map((line, index) => {
        const parts = segments(line, index);
        return (
          <row>
            <Show when={props.lineNumbers}>
              <text color={props.lineNumberColor ?? "muted"}>
                {`${String(line.lineNumber).padStart(gutter() - 1)} `}
              </text>
            </Show>
            <text color={props.color ?? "fg"}>{parts.before}</text>
            <Show when={props.cursorStyle === "block"}>
              <text bg={cursorColor()} fg="bg">
                {parts.at === "" ? (props.cursorChar ?? "▏") : parts.at}
              </text>
            </Show>
            <Show when={props.cursorStyle !== "block"}>
              <text color={cursorColor()}>{props.cursorChar ?? "▏"}</text>
            </Show>
            <Show
              when={!(showPlaceholder() && index === 0 && isCursorRow(index))}
              fallback={
                <text color={props.placeholderColor ?? "muted"}>{props.placeholder ?? ""}</text>
              }
            >
              <text color={props.color ?? "fg"}>
                {props.cursorStyle === "block" ? parts.after : parts.at + parts.after}
              </text>
            </Show>
          </row>
        );
      })}
    </box>
  );
}
