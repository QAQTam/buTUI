/**
 * Demo 的 UI 局部状态。
 *
 * agent 状态（消息 / turn / tool / todo / 权限）全部由 `@butui/agent` 的
 * Session 持有；窗口尺寸由 `@butui/runtime` 持有；这里只剩「输入框内容」这种
 * 纯 UI 状态。
 */
import { createSignal } from "solid-js";

export const [status, setStatus] = createSignal("ready");

/** 当前是否有待响应的权限请求（由 main.ts 从 session 同步过来） */
export const [permission, setPermission] = createSignal(false);
