/**
 * 滚动视口模型 —— 聊天式转录的正确行为（SPEC §9.1 / §10.1）。
 *
 * 一个 coding agent 的主视图是**只增不减的转录**：默认贴底，但用户一旦往上
 * 翻去读旧内容，新消息就**不该**把视口拽回去。这是所有聊天 UI 都要处理、
 * 又几乎每个应用都写错一次的东西，所以收进底层。
 *
 * ```tsx
 * const view = createScrollView();
 * createTuiApp({
 *   view: () => <box>...</box>,
 *   scroll: view,                          // 可调用 → 直接当选项传
 *   afterDraw: frame => view.measure(frame),
 *   onKey: event => view.handleKey(event), // 返回 true 即已消费
 *   onMouse: event => view.handleWheel(event),
 * });
 * ```
 *
 * 三个设计要点：
 *
 * 1. **模型只存「意图」，真实位置由布局回报。** 布局会把 `scrollTop` 夹进
 *    `[0, total - height]`，`Frame.top` 是夹取后的真值。所以 `measure()` 每帧
 *    把真值收回来 —— 滚过头不会卡住，下一帧自动自愈（不需要再补一次重绘，
 *    因为布局画出来的本来就是夹取后的那一屏）。
 * 2. **「跟随」是一个状态，不是一个偏移。** 贴底时 `scroll()` 返回 `"bottom"`
 *    而不是数字，于是内容变长时**不需要任何通知**就继续贴底 —— 这正是
 *    `layout()` 支持 `"bottom"` 的意义。
 * 3. **滚到底 = 重新跟随。** 用户自己滚回底部之后，跟随自动恢复，不用应用
 *    再调一次 `follow()`。
 */
import type { KeyEvent, MouseEvent } from "@butui/core";
import { createSignal } from "solid-js";

/** `Frame` 结构上满足它 —— 直接 `view.measure(app.frame())` */
export interface ScrollMetrics {
  /** 视口顶部对应的内容行号（布局夹取后的真值） */
  top: number;
  /** 内容总行数 */
  total: number;
  /** 视口高度（行） */
  height: number;
}

export interface ScrollViewOptions {
  /** 滚轮一次滚几行，默认 1 */
  wheelStep?: number;
  /** 翻页保留几行重叠，默认 1（和 less / more 一致） */
  pageOverlap?: number;
  /** 初始是否贴底，默认 true */
  follow?: boolean;
}

/**
 * 可调用：`scroll: view` 直接当 `createTuiApp` 的选项用。
 */
export interface ScrollView {
  /** 贴底时返回 `"bottom"`，否则返回当前偏移 */
  (): number | "bottom";
  /** 每帧喂一次当前帧（`afterDraw` 里），收回真实位置 */
  measure(frame: ScrollMetrics): void;
  top(): number;
  total(): number;
  height(): number;
  maxTop(): number;
  /** 是否处于「自动跟随」：贴底时为 true */
  following(): boolean;
  atBottom(): boolean;
  scrollTo(offset: number | "top" | "bottom"): void;
  scrollBy(delta: number): void;
  pageUp(): void;
  pageDown(): void;
  home(): void;
  end(): void;
  /** ↑ ↓ PageUp PageDown Home End；返回 true 表示已消费 */
  handleKey(event: KeyEvent): boolean;
  /** 滚轮上下（方向看 `event.wheel`）；返回 true 表示已消费 */
  handleWheel(event: MouseEvent): boolean;
}

export function createScrollView(options: ScrollViewOptions = {}): ScrollView {
  const wheelStep = Math.max(1, Math.floor(options.wheelStep ?? 1));
  const pageOverlap = Math.max(0, Math.floor(options.pageOverlap ?? 1));

  // 真值（同步）；signal 只是给渲染用的镜像（SPEC §5.6.3）
  let offset = 0;
  let rows = 0;
  let content = 0;
  let follow = options.follow ?? true;

  const [rev, bump] = createSignal(0);

  const maxTop = (): number => (rev(), Math.max(0, content - rows));
  const clamp = (value: number): number => {
    const n = Number.isFinite(value) ? Math.floor(value) : 0;
    return Math.max(0, Math.min(n, maxTop()));
  };

  const apply = (next: number, nextFollow: boolean): void => {
    const value = clamp(next);
    if (value === offset && nextFollow === follow) return;
    offset = value;
    follow = nextFollow;
    bump(n => n + 1);
  };

  const scrollTo = (target: number | "top" | "bottom"): void => {
    if (target === "bottom") {
      apply(maxTop(), true);
      return;
    }
    if (target === "top") {
      apply(0, maxTop() === 0);
      return;
    }
    // 滚到底部即恢复跟随 —— 用户的手势就是「我要看最新的」
    const value = clamp(target);
    apply(value, value >= maxTop());
  };

  const scrollBy = (delta: number): void => {
    if (delta === 0) return;
    scrollTo(offset + delta);
  };

  const page = (dir: 1 | -1): void => {
    const span = Math.max(1, rows - pageOverlap);
    scrollBy(dir * span);
  };

  const view = ((): number | "bottom" => (rev(), follow ? "bottom" : offset)) as ScrollView;

  view.measure = frame => {
    const nextOffset = Math.max(0, Math.floor(frame.top) || 0);
    const nextRows = Math.max(0, Math.floor(frame.height) || 0);
    const nextContent = Math.max(0, Math.floor(frame.total) || 0);
    const nextFollow = nextOffset >= Math.max(0, nextContent - nextRows);
    if (nextOffset === offset && nextRows === rows && nextContent === content && nextFollow === follow) {
      return;
    }
    offset = nextOffset;
    rows = nextRows;
    content = nextContent;
    follow = nextFollow;
    bump(n => n + 1);
  };

  view.top = () => (rev(), offset);
  view.total = () => (rev(), content);
  view.height = () => (rev(), rows);
  view.maxTop = maxTop;
  view.following = () => (rev(), follow);
  view.atBottom = () => (rev(), offset >= maxTop());
  view.scrollTo = scrollTo;
  view.scrollBy = scrollBy;
  view.pageUp = () => page(-1);
  view.pageDown = () => page(1);
  view.home = () => scrollTo("top");
  view.end = () => scrollTo("bottom");

  view.handleKey = event => {
    const { name, modifiers } = event;
    // 组合键交回应用：ctrl+u/k 之类是编辑器的地盘
    if (modifiers.ctrl || modifiers.alt || modifiers.meta) return false;
    switch (name) {
      case "up":
        scrollBy(-1);
        return true;
      case "down":
        scrollBy(1);
        return true;
      case "pageup":
        view.pageUp();
        return true;
      case "pagedown":
        view.pageDown();
        return true;
      case "home":
        view.home();
        return true;
      case "end":
        view.end();
        return true;
      default:
        return false;
    }
  };

  view.handleWheel = event => {
    if (event.action !== "wheel") return false;
    const dir = event.wheel;
    if (dir !== "up" && dir !== "down") return false;
    scrollBy(dir === "down" ? wheelStep : -wheelStep);
    return true;
  };

  return view;
}
