/**
 * 给 `bun test` 注册 DOM 环境（WebUI 测试用）。
 *
 * happy-dom 20 不再随包提供 `@happy-dom/global-registrator`，这里手动把
 * `Window` 上的构造器挂到 globalThis —— 必须在任何 `@solidjs/web` 模块被
 * import 之前执行，所以放在 preload 里。
 */
import { Window } from "happy-dom";

const window = new Window({ url: "https://localhost/" });

const globals = [
  "window", "document", "navigator", "location", "history", "localStorage", "sessionStorage",
  "CustomEvent", "Event", "EventTarget", "Node", "Element", "HTMLElement", "HTMLDivElement",
  "HTMLButtonElement", "HTMLInputElement", "Text", "Comment", "DocumentFragment",
  "MutationObserver", "ResizeObserver", "IntersectionObserver", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "matchMedia",
] as const;

for (const key of globals) {
  const value = (window as unknown as Record<string, unknown>)[key];
  if (value !== undefined) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
}
(globalThis as unknown as { window: unknown }).window = window;
