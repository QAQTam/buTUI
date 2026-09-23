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
  focusNext,
  focusNode,
  focusPrev,
  focusedNode,
  getFocusState,
  nodeById,
  onFocusChange,
  onMutation,
  trapFocus,
} from "@butui/core";
import { type Frame, layout } from "@butui/layout";
import { type RenderStats, Renderer } from "@butui/renderer";
import { provideAppScope, provideFocusScope, render } from "@butui/solid";
import { TerminalSession, terminalSize } from "@butui/terminal";
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
  /** 应用级鼠标：**焦点节点没处理时**才会走到这里（比如语义动作分发） */
  onMouse?: (event: MouseEvent) => boolean | void;
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
  /** 最近一帧（hit test 与断言用） */
  frame(): Frame;
  dispose(): void;
}

export function createTuiApp(options: TuiAppOptions): TuiApp {
  const terminal: TuiTerminal = options.terminal ?? new TerminalSession();
  const root = createElement("root");

  const [size, setSize] = createSignal<TuiSize>(options.size ?? terminal.size);
  // 焦点同理：真值放局部变量，signal 只当版本号（写入延迟到 flush，读 signal 会读到旧值）
  let focusId: number | null = null;
  const [focusRev, bumpFocus] = createSignal(0);
  const focusedId = (): number | null => (focusRev(), focusId);
  const depth = (): ColorDepth => options.colorDepth ?? terminal.colorDepth;

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
    return layout(root, columns, rows, {
      depth: depth(),
      scrollTop: scrollTop(),
      stickyTop: options.stickyTop ?? 0,
      stickyBottom: options.stickyBottom ?? 0,
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
   * 顺序固定：应用的 `onKey` → 这里 → 内建（ctrl+c / tab）→ 焦点节点。
   * 应用永远第一优先级；组件返回 true 就吃掉这个键。
   */
  const keyListeners = new Set<(event: KeyEvent) => boolean | void>();

  const send = (event: ButuiEvent): number => {
    const delivered = dispatch(event);
    flush();
    return delivered;
  };

  const dispatch = (event: ButuiEvent): number => {
    if (event.type === "key") {
      // 1) 应用级键位优先：模态 / 全局快捷键
      if (options.onKey?.(event) === true) return 1;
      // 2) 组件级全局按键（useKeyboard），按注册顺序
      for (const listener of [...keyListeners]) {
        if (listener(event) === true) return 1;
      }
      // 3) 内建：退出与焦点循环
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
      // 4) 派发给焦点节点（向上冒泡）
      return dispatchEvent(focusedNode(root) ?? root, event);
    }

    if (event.type === "mouse") {
      const target = nodeById(root, computeFrame().nodeAt(event.x, event.y));
      const delivered = dispatchEvent(target, event);
      if (delivered === 0) options.onMouse?.(event);
      return delivered;
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
    frame: computeFrame,
    dispose,
  };

  if (options.autoStart ?? true) start();
  return app;
}
