/**
 * 事件协议 —— SPEC §13。
 *
 * 这是 buTUI 的主干：UI 不直接读 agent 的内部状态，只消费事件流；UI 不直接调
 * agent 的方法，只发命令。这样 WebUI / remote attach / 回放 / 测试注入都只是
 * 「换个传输层」。
 *
 * 传输格式用 **NDJSON**（SPEC §18 第 9 问）：一行一个 JSON，天然支持流式读写、
 * 断行恢复、以及 `git diff` 式的可读回放。
 */
import type { DiffPatch } from "@butui/stream";

// ── 数据模型（SPEC §7）──────────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  /** 单调递增的消息序号，分支/undo 的锚点 */
  msgid: number;
  turnId: string;
  role: "system" | "user" | "assistant" | "tool";
  origin: "system" | "user" | "assistant" | "tool" | "inject";
  createdAt: number;
  parentId?: string;
  branchId: string;
  /** 纯文本累积（流式时由 StreamSource 承载，这里保存最终值） */
  text: string;
  /** 是否正在流式输出 */
  streaming?: boolean;
}

export interface Turn {
  id: string;
  branchId: string;
  startMsgId: number;
  endMsgId?: number;
  status: "running" | "completed" | "aborted" | "failed";
  reason?: string;
}

export interface ToolCall {
  id: string;
  turnId: string;
  name: string;
  args: unknown;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  reversible: boolean;
  startedAt?: number;
  endedAt?: number;
  /** 流式输出（工具进度 / 结果） */
  output?: string;
}

export interface ToolResult {
  status: "success" | "error";
  output?: string;
  error?: string;
  /**
   * 该工具对工作区造成的变更（SPEC §8.4）。
   *
   * 由**工具执行器**填：它知道改前的内容和改后的内容。buTUI 拿到之后
   * 自己算 diff / hash 并写进 journal，于是 undo 预览可以本地推导出来，
   * 不需要 agent 额外告诉 UI「会影响什么」。
   */
  workspace?: Array<{ path: string; before: string; after: string }>;
}

export interface Todo {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "completed";
}

export interface Checkpoint {
  id: string;
  branchId: string;
  msgid: number;
  kind: "conversation" | "workspace" | "todo" | "full";
  createdAt: number;
}

export interface Branch {
  id: string;
  parentBranchId?: string;
  fromMsgId?: number;
  createdAt: number;
  label?: string;
}

export interface Artifact {
  id: string;
  kind: "image" | "diff" | "log" | "table" | "json" | "file" | "chart";
  source: string;
  mime?: string;
  createdAt: number;
  toolCallId?: string;
}

export interface PermissionRequest {
  id: string;
  tool: string;
  detail: string;
  /** SPEC §8.5：不可逆操作必须显式提示 */
  irreversible: boolean;
}

export interface AskUserQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
}

export interface UndoEffect {
  kind: "messages" | "files" | "todo" | "permission";
  description: string;
  count?: number;
  irreversible?: boolean;
}

/**
 * token 用量（SPEC §11.3 Context Inspector）。
 *
 * 两组数刻意分开，因为它们**不能互相推导**：
 *
 * - `input` / `output` / `cached` 是**这一次调用**的增量，累加起来才是会话
 *   总账（计费 / 统计）。
 * - `contextTokens` / `contextWindow` 是**当前**上下文占用与窗口上限（画占用
 *   条）。上下文看的是「最近一次请求塞了多少」，不是会话累计 —— 拿累计值去除
 *   窗口会立刻超过 100%。
 *
 * `contextTokens` 省略时按本次 `input` 估算（大多数 provider 就是这么报的）。
 */
export interface Usage {
  input: number;
  output: number;
  /** 命中 provider 前缀缓存的 token 数（能拿到时才有） */
  cached?: number;
  /** 当前上下文占用（最近一次请求的输入规模） */
  contextTokens?: number;
  /** 上下文窗口上限 */
  contextWindow?: number;
}

