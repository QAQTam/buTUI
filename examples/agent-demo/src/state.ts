/**
 * Demo 的 agent 状态 —— 形状对齐 SPEC §7 的数据模型。
 *
 * 真实实现里这些状态来自事件协议（SPEC §13），这里用定时器模拟流式输出，
 * 目的只是证明 UI 层能正确响应。
 */
import { createSignal } from "solid-js";

export interface ToolRun {
  name: string;
  status: "running" | "success";
  ms?: number;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tool?: ToolRun;
  streaming?: boolean;
}

export interface Todo {
  id: string;
  label: string;
  done: boolean;
}

export interface PermissionRequest {
  id: string;
  tool: string;
  detail: string;
  /** SPEC §8.5：不可逆操作必须显式提示 */
  irreversible: boolean;
}

let seq = 0;
export const nextId = (prefix: string): string => `${prefix}-${++seq}`;

export const [messages, setMessages] = createSignal<AgentMessage[]>([
  {
    id: nextId("m"),
    role: "user",
    text: "帮我重构 auth 模块，顺便看看 SPEC 的可行性",
  },
  {
    id: nextId("m"),
    role: "assistant",
    text: "先读一下 src/auth.ts 和 buTUI/SPEC.md。",
    tool: { name: "read_file src/auth.ts", status: "success", ms: 12 },
  },
]);

export const [todos, setTodos] = createSignal<Todo[]>([
  { id: nextId("t"), label: "读 SPEC", done: true },
  { id: nextId("t"), label: "验证 Solid 2 RC universal", done: true },
  { id: nextId("t"), label: "验证 Bun 原生 API", done: false },
  { id: nextId("t"), label: "写 undo preview", done: false },
]);

export const [input, setInput] = createSignal("");
export const [selected, setSelected] = createSignal<string | null>(null);
export const [permission, setPermission] = createSignal<PermissionRequest | null>(null);
export const [size, setSize] = createSignal({ columns: 80, rows: 24 });
export const [status, setStatus] = createSignal("ready");

const REPLIES = [
  "Solid 2 RC 的 createRenderer 契约直接可用，host ops 只有 13 个。",
  "Bun.stringWidth / wrapAnsi / sliceAnsi 覆盖了文本层最难的部分。",
  "布局、cell buffer、输入解析这三块要自己写，其余都能靠主线 API。",
];

let replyIndex = 0;

/** 模拟一次 agent turn：先跑一个 tool，再流式吐字 */
export function submitInput(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const userMessage: AgentMessage = { id: nextId("m"), role: "user", text: trimmed };
  const assistantId = nextId("m");
  const assistant: AgentMessage = {
    id: assistantId,
    role: "assistant",
    text: "",
    streaming: true,
    tool: { name: "grep -rn auth src/", status: "running" },
  };

  setMessages(list => [...list, userMessage, assistant]);
  setInput("");
  setStatus("running");

  // 工具调用完成
  setTimeout(() => {
    setMessages(list =>
      list.map(m =>
        m.id === assistantId ? { ...m, tool: { name: "grep -rn auth src/", status: "success", ms: 7 } } : m
      )
    );
  }, 350);

  // 流式吐字
  const reply = REPLIES[replyIndex++ % REPLIES.length];
  let index = 0;
  const timer = setInterval(() => {
    index += 2;
    const done = index >= reply.length;
    setMessages(list =>
      list.map(m =>
        m.id === assistantId
          ? { ...m, text: reply.slice(0, index), streaming: !done }
          : m
      )
    );
    if (done) {
      clearInterval(timer);
      setStatus("ready");
      // 顺便弹一个权限请求，演示 modal + focus trap
      setPermission({
        id: nextId("perm"),
        tool: "bash",
        detail: "rm -rf node_modules && bun install",
        irreversible: true,
      });
    }
  }, 30);
}

export function respondPermission(allow: boolean): void {
  const request = permission();
  if (!request) return;
  setPermission(null);
  setStatus(allow ? `已授权 ${request.tool}` : `已拒绝 ${request.tool}`);
}

export function toggleTodo(id: string): void {
  setTodos(list => list.map(t => (t.id === id ? { ...t, done: !t.done } : t)));
}
