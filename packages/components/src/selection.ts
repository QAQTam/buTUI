/**
 * 列表选择模型 —— SPEC §10.1 的 `List` / `VirtualList` 背后那套
 * 「上下移动 / 翻页 / 跟随滚动」。
 *
 * 和 `createTextEditor` 同构：**纯逻辑 + 受控**。组件只负责画，应用持有模型，
 * 所以「按键 → 选中项」这条链可以用真实按键序列做穷举测试，不需要渲染。
 *
 * 三个实现要点：
 *
 * 1. **真值放局部变量，signal 只当版本号**（SPEC §5.6.3）。Solid 2 的 signal
 *    写入延迟到 flush，如果「读 signal → 算新值 → 写 signal」，连续按两次
 *    ↓ 只会移动一格。对外访问器读真值 + touch 版本号，既保证读到的永远最新，
 *    又保持响应式。
 * 2. **count 可以是访问器**。过滤后的列表（命令面板）每敲一个字符 count 就变，
 *    把 count 存进模型再同步会引入「写 signal 的时机」问题；直接读应用给的
 *    访问器，索引在读取时按当前 count 夹取，天然跟着过滤结果走。
 * 3. **滚动窗口是纯函数**（`followScroll`）。窗口顶部是调用方的状态（用户
 *    滚过轮子之后不该被弹回去），模型只回答「为了看见第 i 项，顶部该在哪」。
 */
import type { KeyEvent } from "@butui/core";
import { createSignal } from "solid-js";

export interface SelectionOptions {
  /** 条目数量。给函数则响应式读取（过滤 / 懒加载用） */
  count?: number | (() => number);
  /** 初始选中下标，默认 0 */
  index?: number;
  /** 到两端是否回绕，默认 false（停住） */
  wrap?: boolean;
  /** 额外认 j / k（vim），默认 false */
  vim?: boolean;
  /** PageUp / PageDown 的步长，默认 10 */
  pageSize?: number;
  onChange?: (index: number, previous: number) => void;
}

export interface Selection {
  /** 当前选中下标（已按 count 夹取；空列表恒为 0） */
  index(): number;
  /** 当前条目数量 */
  count(): number;
  setIndex(index: number): void;
  move(delta: number): void;
  home(): void;
  end(): void;
  page(delta: number): void;
  /**
   * 处理一次按键；返回 true 表示已消费（应用不用再管）。
   *
   * 认：↑ ↓ Home End PageUp PageDown Ctrl+P/N（+ 可选的 j/k）。
   * 不认 Enter —— 那是「激活」，属于视图层语义，由 `<List onActivate>` 接。
   */
  handleKey(event: KeyEvent): boolean;
  /** 让当前选中项保持可见；返回新的窗口顶部（纯函数，不写状态） */
  follow(viewport: number, top: number): number;
}

/** 把下标夹进 `[0, count-1]`；空列表返回 0 */
export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(index), count - 1));
}

/**
 * 为了看见第 `selected` 项，窗口顶部该在哪。
 *
 * 只在选中项跑出窗口时移动，其余情况原样返回 —— 所以用户用滚轮手动滚开之后，
 * 只要不动选中项，窗口就不会被弹回去。返回值已经夹进合法范围。
 */
export function followScroll(
  selected: number,
  count: number,
  viewport: number,
  top: number
): number {
  const size = Math.max(0, Math.floor(count));
  const height = Math.max(0, Math.floor(viewport));
  if (size === 0 || height === 0) return 0;
  const maxTop = Math.max(0, size - height);
  let next = Math.max(0, Math.min(Math.floor(top) || 0, maxTop));
  const index = clampIndex(selected, size);
  if (index < next) next = index;
  else if (index >= next + height) next = index - height + 1;
  return Math.max(0, Math.min(next, maxTop));
}

export function createSelection(options: SelectionOptions = {}): Selection {
  const wrap = options.wrap ?? false;
  const vim = options.vim ?? false;
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 10));
  const source = options.count;
  const readCount: () => number = typeof source === "function" ? source : () => source ?? 0;

  // 真值（同步）；signal 只是给渲染用的镜像
  let at = Math.max(0, Math.floor(options.index ?? 0));
  const [rev, bump] = createSignal(0);

  const count = (): number => Math.max(0, Math.floor(readCount()));
  const index = (): number => (rev(), clampIndex(at, count()));

  const setIndex = (next: number): void => {
    const size = count();
    if (size === 0) {
      if (at === 0) return;
      at = 0;
      bump(n => n + 1);
      return;
    }
    const previous = clampIndex(at, size);
    const target = wrap
      ? (((Math.floor(next) % size) + size) % size)
      : clampIndex(next, size);
    at = target;
    if (target !== previous) {
      bump(n => n + 1);
      options.onChange?.(target, previous);
    }
  };

  const move = (delta: number): void => {
    if (delta === 0) return;
    setIndex(index() + delta);
  };

  return {
    index,
    count,
    setIndex,
    move,
    home: () => setIndex(0),
    end: () => setIndex(count() - 1),
    page: delta => move(delta * pageSize),
    handleKey(event) {
      const { name, modifiers } = event;
      if (modifiers.ctrl) {
        if (name === "p") return move(-1), true;
        if (name === "n") return move(1), true;
        return false;
      }
      if (modifiers.alt || modifiers.meta) return false;
      switch (name) {
        case "up":
          move(-1);
          return true;
        case "down":
          move(1);
          return true;
        case "home":
          setIndex(0);
          return true;
        case "end":
          setIndex(count() - 1);
          return true;
        case "pageup":
          move(-pageSize);
          return true;
        case "pagedown":
          move(pageSize);
          return true;
        default:
          break;
      }
      if (vim) {
        if (name === "k") return move(-1), true;
        if (name === "j") return move(1), true;
      }
      return false;
    },
    follow: (viewport, top) => followScroll(index(), count(), viewport, top),
  };
}
