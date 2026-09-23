/**
 * 文本编辑模型 —— SPEC §10.1 的 `Input` 背后那套「光标 / 插入 / 删除 / 词跳转」。
 *
 * 为什么单独抽出来：
 *   - 它是**纯逻辑**，不依赖渲染，所以能拿真实按键序列做穷举测试
 *   - 编辑器状态由应用持有（受控），组件只负责画 —— 和 buTUI 其他部分一致
 *   - 键盘策略集中在一处，不用每个 app 再写一遍 backspace / ctrl+u / 历史
 *
 * **实现要点：真值放局部变量，signal 只当版本号。**
 *
 * Solid 2 的 signal 写入延迟到 flush（SPEC §5.6.3）。如果「读 signal → 算新值
 * → 写 signal」，连续输入会丢字符（打 "a" 再打 "b" 只剩 "b"）；即使只写不读，
 * 外部同步调用 `value()` 也会拿到上一帧的旧值。所以：
 *
 *   真值 text / pos / past 是普通变量，所有编辑同步改它们
 *   对外暴露的 value()/cursor()/history() 读的是真值，顺便 touch 一个版本
 *   signal —— 既保证「读到的永远是最新」，又保持响应式
 *
 * 明确不做（见 STABILITY.md 的已知缺口）：选区、剪贴板历史、多行软换行、
 * 撤销栈。多行模式只影响「Enter 是换行还是提交」。
 */
import type { KeyEvent } from "@butui/core";
import { createSignal } from "solid-js";

export interface TextEditorOptions {
  /** 初始值 */
  value?: string;
  /** 初始光标位置（默认末尾） */
  cursor?: number;
  /** 单行模式按 Enter 会走这里；返回后清空输入 */
  onSubmit?: (value: string) => void;
  /** 每次值变化 */
  onChange?: (value: string) => void;
  /** 多行：Enter 插入换行而不是提交 */
  multiline?: boolean;
  /** 上下键历史条数上限，默认 50 */
  historyLimit?: number;
  /** 提交后是否清空（默认 true） */
  clearOnSubmit?: boolean;
}

export interface TextEditor {
  value(): string;
  cursor(): number;
  /** 处理一次按键；返回 true 表示已消费（应用不用再管） */
  handleKey(event: KeyEvent): boolean;
  /** 在光标处插入文本（粘贴走这里） */
  insert(text: string): void;
  setValue(value: string): void;
  setCursor(offset: number): void;
  /** 提交当前值（Enter 的效果） */
  submit(): void;
  history(): readonly string[];
  /** 清空 */
  clear(): void;
}

const WORD = /[\p{L}\p{N}_]/u;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 光标移动与删除都按 **grapheme** 走，不按 code unit。
 *
 * 光标是 code-unit 偏移（和 JS 字符串一致），但一次「左」必须跨过一个完整
 * 字素 —— 否则在 emoji / 组合字符上会把代理对劈成两半，删出乱码。
 */
export function prevGrapheme(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  if (at === 0) return 0;
  let prev = 0;
  for (const { index } of SEGMENTER.segment(text)) {
    if (index >= at) break;
    prev = index;
  }
  return prev;
}

export function nextGrapheme(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  for (const { index } of SEGMENTER.segment(text)) {
    if (index > at) return index;
  }
  return text.length;
}

/** 从 offset 向左跳过空白再跳过一整个词，返回新 offset */
export function wordBoundaryLeft(text: string, offset: number): number {
  let i = Math.max(0, Math.min(offset, text.length));
  while (i > 0 && !WORD.test(text[i - 1]!)) i--;
  while (i > 0 && WORD.test(text[i - 1]!)) i--;
  return i;
}

/** 从 offset 向右跳过一整个词再跳过空白 */
export function wordBoundaryRight(text: string, offset: number): number {
  let i = Math.max(0, Math.min(offset, text.length));
  while (i < text.length && !WORD.test(text[i]!)) i++;
  while (i < text.length && WORD.test(text[i]!)) i++;
  return i;
}

/** offset 所在行的 `[start, end)`（`end` 不含换行符本身） */
export function lineBounds(text: string, offset: number): { start: number; end: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const next = text.indexOf("\n", at);
  return { start, end: next === -1 ? text.length : next };
}

/**
 * 上下移动光标（多行编辑用）。
 *
 * 列位置按**code unit 偏移**保持：从短行移到长行会夹到行尾，再移回来列就
 * 丢了。这是有意的取舍 —— 记住「想要的列」需要额外状态，而 TUI 里上下移动
 * 通常是为了快速跳行，不是精确列对齐。
 */
export function moveVertical(text: string, offset: number, delta: 1 | -1): number {
  const { start, end } = lineBounds(text, offset);
  const column = Math.max(0, Math.min(offset, text.length) - start);
  if (delta === -1) {
    if (start === 0) return Math.max(0, Math.min(offset, text.length));
    const prevEnd = start - 1; // 上一行的换行符位置
    const prevStart = text.lastIndexOf("\n", Math.max(0, prevEnd - 1)) + 1;
    return Math.min(prevStart + column, prevEnd);
  }
  if (end >= text.length) return Math.max(0, Math.min(offset, text.length));
  const nextStart = end + 1;
  const nextEnd = text.indexOf("\n", nextStart);
  return Math.min(nextStart + column, nextEnd === -1 ? text.length : nextEnd);
}

