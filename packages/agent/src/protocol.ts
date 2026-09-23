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

// ── Agent → UI（SPEC §13.1）─────────────────────────────────────────────────

export type AgentEvent =
  | { type: "turn.start"; turnId: string }
  | { type: "text.delta"; turnId: string; delta: string }
  | { type: "reasoning.delta"; turnId: string; delta: string }
  | { type: "tool.start"; call: ToolCall }
  | { type: "tool.progress"; callId: string; chunk: string }
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
