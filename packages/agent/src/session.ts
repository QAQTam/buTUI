/**
 * Agent 会话 —— 事件协议的 reducer + Solid store。
 *
 * 设计要点：
 *
 * 1. **状态只由事件推导**。`reduce(state, event)` 是纯函数（原地修改 draft），
 *    不依赖时间、不依赖外部 IO，所以「同一串事件 → 同一状态」，回放和测试
 *    注入天然成立。
 * 2. **流式文本走 StreamSource，不进 reducer**。`text.delta` 的累积是 O(N) 的
 *    字符串拼接，放进 store 会让每条 delta 都变成 O(N)；这里交给
 *    `@butui/stream`，reducer 只负责建消息、标 `streaming`。
 * 3. **UI 不直接改状态，只发 UiCommand**（SPEC §13.2）。
 */
import { createSignal, createStore, flush } from "solid-js";
import {
  Journal,
  fileChange,
  type UndoPlan,
  type WorkspaceChange,
  type WorkspaceFs,
  applyUndo as applyUndoPlan,
  planEffects,
  planUndo,
} from "@butui/undo";
import { type StreamSource, createMarkdownStream, createTextStream } from "@butui/stream";
import { artifactsFromToolResult } from "./artifact-model.ts";
import { mergeUsage } from "./protocol.ts";
import type {
  AgentEvent,
  AgentMessage,
  Artifact,
  AskUserQuestion,
  Branch,
  Checkpoint,
  PermissionRequest,
  SandboxMode,
  Todo,
  ToolCall,
  Turn,
  UiCommand,
  UndoEffect,
  Usage,
} from "./protocol.ts";

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "waiting_user"
  | "error";

export interface UndoPreview {
  target: string;
  effects: UndoEffect[];
}

export interface SessionState {
  messages: AgentMessage[];
  turns: Turn[];
  toolCalls: ToolCall[];
  todos: Todo[];
  permissions: PermissionRequest[];
  questions: AskUserQuestion[];
  artifacts: Artifact[];
  checkpoints: Checkpoint[];
  branches: Branch[];
  activeBranch: string;
  status: SessionStatus;
  undoPreview?: UndoPreview;
  /** 最近一次 revert 因外部修改而失败的文件（SPEC §8.6 revert.conflict） */
  revertConflicts: string[];
  /** 当前选中的消息（SPEC §8.3：点击消息后显示 MessageActionBar） */
  selectedMessage?: string;
  mode: SandboxMode;
  lastError?: string;
  /**
   * token 用量（SPEC §11.3）：`input`/`output`/`cached` 是会话累计，
   * `contextTokens`/`contextWindow` 是最近一次报告的上下文占用与窗口上限。
   */
  usage: Usage;
  /** 下一个消息序号（分支 / undo 的锚点） */
  nextMsgId: number;
}

export function initialState(branchId = "main"): SessionState {
  return {
    messages: [],
    turns: [],
    toolCalls: [],
    todos: [],
    permissions: [],
    questions: [],
    artifacts: [],
    checkpoints: [],
    branches: [
      { id: branchId, createdAt: 0, label: branchId === "main" ? "main" : undefined },
    ],
    activeBranch: branchId,
    status: "idle",
    revertConflicts: [],
    selectedMessage: undefined,
    mode: "workspace-write",
    usage: { input: 0, output: 0 },
    nextMsgId: 1,
  };
}

