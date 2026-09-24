/**
 * `@butui/runtime` —— 把一个 buTUI 视图跑成真终端应用。
 *
 * 这是给**应用作者**的稳定入口。之前这些事要每个 app 自己糊（demo 里 120 行）：
 *
 *   - 建 TerminalSession、备用屏、raw mode、鼠标 / paste / focus 开关
 *   - 建 root 节点、render()、每次改状态记得 schedulePaint
 *   - 微任务里 flush() + layout() + draw() 的合帧逻辑
 *   - resize → 重排 + renderer.invalidate
 *   - 键盘 → 焦点节点派发、鼠标 → hit test 派发、tab 循环焦点
 *   - ctrl+c / 退出时还原终端
 *
 * 现在应用只写「视图 + 键位策略」：
 *
 * ```tsx
 * const app = createTuiApp({ view: () => <App session={session} /> });
 * app.start();
 * ```
 *
 * **重绘是全自动的**：`@butui/core` 的任何节点变更都会通知运行时，运行时把它
 * 合并到下一帧。所以异步来的变更（定时器、图片加载、事件流）也不需要手动
 * 调用任何东西。
 */
import {
  type ButuiEvent,
  type ColorDepth,
  type KeyEvent,
  type MouseEvent,
  type Node,
  type PasteEvent,
  createElement,
  dispatchEvent,
  eventTarget,
  focusNext,
  focusNode,
  focusPrev,
  focusedNode,
  getFocusState,
  isElement,
  nodeById,
  onFocusChange,
  onMutation,
  trapFocus,
} from "@butui/core";
import {
  type Frame,
  type TextSelectionPoint,
  type TextSelectionRange,
  layout,
  selectionText,
} from "@butui/layout";
import { type RenderStats, Renderer } from "@butui/renderer";
import { provideAppScope, provideFocusScope, render } from "@butui/solid";
import { TerminalSession, osc52, terminalSize } from "@butui/terminal";
import { createSignal, flush } from "solid-js";

export interface TuiSize {
  columns: number;
  rows: number;
}

/**
 * 运行时需要的终端能力。`TerminalSession` 结构上满足它；
 * 测试可以塞一个假终端进来（不碰 TTY、不写 stdout）。
 */
export interface TuiTerminal {
  readonly size: TuiSize;
  readonly colorDepth: ColorDepth;
  start(): void;
  stop(): void;
  write(chunk: string): void;
  onEvent(listener: (event: ButuiEvent) => void): () => void;
  onResize(listener: (size: TuiSize) => void): () => void;
}

export interface TextSelectionSnapshot {
  range: TextSelectionRange;
  text: string;
}

export interface TextSelectionOptions {
  /** 运行中可临时关闭（例如权限弹窗期间）。默认开启。 */
  enabled?: () => boolean;
  /** 鼠标松开后自动写 OSC 52 剪贴板；默认 true。 */
  copyOnSelect?: boolean;
  /** 选择定稿（松开 / 清除）时回调；拖动过程不会高频触发。 */
  onSelection?: (selection: TextSelectionSnapshot | null) => void;
}

export interface MouseOptions {
  /** 双击最大间隔（毫秒），默认 400。 */
  doubleClickMs?: number;
  /** 超过多少 cell 才算 drag，默认 1。 */
  dragThreshold?: number;
  /** 注入时钟；测试用。 */
  now?: () => number;
}

