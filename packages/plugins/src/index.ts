/**
 * `@butui/plugins` —— 通用 TUI 插件 / Slot 协议。
 *
 * 根入口保持 renderer-agnostic，并且不碰 Bun 文件系统 API：只要宿主是对象、
 * Slot 有节点类型，就能复用。Solid JSX 适配见 `@butui/plugins/solid`；
 * manifest / 配置 / 动态加载见 `@butui/plugins/loader`。
 */
export * from "./types.ts";
export * from "./capability.ts";
export * from "./capability-policy.ts";
export * from "./cgroup.ts";
export * from "./approval.ts";
export * from "./capability-proxy.ts";
export * from "./process-rpc.ts";
export * from "./process-spawn.ts";
export * from "./rpc-handshake.ts";
export * from "./worker-rpc.ts";
export * from "./worker-supervisor.ts";
export * from "./registry.ts";