/** 事件 → 状态。原地修改 draft，纯函数（不读时间、不读外部状态） */
export function reduce(state: SessionState, event: AgentEvent): void {
  switch (event.type) {
    case "turn.start": {
      state.turns.push({
        id: event.turnId,
        branchId: state.activeBranch,
        startMsgId: state.nextMsgId,
        status: "running",
      });
      state.status = "running";
      return;
    }

    case "text.delta": {
      // 只保证消息存在；文本累积在 StreamSource 里（见文件头注释）
      const message = ensureAssistantMessage(state, event.turnId);
      message.streaming = true;
      return;
    }

    case "reasoning.delta": {
      // reasoning 不建独立消息，只标 turn 在跑
      state.status = "running";
      return;
    }

    case "usage": {
      // 增量相加、上下文占用取最近一次 —— 见 protocol.ts 的 mergeUsage
      state.usage = mergeUsage(state.usage, event.usage);
      return;
    }

    case "tool.start": {
      const call: ToolCall = { ...event.call, startedAt: event.call.startedAt ?? 0 };
      state.toolCalls.push(call);
      const message = ensureAssistantMessage(state, call.turnId);
      message.streaming = true;
      return;
    }

    case "tool.progress": {
      const call = state.toolCalls.find(c => c.id === event.callId);
      if (call) call.output = (call.output ?? "") + event.chunk;
      return;
    }

    case "tool.result": {
      const call = state.toolCalls.find(c => c.id === event.callId);
      if (call) {
        call.status = event.result.status;
        call.endedAt = 0;
        if (event.result.output !== undefined) call.output = event.result.output;

        // SPEC §11.1「从 tool result 直接生成」：workspace 变更 → diff artifact，
        // 其余输出按内容分类。时间戳取自 tool call（不是 Date.now），这样回放
        // 两次得到的状态逐字节一致。
        for (const artifact of artifactsFromToolResult(call, event.result, {
          now: call.startedAt ?? 0,
        })) {
          if (!state.artifacts.some(existing => existing.id === artifact.id)) {
            state.artifacts.push(artifact);
          }
        }
      }
      return;
    }

    case "permission.request": {
      state.permissions.push(event.request);
      state.status = "waiting_permission";
      return;
    }

    case "ask_user.request": {
      state.questions.push(...event.questions);
      state.status = "waiting_user";
      return;
    }

    case "todo.update": {
      state.todos = event.todos;
      return;
    }

    case "artifact.add": {
      state.artifacts.push(event.artifact);
      return;
    }

    case "checkpoint.create": {
      state.checkpoints.push(event.checkpoint);
      return;
    }

    case "undo.preview": {
      state.undoPreview = { target: event.target, effects: event.effects };
      return;
    }

    case "undo.apply": {
      state.undoPreview = undefined;
      state.revertConflicts = [];
      return;
    }

    case "branch.create": {
      state.branches.push({
        id: event.branchId,
        parentBranchId: state.activeBranch,
        fromMsgId: Number.parseInt(event.from, 10) || undefined,
        createdAt: 0,
      });
      return;
    }

    case "branch.switch": {
      state.activeBranch = event.branchId;
      return;
    }

    case "revert.conflict": {
      state.revertConflicts = event.files;
      return;
    }

    case "turn.end": {
      const turn = state.turns.find(t => t.id === event.turnId);
      if (turn) {
        turn.status = event.reason === "completed" ? "completed" : "aborted";
        turn.reason = event.reason;
        turn.endMsgId = state.nextMsgId;
      }
      for (const message of state.messages) {
        if (message.turnId === event.turnId) message.streaming = false;
      }
      state.status = "idle";
      return;
    }

    case "error": {
      state.lastError = event.message;
      state.status = "error";
      return;
    }
  }
}

function ensureAssistantMessage(state: SessionState, turnId: string): AgentMessage {
  const existing = state.messages.find(m => m.turnId === turnId && m.role === "assistant");
  if (existing) return existing;
  const message: AgentMessage = {
    id: `m${state.nextMsgId}`,
    msgid: state.nextMsgId++,
    turnId,
    role: "assistant",
    origin: "assistant",
    createdAt: 0,
    branchId: state.activeBranch,
    text: "",
  };
  state.messages.push(message);
  return message;
}

export interface SessionOptions {
  /** 折行宽度；做成 getter 是为了 resize 后能重建 */
  width: () => number;
  branchId?: string;
  /** UI → Agent 的命令出口 */
  onCommand?: (command: UiCommand) => void;
}

/** 分支可见性：子分支能看到父分支 `fromMsgId` 之前的历史（SPEC §8.2） */
export function visibleOnBranch(
  message: AgentMessage,
  branchId: string,
  branches: readonly Branch[]
): boolean {
  if (message.branchId === branchId) return true;
  let current = branches.find(b => b.id === branchId);
  while (current?.parentBranchId) {
    if (message.branchId === current.parentBranchId) {
      return current.fromMsgId === undefined || message.msgid <= current.fromMsgId;
    }
    const parentId: string = current.parentBranchId;
    current = branches.find(b => b.id === parentId);
  }
  return false;
}

export interface UndoOutcome {
  plan: UndoPlan;
  ok: boolean;
  applied: string[];
  conflicts: string[];
  skipped: string[];
}