interface MouseBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TuiAppOptions {
  /**
   * 视图。任何节点变更都会自动重绘，不需要自己调 paint。
   *
   * 参数是 app 自己 —— 这样视图里可以读 `app.size()` 而不必先声明再赋值
   * （避免了「视图闭包引用尚未初始化的 app」这个 TDZ 陷阱）。
   */
  view: (app: TuiApp) => unknown;
  /** 终端；不给就自己建一个（备用屏 + raw mode + 鼠标 + paste） */
  terminal?: TuiTerminal;
  /** 初始尺寸；给了就忽略终端的（headless / 固定尺寸用） */
  size?: TuiSize;
  /**
   * 视口位置。默认 `"bottom"` —— 聊天式转录贴底，只复制可视窗口，
   * 这是 SPEC §17「流式输出不整屏闪烁」的一半。
   * 固定布局（表单 / 仪表盘）用 `"top"`。
   */
  scroll?: () => number | "top" | "bottom";
  /**
   * 固定在视口顶部 / 底部的行数（不参与滚动）。
   *
   * 「固定页眉 + 可滚转录 + 固定状态栏」的骨架靠这两个数表达。注意语义是
   * **取内容的前 / 后 N 行**，所以它们要放在 flow 的头尾（配合 `<layer>` 那种
   * 覆盖式定位是另一回事 —— layer 会跟着父节点一起被滚走）。
   *
   * 与 `scroll` 搭配时：`scroll` 的偏移是**滚动区内**的行号，`frame().top` 报的
   * 也是同一个坐标系，两者可以直接互传（`ScrollView.measure` 收的就是
   * `frame()`）—— 应用不需要知道固定区有几行。
   */
  stickyTop?: number;
  stickyBottom?: number;
  /**
   * 帧后钩子：原生图片图层（`ImageLayer.render`）、调试统计等。
   *
   * 返回值会拼进同一批写入；只做观察（比如 `ScrollView.measure`）可以不返回。
   */
  afterDraw?: (frame: Frame, stats: RenderStats) => string | void;
  /**
   * 应用级键位。返回 `true` 表示已消费 —— 不再派发给焦点节点。
   * 模态弹窗、全局快捷键（ctrl+u 之类）都写在这里。
   */
  onKey?: (event: KeyEvent) => boolean | void;
  /**
   * 结构化 keymap。
   *
   * 顺序：`onKey` → `keymap` → 组件 `useKeyboard` → 内建（ctrl+c / tab）→
   * 焦点节点。用结构类型而不是直接依赖 `@butui/keymap`，runtime 保持可独立使用。
   */
  keymap?: { handle(event: KeyEvent): boolean };
  /**
   * 鼠标行为参数：双击间隔、测试时钟。
   */
  mouse?: MouseOptions;
  /**
   * 终端鼠标移动模式。默认 `"drag"`；设为 `"hover"` 会开启 1003，
   * 无按键移动也能触发 `onMouseEnter/Leave`。
   */
  mouseMotion?: "drag" | "hover";
  /** 应用级鼠标：**焦点节点没处理时**才会走到这里（比如语义动作分发） */
  onMouse?: (event: MouseEvent) => boolean | void;
  /**
   * 鼠标文本选择。
   *
   * 默认开启：左键拖拽按 cell 选区，松开时通过 OSC 52 尝试写入系统剪贴板。
   * 传 `false` 完全关闭；传对象可动态开关 / 关闭自动复制 / 订阅定稿。
   */
  selection?: boolean | TextSelectionOptions;
  onPaste?: (event: PasteEvent) => boolean | void;
  /** 色彩能力；默认读终端 */
  colorDepth?: ColorDepth;
  /** ctrl+c 直接退出，默认 true */
  quitOnCtrlC?: boolean;
  /** tab / shift+tab 循环焦点，默认 true */
  tabFocus?: boolean;
  /** 退出时做什么；默认 stop() + process.exit(0) */
  onQuit?: () => void;
  /** 构造后立刻 start；默认 true */
  autoStart?: boolean;
}