/**
 * 累加一次 usage。
 *
 * 增量部分相加；上下文占用 / 窗口取**最近一次**报告的值。应用侧可以用它把
 * provider 的分次上报合成会话总账（`Session` 内部也是这么做的）。
 */
export function mergeUsage(total: Usage, delta: Usage): Usage {
  const merged: Usage = {
    input: total.input + delta.input,
    output: total.output + delta.output,
  };
  const cached = (total.cached ?? 0) + (delta.cached ?? 0);
  if (cached > 0) merged.cached = cached;
  // 上下文占用：优先用这次显式报的，其次退回本次 input，最后沿用上一次
  const contextTokens = delta.contextTokens ?? delta.input;
  const carried = contextTokens > 0 ? contextTokens : total.contextTokens;
  if (carried !== undefined) merged.contextTokens = carried;
  const window = delta.contextWindow ?? total.contextWindow;
  if (window !== undefined) merged.contextWindow = window;
  return merged;
}

// ── Agent → UI（SPEC §13.1）─────────────────────────────────────────────────

export type AgentEvent =
  | { type: "turn.start"; turnId: string }
  | { type: "text.delta"; turnId: string; delta: string }
  | { type: "reasoning.delta"; turnId: string; delta: string }
  | { type: "usage"; usage: Usage }
  | { type: "tool.start"; call: ToolCall }
  | { type: "tool.progress"; callId: string; chunk: string }
  | { type: "tool.diff"; callId: string; patch: DiffPatch; final?: boolean }
  | { type: "tool.result"; callId: string; result: ToolResult }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "ask_user.request"; questions: AskUserQuestion[] }
  | { type: "todo.update"; todos: Todo[] }
  | { type: "artifact.add"; artifact: Artifact }
  | { type: "checkpoint.create"; checkpoint: Checkpoint }
  | { type: "undo.preview"; target: string; effects: UndoEffect[] }
  | { type: "undo.apply"; target: string; mode: "branch" | "revert" }
  | { type: "branch.create"; from: string; branchId: string }
  | { type: "branch.switch"; branchId: string }
  | { type: "revert.conflict"; files: string[] }
  | { type: "turn.end"; turnId: string; reason: string }
  | { type: "error"; message: string };

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

// ── UI → Agent（SPEC §13.2）─────────────────────────────────────────────────

export type UiCommand =
  | { type: "user.submit"; text: string }
  | { type: "cancel" }
  | { type: "permission.respond"; id: string; allow: boolean }
  | { type: "ask_user.respond"; id: string; answers: unknown[] }
  | { type: "mode.set"; mode: SandboxMode }
  | { type: "session.fork"; msgid: number }
  | { type: "undo.preview"; target: string }
  | { type: "undo.apply"; target: string; mode: "branch" | "revert" }
  | { type: "branch.switch"; branchId: string }
  | { type: "artifact.open"; id: string };

// ── NDJSON 编解码 ───────────────────────────────────────────────────────────

export function encodeNdjson(value: AgentEvent | UiCommand): string {
  return JSON.stringify(value) + "\n";
}

/**
 * 增量 NDJSON 解码器。
 *
 * 保留不完整的最后一行，等下一块数据补齐 —— 网络分片 / PTY 读都会切在
 * 任意位置。
 */
export function createNdjsonDecoder<T = AgentEvent>(): (chunk: string) => T[] {
  let buffer = "";
  return (chunk: string): T[] => {
    buffer += chunk;
    const out: T[] = [];
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") {
        try {
          out.push(JSON.parse(line) as T);
        } catch (error) {
          // 坏行不阻塞整条流：包成一个 error 事件交给上层决定
          out.push({ type: "error", message: `NDJSON 解析失败: ${line}` } as unknown as T);
        }
      }
      index = buffer.indexOf("\n");
    }
    return out;
  };
}

/** 一次性解析（测试 / 回放用） */
export function decodeNdjson<T = AgentEvent>(text: string): T[] {
  return createNdjsonDecoder<T>()(text);
}