export interface Session {
  readonly state: SessionState;
  /** 工作区变更日志（SPEC §8.4） */
  readonly journal: Journal;
  /** 消费一个 agent 事件 */
  dispatch(event: AgentEvent): void;
  /** 发一条 UI 命令 */
  send(command: UiCommand): void;
  /** 取某个消息的流式源（用于 <StreamMarkdown>） */
  sourceFor(messageId: string): StreamSource | undefined;
  /**
   * 取某个 turn 的**思考流**（SPEC §10.2 `ReasoningLine`）。
   *
   * 思考不落库：`turn.end` 之后这个 turn 的源就被丢掉，UI 的 `<Show>` 自然
   * 收起。折叠态读 `source.tail()` 就是「正在想的那一行」，O(1)。
   */
  reasoningFor(turnId: string): StreamSource | undefined;
  /** 提交用户输入（建消息 + 发 user.submit） */
  submit(text: string): void;
  /** 回答权限请求 */
  respondPermission(id: string, allow: boolean): void;
  /**
   * 把挂起的状态提交掉。
   *
   * Solid 2 的写入延迟到 flush：在响应式 root 内部（组件 / effect）会自动提交，
   * 但在 root 外部「连续 dispatch 一批事件然后立刻读状态 / 渲染」时，必须显式
   * 调用它 —— 回放、快照、批量注入都属于这种场景。
   */
  settle(): void;
  /** 窗口宽度变化后重建折行缓冲 */
  resize(): void;
  /** 取消息的完整文本（含流式中） */
  textOf(messageId: string): string;
  /** 当前分支可见的消息（SPEC §8.2 的分支式历史） */
  visibleMessages(): AgentMessage[];
  /** 选中 / 取消选中一条消息 */
  selectMessage(messageId: string | null): void;
  /** 关掉 undo 预览（用户取消） */
  dismissUndoPreview(): void;
  /** 记录一条工作区变更 */
  recordChange(change: Parameters<Journal["record"]>[0]): WorkspaceChange;
  /**
   * 本地计算 undo 预览（SPEC §8.3）。
   *
   * 不需要 agent 告诉 UI「会影响什么」—— buTUI 自己持有日志。
   */
  previewUndo(target: string, read?: (path: string) => string | undefined): UndoPlan;
  /**
   * 计算预览并挂到 UI 上（SPEC §8.3：点 Undo 后必须先进预览）。
   * 返回计划，方便调用方展示细节。
   */
  requestUndoPreview(target: string, read?: (path: string) => string | undefined): UndoPlan;
  /** 执行 undo：branch 只切分支，revert 反向 patch 工作区（SPEC §8.4） */
  undo(target: string, mode: "branch" | "revert", fs: WorkspaceFs): UndoOutcome;
}