export interface TuiApp {
  /** 根节点。一般不需要碰它 */
  readonly root: Node;
  /** 当前终端尺寸（响应式：resize 后读到的就是新值） */
  size(): TuiSize;
  colorDepth(): ColorDepth;
  /** 启动：进备用屏、开 raw mode、订阅输入、画第一帧 */
  start(): void;
  /** 停止并还原终端（幂等） */
  stop(): void;
  /** 立刻画一帧（一般不用调；变更会自动重绘） */
  paint(): RenderStats;
  /** 请求一帧（微任务合并，同一 tick 内多次调用只画一次） */
  requestPaint(): void;
  /** 把事件喂进运行时（自定义输入源 / 测试注入） */
  send(event: ButuiEvent): number;
  /**
   * 当前焦点节点 id（响应式）。
   *
   * 组件里不要直接用它 —— 用 `@butui/solid` 的 `useFocus()`，那里能拿到
   * 自己的节点（`ref`）并做 O(1) 比较。
   */
  focusedId(): number | null;
  /** 某个节点是不是焦点（O(1)，响应式） */
  isFocused(node: Node | undefined): boolean;
  /** 主动聚焦（等价于 core 的 focusNode(root, node)） */
  focus(node: Node | undefined): void;
  /**
   * 捕获后续鼠标 press/move/release/wheel 到指定节点。
   *
   * 用于拖拽：指针移出目标矩形后仍然收到 move；release 后自动释放。
   */
  captureMouse(node: Node): void;
  /** 手动释放鼠标捕获。 */
  releaseMouse(): void;
  /** 当前捕获节点；没有捕获时返回 undefined。 */
  capturedMouse(): Node | undefined;
  /** 最近一帧（hit test 与断言用） */
  frame(): Frame;
  /** 当前文本选择；没有有效选择时为 null */
  selection(): TextSelectionSnapshot | null;
  /** 当前选中文本；没有选择时为空串 */
  selectedText(): string;
  /** 清除文本选择并触发一次 `onSelection(null)`（若有） */
  clearSelection(): void;
  /** 把当前选择写 OSC 52；没有文本时返回 false */
  copySelection(): boolean;
  dispose(): void;
}

