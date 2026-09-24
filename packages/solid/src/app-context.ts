/**
 * 应用上下文 —— 让**任意深度的组件**读到「这台终端」的信息。
 *
 * 焦点上下文（`focus-context.ts`）解决的是「我是不是焦点」；这里解决的是
 * 「现在多宽多高 / 什么色深 / 想订阅全局按键」。两者都由 runtime 提供，
 * 组件只依赖 `@butui/solid` 的 hook，不认识 runtime。
 *
 * ```tsx
 * const size = useSize();                  // 响应式，resize 后自动更新
 * useKeyboard(event => {                   // 全局按键：返回 true 即消费
 *   if (event.name === "escape") return close();
 * });
 * ```
 *
 * 按键顺序（SPEC §5.11 的契约）：`createTuiApp({ onKey })` →
 * `createTuiApp({ keymap })` → 组件的 `useKeyboard` → 内建（ctrl+c / tab）→
 * 焦点节点冒泡。应用永远是第一优先级，组件只能在「应用没要」的前提下抢键。
 */
import type { ColorDepth, KeyEvent } from "@butui/core";
import { createContext, onCleanup, useContext } from "solid-js";

export interface AppSize {
  columns: number;
  rows: number;
}

export interface AppScope {
  /** 终端尺寸（响应式） */
  size(): AppSize;
  /** 色彩能力（响应式：终端可能在运行中改变上报） */
  colorDepth(): ColorDepth;
  /** 请求重绘。一般不用 —— 节点变更会自动触发 */
  requestPaint(): void;
  /** 订阅全局按键；返回退订函数。返回 `true` 表示消费掉这个键 */
  onKey(listener: (event: KeyEvent) => boolean | void): () => void;
}

const AppContext = createContext<AppScope | null>(null);

/** `children` 必须是 getter —— 原因同 focus-context（provider 延迟读取） */
export function provideAppScope(scope: AppScope, children: () => unknown): unknown {
  return AppContext({
    value: scope,
    get children() {
      return children() as never;
    },
  });
}

/** 拿完整上下文；在 runtime 之外（比如单独渲染组件）返回 null */
export function useAppScope(): AppScope | null {
  return useContext(AppContext);
}

/**
 * 终端尺寸。没有 runtime 时返回恒为 `{columns: 0, rows: 0}` 的访问器 ——
 * 组件退化成「按内容自然宽」，而不是抛异常。
 */
export function useSize(): () => AppSize {
  const scope = useContext(AppContext);
  if (!scope) return () => ({ columns: 0, rows: 0 });
  return () => scope.size();
}

/** 色彩能力；没有 runtime 时按 truecolor 处理 */
export function useColorDepth(): () => ColorDepth {
  const scope = useContext(AppContext);
  if (!scope) return () => "truecolor";
  return () => scope.colorDepth();
}

export interface UseKeyboardOptions {
  /** 临时关掉（比如「只在弹窗打开时接管」） */
  enabled?: () => boolean;
}

/**
 * 订阅全局按键。**组件卸载时自动退订**。
 *
 * 回调返回 `true` 表示已消费：后面的组件监听器、内建键位、焦点节点都不会
 * 再收到这个键。不返回（或返回 false）就是「只是看看」。
 */
export function useKeyboard(
  listener: (event: KeyEvent) => boolean | void,
  options: UseKeyboardOptions = {}
): void {
  const scope = useContext(AppContext);
  if (!scope) return;
  const dispose = scope.onKey(event => {
    if (options.enabled && !options.enabled()) return;
    return listener(event);
  });
  onCleanup(dispose);
}