export function createTextEditor(options: TextEditorOptions = {}): TextEditor {
  const historyLimit = options.historyLimit ?? 50;
  const clearOnSubmit = options.clearOnSubmit ?? true;

  // 真值（同步）；signal 只是给渲染用的镜像
  let text = options.value ?? "";
  let pos = Math.max(0, Math.min(options.cursor ?? text.length, text.length));
  let past: string[] = [];
  let historyAt = -1;
  let draft = "";

  // 版本号：只用来让读真值的访问器建立依赖
  const [valueRev, bumpValue] = createSignal(0);
  const [cursorRev, bumpCursor] = createSignal(0);
  const [historyRev, bumpHistory] = createSignal(0);

  const value = (): string => (valueRev(), text);
  const cursor = (): number => (cursorRev(), pos);
  const history = (): readonly string[] => (historyRev(), past);

  const publish = (): void => {
    bumpValue(n => n + 1);
    bumpCursor(n => n + 1);
  };

  const notify = (): void => options.onChange?.(text);

  const setCursor = (offset: number): void => {
    pos = Math.max(0, Math.min(offset, text.length));
    bumpCursor(n => n + 1);
  };

  const setValue = (next: string): void => {
    text = next;
    pos = Math.max(0, Math.min(pos, text.length));
    publish();
    notify();
  };

  const replaceRange = (from: number, to: number, insertText: string): void => {
    const start = Math.max(0, Math.min(from, text.length));
    const end = Math.max(start, Math.min(to, text.length));
    text = text.slice(0, start) + insertText + text.slice(end);
    pos = start + insertText.length;
    publish();
    notify();
  };

  const insert = (input: string): void => {
    if (input === "") return;
    const clean = options.multiline ? input : input.replace(/\r?\n/g, " ");
    replaceRange(pos, pos, clean);
  };

  const submit = (): void => {
    const current = text;
    if (current.trim() !== "") {
      past = [...past, current].slice(-historyLimit);
      bumpHistory(n => n + 1);
    }
    historyAt = -1;
    draft = "";
    options.onSubmit?.(current);
    if (clearOnSubmit) {
      text = "";
      pos = 0;
      publish();
      notify();
    }
  };

  const browseHistory = (delta: number): void => {
    if (past.length === 0) return;
    if (historyAt === -1) {
      if (delta > 0) return; // 已经在「最新」（草稿），再往下没有东西
      draft = text;
      historyAt = past.length; // 站在最后一条之后，减一就是最后一条
    }
    const next = historyAt + delta;
    if (next < 0) return; // 到顶了，停住
    if (next >= past.length) {
      // 越过最后一条 → 回到未提交的草稿
      historyAt = -1;
      text = draft;
      pos = text.length;
      publish();
      notify();
      return;
    }
    historyAt = next;
    text = past[next]!;
    pos = text.length;
    publish();
    notify();
  };

  const handleKey = (event: KeyEvent): boolean => {
    const { name, text: input, modifiers } = event;
    const word = modifiers.ctrl || modifiers.alt;

    /** 多行模式的上下移动：光标上下走一行，列尽量保持 */
    const moveVerticalCursor = (delta: 1 | -1): void => {
      setCursor(moveVertical(text, pos, delta));
    };

    switch (name) {
      case "left":
        setCursor(word ? wordBoundaryLeft(text, pos) : prevGrapheme(text, pos));
        return true;
      case "right":
        setCursor(word ? wordBoundaryRight(text, pos) : nextGrapheme(text, pos));
        return true;
      case "home":
        setCursor(0);
        return true;
      case "end":
        setCursor(text.length);
        return true;
      case "backspace":
        if (pos === 0) return true;
        replaceRange(word ? wordBoundaryLeft(text, pos) : prevGrapheme(text, pos), pos, "");
        return true;
      case "delete":
        if (pos >= text.length) return true;
        replaceRange(pos, word ? wordBoundaryRight(text, pos) : nextGrapheme(text, pos), "");
        return true;
      case "enter":
        if (options.multiline) {
          insert("\n");
          return true;
        }
        submit();
        return true;
      case "up":
        // 多行模式：上下移动光标；单行模式：翻历史
        if (options.multiline) moveVerticalCursor(-1);
        else browseHistory(-1);
        return true;
      case "down":
        if (options.multiline) moveVerticalCursor(1);
        else browseHistory(1);
        return true;
      default:
        break;
    }

    // ctrl 组合：只认几个行编辑标准键，其余交回应用
    if (modifiers.ctrl) {
      if (name === "a") {
        setCursor(0);
        return true;
      }
      if (name === "e") {
        setCursor(text.length);
        return true;
      }
      if (name === "u") {
        replaceRange(0, pos, "");
        return true;
      }
      if (name === "k") {
        replaceRange(pos, text.length, "");
        return true;
      }
      if (name === "w") {
        replaceRange(wordBoundaryLeft(text, pos), pos, "");
        return true;
      }
      return false;
    }
    if (modifiers.alt || modifiers.meta) return false;

    // 普通字符输入（控制字符交给应用）
    if (input && input.length > 0 && !/^[\x00-\x1f\x7f]$/.test(input)) {
      insert(input);
      return true;
    }
    return false;
  };

  return {
    value,
    cursor,
    handleKey,
    insert,
    setValue,
    setCursor,
    submit,
    history,
    clear: () => setValue(""),
  };
}
