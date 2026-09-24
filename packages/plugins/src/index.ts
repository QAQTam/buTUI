/**
 * `@butui/plugins` —— 通用 TUI 插件 / Slot 协议。
 *
 * 根入口保持 renderer-agnostic：只要宿主是对象、Slot 有节点类型，就能复用。
 * Solid JSX 适配见 `@butui/plugins/solid`。
 */
export * from "./types.ts";
export * from "./registry.ts";