export function createSession(options: SessionOptions): Session {
  const [state, setState] = createStore<SessionState>(initialState(options.branchId));
  const sources = new Map<string, StreamSource>();
  /** turnId → 思考流。**不落库**：turn.end 时整个丢掉（SPEC §7 的 reasoning 取舍） */
  const reasoning = new Map<string, StreamSource>();
  const rawText = new Map<string, string>();
  /**
   * source 是懒建的（tool.start 先建消息、text.delta 才建 source），
   * 而 `sourceFor()` 读的是普通 Map —— 没有响应性，`<Show>` 永远不会重算。
   * 这个版本号让调用方建立依赖。
   */
  const [sourcesVersion, setSourcesVersion] = createSignal(0);

  const ensureSource = (message: AgentMessage): StreamSource => {
    let source = sources.get(message.id);
    if (!source) {
      source = createMarkdownStream({ width: Math.max(8, options.width()) });
      sources.set(message.id, source);
      setSourcesVersion(v => v + 1);
    }
    return source;
  };

  const journal = new Journal();

  const session: Session = {
    get state() {
      return state;
    },

    get journal() {
      return journal;
    },

    dispatch(event) {
      if (event.type === "text.delta") {
        // 全部在 setter 里做：Solid 的写入是延迟到 flush 的，setState 之后
        // 立刻读 state 读不到新消息。
        setState(s => {
          const message = ensureAssistantMessage(s, event.turnId);
          ensureSource(message).push(event.delta);
          rawText.set(message.id, (rawText.get(message.id) ?? "") + event.delta);
          // 还要走一遍 reduce：文本累积走了快路径，但 `streaming` 标记是
          // reducer 推导出来的（少了这行，「streaming…」永远不亮）。
          reduce(s, event);
        });
        return;
      }

      if (event.type === "reasoning.delta") {
        setState(s => {
          let source = reasoning.get(event.turnId);
          if (!source) {
            source = createTextStream({ width: Math.max(8, options.width()) });
            reasoning.set(event.turnId, source);
            setSourcesVersion(v => v + 1);
          }
          source.push(event.delta);
          reduce(s, event);
        });
        return;
      }

      if (event.type === "tool.result" && event.result.workspace?.length) {
        // 工具执行器报告了工作区变更 → 记录进 journal（SPEC §8.4）
        //
        // 查 call 必须在 setter 内部：tool.start 的写入还没 flush，
        // 在外面读 state.toolCalls 会是旧快照（turnId 会记成空串）。
        setState(s => {
          const call = s.toolCalls.find(c => c.id === event.callId);
          journal.record({
            toolCallId: event.callId,
            turnId: call?.turnId ?? "",
            reversible: call?.reversible ?? true,
            files: (event.result.workspace ?? []).map(f =>
              fileChange(f.path, f.before, f.after)
            ),
            todoBefore: s.todos.map(t => ({ ...t })),
          });
          reduce(s, event);
        });
        return;
      }

      if (event.type === "turn.end") {
        for (const [id, source] of sources) source.flush();
        // 思考不落库：turn 一结束就丢掉，UI 的 <Show> 自动收起
        reasoning.get(event.turnId)?.flush();
        reasoning.delete(event.turnId);
        setSourcesVersion(v => v + 1);
        setState(s => {
          for (const message of s.messages) {
            if (message.turnId === event.turnId) {
              message.text = rawText.get(message.id) ?? message.text;
            }
          }
          reduce(s, event);
        });
        return;
      }

      setState(s => reduce(s, event));
    },

    send(command) {
      options.onCommand?.(command);
    },

    sourceFor(messageId) {
      sourcesVersion(); // 建立响应性依赖
      return sources.get(messageId);
    },

    reasoningFor(turnId) {
      sourcesVersion(); // 同上：Map 本身没有响应性
      return reasoning.get(turnId);
    },

    submit(text) {
      const trimmed = text.trim();
      if (trimmed === "") return;
      setState(s => {
        s.messages.push({
          id: `m${s.nextMsgId}`,
          msgid: s.nextMsgId++,
          turnId: "",
          role: "user",
          origin: "user",
          createdAt: 0,
          branchId: s.activeBranch,
          text: trimmed,
        });
      });
      options.onCommand?.({ type: "user.submit", text: trimmed });
    },

    respondPermission(id, allow) {
      setState(s => {
        s.permissions = s.permissions.filter(p => p.id !== id);
        if (s.permissions.length === 0 && s.questions.length === 0) s.status = "idle";
      });
      options.onCommand?.({ type: "permission.respond", id, allow });
    },

    settle() {
      flush();
    },

    resize() {
      // 折行缓冲的宽度是构造时固定的：resize 后按原始文本重建
      for (const [id, text] of rawText) {
        const source = createMarkdownStream({ width: Math.max(8, options.width()) });
        source.push(text);
        sources.set(id, source);
      }
      setSourcesVersion(v => v + 1);
    },

    textOf(messageId) {
      return rawText.get(messageId) ?? state.messages.find(m => m.id === messageId)?.text ?? "";
    },

    visibleMessages() {
      const branchId = state.activeBranch;
      const branches = state.branches;
      return state.messages.filter(m => visibleOnBranch(m, branchId, branches));
    },

    selectMessage(messageId) {
      setState(s => {
        s.selectedMessage = messageId ?? undefined;
      });
    },

    dismissUndoPreview() {
      setState(s => {
        s.undoPreview = undefined;
        s.revertConflicts = [];
      });
    },

    recordChange(change) {
      return journal.record(change);
    },

    previewUndo(target, read) {
      return planUndo({
        target,
        messages: state.messages,
        turns: state.turns,
        todos: state.todos,
        changes: journal.changes,
        branchId: state.activeBranch,
        read,
      });
    },

    requestUndoPreview(target, read) {
      const plan = session.previewUndo(target, read);
      session.dispatch({ type: "undo.preview", target, effects: planEffects(plan) });
      return plan;
    },

    undo(target, mode, fs) {
      const plan = session.previewUndo(target, fs.read);
      const result = applyUndoPlan(plan, fs, mode);
      if (!result.ok) {
        session.dispatch({ type: "revert.conflict", files: result.conflicts });
        return { plan, ...result };
      }

      if (mode === "branch") {
        // SPEC §8.2：不删历史，从目标之后开一条新分支
        const branchId = `b${state.branches.length}`;
        session.dispatch({ type: "branch.create", from: String(plan.targetMsgId), branchId });
        session.dispatch({ type: "branch.switch", branchId });
      }
      // SPEC §8.4 第 5 步：重算 todo 与 UI 状态
      session.dispatch({ type: "todo.update", todos: plan.todos });
      // undo.apply 会清掉预览
      session.dispatch({ type: "undo.apply", target, mode });
      return { plan, ...result };
    },
  };

  return session;
}
