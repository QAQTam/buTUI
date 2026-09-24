/**
 * `<Input>` —— SPEC §10.1。
 *
 * 受控 + 自带编辑：值由 `createTextEditor` 持有，组件负责画（光标、水平滚动、
 * 占位符）并把按键交给编辑器。应用不需要再写 backspace / ctrl+u / 历史。
 *
 * ```tsx
 * const editor = createTextEditor({ onSubmit: value => session.submit(value) });
 * <Input editor={editor} placeholder="说点什么…" autoFocus />
 * ```
 *
 * 光标只在聚焦时高亮（焦点来自 `useFocus()`）；没有运行时上下文时退化成
 * 「一直显示」，这样组件单独用也不会看起来像坏了。
 */
import { type KeyEvent, type MousePointerStyle, type Node } from "@butui/core";
import { useFocus, useFocusScope } from "@butui/solid";
import { Show, createEffect, createMemo, createSignal } from "solid-js";
import type { TextEditor } from "./editor.ts";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Cell {
  text: string;
  width: number;
}

function toCells(text: string): Cell[] {
  const cells: Cell[] = [];
  for (const { segment } of SEGMENTER.segment(text)) {
    cells.push({ text: segment, width: Bun.stringWidth(segment) });
  }
  return cells;
}

export interface InputWindow {
  /** 光标之前可见的部分 */
  before: string;
  /** 光标处的字（block 光标用；行尾时为空串） */
  at: string;
  /** 光标之后可见的部分 */
  after: string;
  /** 因为太长而向左滚动了多少个字符位（>0 表示前面还有内容） */
  scrolled: number;
}

/**
 * 算出「光标一定可见」的水平窗口。
 *
 * 用 grapheme + 显示宽度算，所以 CJK / emoji 不会把宽度算歪；光标在窗口里
 * 尽量居中，靠近两端时贴边。
 */
export function sliceInputWindow(text: string, cursor: number, width: number): InputWindow {
  const limit = Math.max(1, width);
  // 给光标本身留一格（bar 光标要占位；block 光标只是略保守）
  const textLimit = Math.max(1, limit - 1);
  const cells = toCells(text);

  // code-unit 光标 → cell 下标
  let acc = 0;
  let cursorCell = cells.length;
  for (let i = 0; i < cells.length; i++) {
    if (acc >= cursor) {
      cursorCell = i;
      break;
    }
    acc += cells[i].text.length;
  }

  // 前缀显示宽度
  const prefix = new Array<number>(cells.length + 1).fill(0);
  for (let i = 0; i < cells.length; i++) prefix[i + 1] = prefix[i]! + cells[i]!.width;
  const total = prefix[cells.length]!;

  let startWidth = 0;
  if (total > textLimit) {
    const maxStart = Math.max(0, total - textLimit);
    const cursorWidth = prefix[cursorCell]!;
    // 默认让光标居中，再夹回「光标必须可见」和「不越过末尾」
    startWidth = Math.min(Math.max(0, cursorWidth - Math.floor(textLimit / 2)), maxStart);
    if (cursorWidth > startWidth + textLimit) startWidth = cursorWidth - textLimit;
    if (cursorWidth < startWidth) startWidth = cursorWidth;
    startWidth = Math.max(0, Math.min(startWidth, maxStart));
  }

  // 按宽度切出可见 cell
  let start = 0;
  while (start < cells.length && prefix[start]! < startWidth) start++;

  const visible: Cell[] = [];
  let used = 0;
  for (let i = start; i < cells.length; i++) {
    if (used + cells[i]!.width > textLimit) break;
    visible.push(cells[i]!);
    used += cells[i]!.width;
  }

  const rel = cursorCell - start;
  const before = visible.slice(0, Math.max(0, rel)).map(c => c.text).join("");
  const at = rel >= 0 && rel < visible.length ? visible[rel]!.text : "";
  const after = visible
    .slice(Math.max(0, rel) + (at === "" ? 0 : 1))
    .map(c => c.text)
    .join("");
  return { before, at, after, scrolled: start };
}

export interface InputProps {
  editor: TextEditor;
  /** 可见宽度（cell）。默认 40 */
  width?: number;
  placeholder?: string;
  /** bar 光标用这个字符（默认 `▏`）；block 光标用「反显当前字符」 */
  cursorChar?: string;
  /** 文本光标绘制方式（bar / block），不是鼠标指针 */
  cursorStyle?: "bar" | "block";
  /** OSC 22 鼠标指针形状，默认 `text` */
  cursor?: MousePointerStyle;
  color?: string;
  placeholderColor?: string;
  focusColor?: string;
  semantic?: string;
  /** 首次渲染后自动聚焦 */
  autoFocus?: boolean;
  /** 额外按键处理：先于编辑器；返回 true 表示已消费 */
  onKey?: (event: KeyEvent) => boolean | void;
}

export function Input(props: InputProps) {
  const scope = useFocusScope();
  const isFocused = useFocus();
  const [node, setNode] = createSignal<Node>();

  const width = () => Math.max(1, props.width ?? 40);
  const focused = () => isFocused(node()) || scope === null;

  const window = createMemo(() =>
    sliceInputWindow(props.editor.value(), props.editor.cursor(), width())
  );

  const showPlaceholder = () => props.editor.value() === "" && props.placeholder !== undefined;

  createEffect(
    () => ({ node: node(), auto: props.autoFocus }),
    ({ node, auto }) => {
      if (auto && node) scope?.focus(node);
    }
  );

  return (
    <row
      ref={setNode}
      focusable
      cursor={props.cursor ?? "text"}
      semantic={props.semantic ?? "input"}
      onKey={event => {
        if (props.onKey?.(event) === true) return;
        props.editor.handleKey(event);
      }}
      onPaste={event => props.editor.insert(event.text)}
    >
      <Show when={window().scrolled > 0}>
        <text color="muted">…</text>
      </Show>
      <text color={props.color ?? "fg"}>{window().before}</text>

      {/* block：光标「就是」那个字符（反显）；行尾没有字符时退化成 bar */}
      <Show when={props.cursorStyle === "block"}>
        <text bg={props.focusColor ?? "focus"} fg="bg">
          {window().at === "" ? (props.cursorChar ?? "▏") : window().at}
        </text>
      </Show>
      {/* bar：光标插在字符之前，字符本身照常显示 */}
      <Show when={props.cursorStyle !== "block"}>
        <text color={focused() ? (props.focusColor ?? "focus") : "muted"}>
          {props.cursorChar ?? "▏"}
        </text>
      </Show>

      <Show
        when={showPlaceholder()}
        fallback={
          <text color={props.color ?? "fg"}>
            {props.cursorStyle === "block" ? window().after : window().at + window().after}
          </text>
        }
      >
        {/* 空值：光标照常显示，占位文本跟在后面 */}
        <text color={props.placeholderColor ?? "muted"}>{props.placeholder ?? ""}</text>
      </Show>
    </row>
  );
}
