/**
 * 测试基建 —— SPEC §15「headless renderer / snapshot / event injection」。
 *
 * 全部在内存里跑：没有 PTY、没有 ANSI 输出，直接拿到 cell 网格。
 * 这样快照测试和 hit test 断言都不需要解析转义序列。
 */
import {
  type ButuiEvent,
  type ColorDepth,
  type KeyEvent,
  type MouseEvent,
  type Node,
  createElement,
  createModifiers,
  dispatchEvent,
  eventTarget,
  focusNode,
  getFocusState,
  onFocusChange,
  trapFocus,
  walk,
} from "@butui/core";
import { type Frame, layout } from "@butui/layout";
import { type RenderStats, Renderer, plainText } from "@butui/renderer";
import { provideAppScope, provideFocusScope, render } from "@butui/solid";
import { createSignal, flush } from "solid-js";

export interface MountOptions {
  width?: number;
  height?: number;
  depth?: ColorDepth;
  /**
   * 视口位置，默认 `0`（顶部）。`"bottom"` 就是聊天式贴底 —— 组件测试要验
   * 「转录跟着长」时必须给这个，否则永远看到第一屏。
   */
  scroll?: number | "bottom";
  /** 固定页眉行数（SPEC §5.13） */
  stickyTop?: number;
  /** 固定页脚行数 */
  stickyBottom?: number;
}

export interface Mounted {
  readonly root: Node;
  /** 触发 Solid 的 effect 队列（测试里改完 signal 记得调） */
  flush(): void;
  frame(): Frame;
  text(): string;
  /** 语义 hit test（SPEC §4.2） */
  semanticAt(x: number, y: number): string | undefined;
  nodeAt(x: number, y: number): number | undefined;
  /** 注入一次按键；默认发给当前焦点节点 */
  key(name: string, text?: string, modifiers?: Partial<KeyEvent["modifiers"]>): number;
  /** 注入一次鼠标点击（坐标是 0-based cell） */
  click(x: number, y: number, button?: MouseEvent["button"]): number;
  wheel(x: number, y: number): number;
  resize(width: number, height: number): void;
  /** 把整帧喂给渲染器，返回差分统计 —— 用来断言「不整屏闪烁」 */
  paint(): RenderStats;
  unmount(): void;
}

/**
 * 组件的返回类型放宽到 unknown：Solid 的 `JSX.Element` 包含 string / number /
 * null（文本插值），类型上收不到我们的 Node。顶层挂载永远是元素节点，运行时
 * 由 host ops 保证。
 */
export function mount(component: () => unknown, options: MountOptions = {}): Mounted {
  const width = options.width ?? 80;
  const height = options.height ?? 24;
  const depth = options.depth ?? "truecolor";

  let columns = width;
  let rows = height;
  const root = createElement("root");

  // 与 @butui/runtime 一致：把焦点作用域提供给视图，组件里的 useFocus() 才有意义
  const [focusedId, setFocusedId] = createSignal<number | null>(null);
  const offFocus = onFocusChange(changed => {
    if (changed === root) setFocusedId(getFocusState(root).current);
  });
  /** 组件级全局按键（`useKeyboard`）—— 和 runtime 同一套语义 */
  const keyListeners = new Set<(event: KeyEvent) => boolean | void>();
  const dispose = render(
    () =>
      provideAppScope(
        {
          size: () => ({ columns, rows }),
          colorDepth: () => depth,
          requestPaint: () => {},
          onKey: listener => {
            keyListeners.add(listener);
            return () => keyListeners.delete(listener);
          },
          rootNode: () => root,
        },
        () =>
          provideFocusScope(
            {
              focusedId,
              focus: node => focusNode(root, node),
              trap: node => trapFocus(root, node),
            },
            () => component()
          ) as Node
      ) as Node,
    root
  );
  flush();

  let output = "";
  const renderer = new Renderer(chunk => {
    output += chunk;
  });

  const frame = () =>
    layout(root, columns, rows, {
      depth,
      scrollTop: options.scroll ?? 0,
      stickyTop: options.stickyTop ?? 0,
      stickyBottom: options.stickyBottom ?? 0,
    });

  return {
    root,
    flush: () => flush(),
    frame,
    text: () => plainText(frame()),
    semanticAt: (x, y) => frame().semanticAt(x, y),
    nodeAt: (x, y) => frame().nodeAt(x, y),
    key(name, text, modifiers) {
      const target = focusedNode(root);
      const event = eventTarget({
        type: "key" as const,
        name,
        text,
        modifiers: createModifiers(
          modifiers?.ctrl ?? false,
          modifiers?.alt ?? false,
          modifiers?.shift ?? false,
          modifiers?.meta ?? false
        ),
      }) as KeyEvent;
      // 组件级全局按键先跑（应用级在测试里直接调 useKeyboard 之外的东西）
      for (const listener of [...keyListeners]) {
        if (listener(event) === true) return 1;
      }
      return dispatchEvent(target ?? root, event);
    },
    click(x, y, button = "left") {
      const current = frame();
      const target = nodeById(root, current.nodeAt(x, y));
      const event = eventTarget({
        type: "mouse" as const,
        action: "press" as const,
        button,
        x,
        y,
        modifiers: createModifiers(),
      }) as MouseEvent;
      return dispatchEvent(target, event);
    },
    wheel(x, y) {
      const current = frame();
      const target = nodeById(root, current.nodeAt(x, y));
      const event = eventTarget({
        type: "mouse" as const,
        action: "wheel" as const,
        button: "none" as const,
        x,
        y,
        modifiers: createModifiers(),
      }) as MouseEvent;
      return dispatchEvent(target, event);
    },
    resize(nextWidth, nextHeight) {
      columns = nextWidth;
      rows = nextHeight;
      renderer.invalidate();
    },
    paint() {
      return renderer.draw(frame());
    },
    unmount() {
      offFocus();
      dispose();
    },
  };
}

/** 渲染成纯文本，最常用的断言入口 */
export function renderText(component: () => unknown, options: MountOptions = {}): string {
  const app = mount(component, options);
  try {
    return app.text();
  } finally {
    app.unmount();
  }
}

/** 渲染 + 语义标注快照：把每行的语义归属也记下来，便于断言 hit test */
export function renderSnapshot(
  component: () => unknown,
  options: MountOptions = {}
): { text: string; semantics: Array<Array<string | undefined>> } {
  const app = mount(component, options);
  try {
    const current = app.frame();
    return {
      text: plainText(current),
      semantics: current.lines.map(line => line.map(cell => cell.semantic)),
    };
  } finally {
    app.unmount();
  }
}

function focusedNode(root: Node): Node | undefined {
  const state = getFocusState(root);
  if (state.current === null) return undefined;
  return nodeById(root, state.current);
}

function nodeById(root: Node, id: number | undefined): Node | undefined {
  if (id === undefined) return undefined;
  for (const node of walk(root)) if (node.id === id) return node;
  return undefined;
}

export { focusNode, getFocusState };
export type { ButuiEvent };