export function createTuiApp(options: TuiAppOptions): TuiApp {
  const terminal: TuiTerminal =
    options.terminal ??
    new TerminalSession({ mouseMotion: options.mouseMotion ?? "drag" });
  const root = createElement("root");

  const [size, setSize] = createSignal<TuiSize>(options.size ?? terminal.size);
  // 焦点同理：真值放局部变量，signal 只当版本号（写入延迟到 flush，读 signal 会读到旧值）
  let focusId: number | null = null;
  const [focusRev, bumpFocus] = createSignal(0);
  const focusedId = (): number | null => (focusRev(), focusId);
  const depth = (): ColorDepth => options.colorDepth ?? terminal.colorDepth;

  const selectionOptions: TextSelectionOptions | undefined =
    options.selection === false
      ? undefined
      : typeof options.selection === "object"
        ? options.selection
        : {};
  let selectionAnchor: TextSelectionPoint | undefined;
  let selectionFocus: TextSelectionPoint | undefined;
  let selecting = false;
  let selectionHasText = false;
  let capturedMouseNode: Node | undefined;
  let hoveredMouseNode: Node | undefined;
  let lastMousePress:
    | { nodeId?: number; button: MouseEvent["button"]; x: number; y: number; time: number }
    | undefined;
  let pressedMouse:
    | {
        target: Node;
        x: number;
        y: number;
        started: boolean;
      }
    | undefined;
  const mouseNow = options.mouse?.now ?? Date.now;
  const doubleClickMs = options.mouse?.doubleClickMs ?? 400;
  const dragThreshold = Math.max(0, options.mouse?.dragThreshold ?? 1);
  const frameBounds = new WeakMap<Frame, Map<number, MouseBounds>>();

  const selectionAllowed = (): boolean =>
    selectionOptions !== undefined && (selectionOptions.enabled?.() ?? true);

  const currentSelectionRange = (): TextSelectionRange | undefined => {
    if (!selectionHasText || !selectionAnchor || !selectionFocus) return undefined;
    return {
      anchor: { ...selectionAnchor },
      focus: { ...selectionFocus },
    };
  };

  const cloneSnapshot = (
    range: TextSelectionRange,
    text: string
  ): TextSelectionSnapshot => ({
    range: {
      anchor: { ...range.anchor },
      focus: { ...range.focus },
    },
    text,
  });

  const notifySelection = (snapshot: TextSelectionSnapshot | null): void => {
    selectionOptions?.onSelection?.(snapshot);
  };

  const resetSelection = (notify: boolean): void => {
    const had = selectionHasText;
    selectionAnchor = undefined;
    selectionFocus = undefined;
    selecting = false;
    selectionHasText = false;
    if (notify && had) notifySelection(null);
    requestPaint();
  };

  const refreshSelectionHighlight = (): void => {
    if (!selectionAnchor || !selectionFocus) {
      selectionHasText = false;
      return;
    }
    if (
      selectionAnchor.x === selectionFocus.x &&
      selectionAnchor.y === selectionFocus.y
    ) {
      selectionHasText = false;
      return;
    }
    const range = { anchor: selectionAnchor, focus: selectionFocus };
    selectionHasText = selectionText(computeFrame(), range) !== "";
  };

  const renderer = new Renderer(chunk => terminal.write(chunk), {
    ...(options.afterDraw !== undefined ? { afterDraw: options.afterDraw } : {}),
  });

  const scrollTop = (): number | "bottom" => {
    const requested = options.scroll?.();
    if (requested === undefined) return "bottom";
    if (requested === "top") return 0;
    return requested;
  };

  /** 当前布局（布局层按 rev 缓存，现算很便宜；不要缓存成「上一帧」） */
  const computeFrame = (): Frame => {
    const { columns, rows } = size();
    const selection = currentSelectionRange();
    return layout(root, columns, rows, {
      depth: depth(),
      scrollTop: scrollTop(),
      stickyTop: options.stickyTop ?? 0,
      stickyBottom: options.stickyBottom ?? 0,
      ...(selection ? { selection } : {}),
    });
  };

  const paint = (): RenderStats => renderer.draw(computeFrame());

  // ── 合帧：任何节点变更 → 微任务里 flush + 画一帧 ───────────────────────
  let dirty = true;
  let scheduled = false;
  let disposed = false;

  const runFrame = (): void => {
    scheduled = false;
    if (disposed) return;
    // Solid 2 的写入延迟到 flush：先提交，再决定要不要画
    flush();
    if (!dirty) return;
    dirty = false;
    paint();
    // 帧内又脏了（比如 effect 级联）→ 再排一帧
    if (dirty) requestPaint();
  };

  const requestPaint = (): void => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(runFrame);
  };

  const offMutation = onMutation(() => {
    dirty = true;
    requestPaint();
  });

  // 焦点变化 → 响应式信号（组件通过上下文读它，见 @butui/solid 的 useFocus）
  const offFocus = onFocusChange(changed => {
    if (changed !== root) return;
    focusId = getFocusState(root).current;
    bumpFocus(n => n + 1);
    requestPaint();
  });

  // ── 事件分发 ───────────────────────────────────────────────────────────
  /**
   * 处理一个事件。
   *
   * 结束前会 `flush()` —— 让这次事件引发的 signal 写入立刻落到节点树上。
   * 于是「send() 之后读 frame()」永远是一致的（不然要等下一个微任务），
   * 组件作者和测试都不用去猜 flush 时机。真正的**绘制**仍然在微任务里合并。
   */
  /**
   * 组件级全局按键（`useKeyboard`）。
   *
   * 顺序固定：应用的 `onKey` → `keymap` → 这里 → 内建（ctrl+c / tab）→
   * 焦点节点。应用永远第一优先级；组件返回 true 就吃掉这个键。
   */
  const keyListeners = new Set<(event: KeyEvent) => boolean | void>();

  const writeSelectionClipboard = (text: string): boolean => {
    if (text.length === 0) return false;
    terminal.write(osc52(text, { multiplexer: "auto" }));
    return true;
  };

  const selectionSnapshot = (): TextSelectionSnapshot | null => {
    const range = currentSelectionRange();
    if (!range) return null;
    const text = selectionText(computeFrame(), range);
    return text === "" ? null : cloneSnapshot(range, text);
  };

  const selectableTarget = (target: Node | undefined): boolean => {
    let current = target;
    while (current) {
      if (isElement(current) && current.props.selectable === false) return false;
      current = current.parent ?? undefined;
    }
    return true;
  };

  const captureMouse = (node: Node): void => {
    capturedMouseNode = node;
  };

  const releaseMouse = (): void => {
    capturedMouseNode = undefined;
  };

  const capturedMouse = (): Node | undefined => capturedMouseNode;

  const clickCountFor = (
    event: MouseEvent,
    target: Node | undefined
  ): number => {
    const time = mouseNow();
    const previous = lastMousePress;
    const closeInTime =
      previous !== undefined && time - previous.time <= doubleClickMs;
    const closeInSpace =
      previous !== undefined &&
      Math.abs(previous.x - event.x) <= 1 &&
      Math.abs(previous.y - event.y) <= 1;
    const sameTarget = previous?.nodeId === target?.id;
    const sameButton = previous?.button === event.button;
    const clickCount = closeInTime && closeInSpace && sameTarget && sameButton ? 2 : 1;

    lastMousePress =
      clickCount === 2
        ? undefined
        : {
            nodeId: target?.id,
            button: event.button,
            x: event.x,
            y: event.y,
            time,
          };
    return clickCount;
  };

  const boundsOf = (node: Node | undefined): MouseBounds | undefined => {
    if (!node) return undefined;
    const frame = computeFrame();
    let cache = frameBounds.get(frame);
    if (!cache) {
      cache = new Map();
      frameBounds.set(frame, cache);
    }
    const cached = cache.get(node.id);
    if (cached) return cached;

    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < frame.lines.length; y++) {
      const line = frame.lines[y]!;
      for (let x = 0; x < line.length; x++) {
        const cell = line[x]!;
        if (cell.node !== node.id || cell.width === 0) continue;
        if (x < left) left = x;
        if (y < top) top = y;
        if (x + cell.width > right) right = x + cell.width;
        if (y + 1 > bottom) bottom = y + 1;
      }
    }
    if (right < 0 || bottom < 0) return undefined;
    const bounds = { x: left, y: top, width: right - left, height: bottom - top };
    cache.set(node.id, bounds);
    return bounds;
  };

  const applyLocalCoordinates = (
    event: MouseEvent,
    target: Node | undefined
  ): void => {
    const bounds = boundsOf(target);
    if (!bounds) {
      delete event.localX;
      delete event.localY;
      return;
    }
    event.localX = event.x - bounds.x;
    event.localY = event.y - bounds.y;
  };

  const dispatchSyntheticMouse = (
    action: MouseEvent["action"],
    target: Node | undefined,
    source: MouseEvent,
    options: { button?: MouseEvent["button"]; bubble?: boolean } = {}
  ): { delivered: number; event?: MouseEvent } => {
    if (!target) return { delivered: 0 };
    const event = eventTarget({
      type: "mouse" as const,
      action,
      button: options.button ?? "none",
      x: source.x,
      y: source.y,
      modifiers: source.modifiers,
    }) as MouseEvent;
    applyLocalCoordinates(event, target);
    const delivered = dispatchEvent(target, event, {
      bubble: options.bubble ?? false,
    });
    return { delivered, event };
  };

  const dispatchHover = (
    action: "enter" | "leave",
    target: Node | undefined,
    source: MouseEvent
  ): number => dispatchSyntheticMouse(action, target, source).delivered;

  const updateMouseHover = (
    event: MouseEvent,
    target: Node | undefined
  ): void => {
    if (target === hoveredMouseNode) return;
    const previous = hoveredMouseNode;
    hoveredMouseNode = target;
    dispatchHover("leave", previous, event);
    dispatchHover("enter", target, event);
    requestPaint();
  };

  const beginMouseDrag = (
    event: MouseEvent,
    target: Node | undefined
  ): void => {
    if (event.button !== "left" || !target) return;
    pressedMouse = {
      target,
      x: event.x,
      y: event.y,
      started: false,
    };
  };

  const updateMouseDrag = (event: MouseEvent): number => {
    if (!pressedMouse) return 0;
    const distance = Math.max(
      Math.abs(event.x - pressedMouse.x),
      Math.abs(event.y - pressedMouse.y)
    );
    if (!pressedMouse.started && distance < dragThreshold) return 0;

    const target = capturedMouseNode ?? pressedMouse.target;
    let delivered = 0;
    if (!pressedMouse.started) {
      pressedMouse.started = true;
      delivered += dispatchSyntheticMouse("dragstart", target, event, {
        button: "left",
        bubble: true,
      }).delivered;
    }
    delivered += dispatchSyntheticMouse("drag", target, event, {
      button: "left",
      bubble: true,
    }).delivered;
    return delivered;
  };

  const endMouseDrag = (event: MouseEvent): number => {
    if (!pressedMouse) return 0;
    const target = capturedMouseNode ?? pressedMouse.target;
    const delivered = pressedMouse.started
      ? dispatchSyntheticMouse("dragend", target, event, {
          button: "left",
          bubble: true,
        }).delivered
      : 0;
    pressedMouse = undefined;
    return delivered;
  };

  /**
   * 返回是否消费了这次鼠标事件。
   *
   * 按下和松开仍要参与普通 hit test（否则第一次点击列表会失效）；拖动 move
   * 只归选择器，避免 1002 mouse-motion 被当成连续 click。
   */
  const handleSelectionMouse = (event: MouseEvent, target?: Node): boolean => {
    if (!selectionOptions) return false;
    if (!selecting && !selectionAllowed()) return false;

    if (event.action === "press") {
      if (event.button !== "left" || !selectableTarget(target)) {
        if (selecting || selectionHasText) resetSelection(true);
        return false;
      }
      const replacing = selectionHasText;
      selectionAnchor = { x: event.x, y: event.y };
      selectionFocus = { ...selectionAnchor };
      selecting = true;
      selectionHasText = false;
      if (replacing) notifySelection(null);
      requestPaint();
      return true;
    }

    if (event.action === "move") {
      if (!selecting) return false;
      selectionFocus = { x: event.x, y: event.y };
      refreshSelectionHighlight();
      requestPaint();
      return true;
    }

    if (event.action === "release") {
      if (!selecting) return false;
      selectionFocus = { x: event.x, y: event.y };
      selecting = false;
      refreshSelectionHighlight();
      const range = currentSelectionRange();
      const text = range ? selectionText(computeFrame(), range) : "";
      if (!range || text === "") {
        const had = selectionHasText;
        selectionHasText = false;
        if (had) notifySelection(null);
        requestPaint();
        return true;
      }
      selectionHasText = true;
      if (selectionOptions.copyOnSelect ?? true) writeSelectionClipboard(text);
      notifySelection(cloneSnapshot(range, text));
      requestPaint();
      return true;
    }

    return false;
  };

  const send = (event: ButuiEvent): number => {
    const delivered = dispatch(event);
    flush();
    return delivered;
  };

  const dispatch = (event: ButuiEvent): number => {
    if (event.type === "key") {
      // 1) 应用级键位优先：模态 / 全局快捷键
      if (options.onKey?.(event) === true) return 1;
      // 2) 结构化 keymap
      if (options.keymap?.handle(event) === true) return 1;
      // 3) 组件级全局按键（useKeyboard），按注册顺序
      for (const listener of [...keyListeners]) {
        if (listener(event) === true) return 1;
      }
      // 4) 内建：退出与焦点循环
      if ((options.quitOnCtrlC ?? true) && event.modifiers.ctrl && event.name === "c") {
        quit();
        return 1;
      }
      if ((options.tabFocus ?? true) && event.name === "tab") {
        if (event.modifiers.shift) focusPrev(root);
        else focusNext(root);
        requestPaint();
        return 1;
      }
      // 5) 派发给焦点节点（向上冒泡）
      return dispatchEvent(focusedNode(root) ?? root, event);
    }

    if (event.type === "mouse") {
      const hitTarget = nodeById(root, computeFrame().nodeAt(event.x, event.y));
      const target = capturedMouseNode ?? hitTarget;
      applyLocalCoordinates(event, target);
      if (event.action === "press") {
        endMouseDrag(event);
        event.clickCount = clickCountFor(event, target);
        if (!capturedMouseNode && !selecting) updateMouseHover(event, hitTarget);
        beginMouseDrag(event, target);
      }
      if (
        !capturedMouseNode &&
        !pressedMouse &&
        event.action === "move" &&
        !selecting
      ) {
        updateMouseHover(event, hitTarget);
      }
      const dragDelivered =
        event.action === "move" ? updateMouseDrag(event) : 0;
      const selectionHandled = handleSelectionMouse(event, target);
      // move 由选择器消费；press / release 仍按普通 hit test 派发，
      // 保证点击组件和拖拽选择可以共存。
      if (event.action === "move" && selectionHandled && dragDelivered === 0) {
        return 1;
      }
      const delivered = dispatchEvent(target, event);
      const dragEndDelivered =
        event.action === "release" ? endMouseDrag(event) : 0;
      if (delivered === 0 && dragDelivered === 0 && dragEndDelivered === 0) {
        options.onMouse?.(event);
      }
      if (event.action === "release" && capturedMouseNode) releaseMouse();
      return (
        delivered ||
        dragDelivered ||
        dragEndDelivered ||
        (selectionHandled ? 1 : 0)
      );
    }

    if (event.type === "paste") {
      const delivered = dispatchEvent(focusedNode(root) ?? root, event);
      if (delivered === 0) options.onPaste?.(event);
      return delivered;
    }

    return dispatchEvent(root, event);
  };

  // ── 生命周期 ───────────────────────────────────────────────────────────
  let disposers: Array<() => void> = [];
  let started = false;

  const quit = (): void => {
    stop();
    if (options.onQuit) options.onQuit();
    else process.exit(0);
  };

  function start(): void {
    if (started || disposed) return;
    started = true;

    // 视图挂到 root 上，外面包一层焦点上下文；Solid 的写入会在 flush 里提交
    const disposeView = render(
      () =>
        provideAppScope(
          {
            size,
            colorDepth: depth,
            requestPaint,
            onKey: listener => {
              keyListeners.add(listener);
              return () => keyListeners.delete(listener);
            },
            captureMouse,
            releaseMouse,
            capturedMouse,
          },
          () =>
            provideFocusScope(
              {
                focusedId,
                focus: node => focusNode(root, node),
                trap: node => trapFocus(root, node),
              },
              () => options.view(app)
            ) as Node
        ) as Node,
      root
    );

    disposers.push(
      disposeView,
      terminal.onEvent(send),
      terminal.onResize(next => {
        if (selectionHasText || selecting) resetSelection(true);
        setSize(next);
        renderer.invalidate(); // 尺寸变了必须整屏重画
        // 和 send() 一样立刻提交：resize 之后马上读 frame() 必须是一致的
        flush();
        requestPaint();
      })
    );

    terminal.start();
    flush();
    dirty = false;
    paint();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    pressedMouse = undefined;
    hoveredMouseNode = undefined;
    capturedMouseNode = undefined;
    for (const dispose of disposers.splice(0)) dispose();
    terminal.stop();
  }

  const dispose = (): void => {
    if (disposed) return;
    stop();
    offMutation();
    offFocus();
    disposed = true;
  };

  const app: TuiApp = {
    root,
    size,
    colorDepth: depth,
    start,
    stop,
    paint,
    requestPaint,
    send,
    focusedId,
    isFocused: node => node !== undefined && node.id === focusedId(),
    focus: node => focusNode(root, node),
    captureMouse,
    releaseMouse,
    capturedMouse,
    frame: computeFrame,
    selection: selectionSnapshot,
    selectedText: () => selectionSnapshot()?.text ?? "",
    clearSelection: () => resetSelection(true),
    copySelection: () => writeSelectionClipboard(selectionSnapshot()?.text ?? ""),
    dispose,
  };

  if (options.autoStart ?? true) start();
  return app;
}
