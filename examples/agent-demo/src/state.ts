/**
 * Demo 的 agent 状态 —— 形状对齐 SPEC §7 的数据模型。
 *
 * 真实实现里这些状态来自事件协议（SPEC §13），这里用定时器模拟流式输出，
 * 目的只是证明 UI 层能正确响应。
 */
import { createSignal } from "solid-js";
import { type StreamSource, createMarkdownStream } from "@butui/stream";

export interface ToolRun {
  name: string;
  status: "running" | "success";
  ms?: number;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 正在流式输出时挂一个 markdown 流；结束后置空，退回普通 text */
  source?: StreamSource;
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
  "**结论**：`@solidjs/universal` 的 `createRenderer` 契约直接可用，host ops 只有 13 个。\n\n" +
    "- 文本层交给 `Bun.stringWidth` / `wrapAnsi` / `sliceAnsi`\n" +
    "- 布局、cell buffer、输入解析要自己写\n\n" +
    "> 其余都能靠 Bun 主线 API 撑住。",
  "流式渲染的关键是**增量定稿边界**：\n\n" +
    "1. 纯文本 —— 最后一个空格之前\n" +
    "2. markdown —— 块状态机 + 内联定界符闭合\n\n" +
    "这样每条 delta 都是 `O(delta + W)`。",
  "实测数据：\n\n" +
    "| N | 每次 delta |\n" +
    "|---|---|\n" +
    "| 100 | 0.007ms |\n" +
    "| 9000 | 0.002ms |\n\n" +
    "与已累积长度无关。",
];

let replyIndex = 0;

/** 模拟一次 agent turn：先跑一个 tool，再流式吐字 */
export function submitInput(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const userMessage: AgentMessage = { id: nextId("m"), role: "user", text: trimmed };
  const assistantId = nextId("m");
  const source = createMarkdownStream({ width: Math.max(20, size().columns - 8) });
  const assistant: AgentMessage = {
    id: assistantId,
    role: "assistant",
    text: "",
    source,
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
    const chunk = reply.slice(index, index + 3);
    index += 3;
    if (chunk) source.push(chunk);
    const done = index >= reply.length;
    if (done) {
      clearInterval(timer);
      source.flush();
      setMessages(list =>
        list.map(m => (m.id === assistantId ? { ...m, streaming: false, source } : m))
      );
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
