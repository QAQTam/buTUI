/**
 * Agent 组件 —— SPEC §10.2。
 *
 * 每个组件都只依赖 `Session`，并且把语义标识打在根节点上（SPEC §4.2），
 * 所以鼠标点击拿到的是 `message:<id>` / `tool:<callId>` / `checkpoint:<id>`，
 * 而不是行号。
 */
import { For, Show } from "solid-js";
import { Diff } from "@butui/components";
import { StreamMarkdown, type DiffStream } from "@butui/stream";
import type {
  AgentMessage,
  AskUserQuestion,
  Checkpoint,
  PermissionRequest,
  Todo,
  ToolCall,
  Usage,
} from "./protocol.ts";
import type { Session } from "./session.ts";

const ROLE_COLOR: Record<AgentMessage["role"], string> = {
  user: "user",
  assistant: "assistant",
  tool: "tool",
  system: "muted",
};

const ROLE_LABEL: Record<AgentMessage["role"], string> = {
  user: "● user",
  assistant: "○ assistant",
  tool: "⚙ tool",
  system: "◇ system",
};

const TOOL_GLYPH: Record<ToolCall["status"], string> = {
  pending: "○",
  running: "⚙",
  success: "✓",
  error: "✗",
  cancelled: "⊘",
};

const TOOL_COLOR: Record<ToolCall["status"], string> = {
  pending: "muted",
  running: "warning",
  success: "success",
  error: "danger",
  cancelled: "muted",
};

export function ToolCard(props: { call: ToolCall; diff?: DiffStream }) {
  return (
    <box gap={0} semantic={`tool:${props.call.id}`}>
      <row gap={1}>
        <text color={TOOL_COLOR[props.call.status]}>{TOOL_GLYPH[props.call.status]}</text>
        <text color="tool">{props.call.name}</text>
        <Show when={props.call.reversible === false}>
          <text color="warning">不可撤销</text>
        </Show>
        <Show when={props.call.status === "error"}>
          <text color="danger">{props.call.output ?? "failed"}</text>
        </Show>
      </row>
      <Show when={props.diff}>
        {source => <Diff source={source()} height={12} lineNumbers scrollbar />}
      </Show>
    </box>
  );
}

export function MessageView(props: { session: Session; message: AgentMessage }) {
  const tools = () =>
    props.session.state.toolCalls.filter(call => call.turnId === props.message.turnId);

  return (
    <box semantic={`message:${props.message.id}`} gap={0}>
      <row gap={1}>
        <text color={ROLE_COLOR[props.message.role]} bold>
          {ROLE_LABEL[props.message.role]}
        </text>
        <Show when={props.message.streaming}>
          <text color="warning">streaming…</text>
        </Show>
      </row>

      <Show
        when={props.session.reasoningFor(props.message.turnId)}
        fallback={null}
      >
        {source => (
          <ReasoningLine text={source().tail()} streaming={props.message.streaming} />
        )}
      </Show>

      <Show
        when={props.session.sourceFor(props.message.id)}
        fallback={<text color="fg">{props.message.text}</text>}
      >
        {source => (
          <StreamMarkdown source={source()} semantic={`message:${props.message.id}:body`} />
        )}
      </Show>

      <For each={tools()}>
        {call => <ToolCard call={call} diff={props.session.diffFor(call.id)} />}
      </For>

      <Show when={props.session.state.selectedMessage === props.message.id}>
        <MessageActions
          message={props.message}
          onUndo={() => props.session.requestUndoPreview(props.message.id)}
          onFork={() => props.session.send({ type: "session.fork", msgid: props.message.msgid })}
          onRetry={() => props.session.send({ type: "session.fork", msgid: props.message.msgid })}
          onCopy={() => props.session.send({ type: "artifact.open", id: props.message.id })}
          onInspect={() => props.session.send({ type: "artifact.open", id: props.message.id })}
        />
      </Show>
    </box>
  );
}

export function MessageList(props: { session: Session }) {
  return (
    <box gap={1}>
      {/* 只渲染当前分支可见的消息（SPEC §8.2 的分支式历史） */}
      <For each={props.session.visibleMessages()}>
        {message => <MessageView session={props.session} message={message} />}
      </For>
    </box>
  );
}

/** SPEC §8.3 的 MessageActionBar */
export function MessageActions(props: {
  message: AgentMessage;
  onUndo: () => void;
  onFork: () => void;
  onRetry: () => void;
  onCopy: () => void;
  onInspect?: () => void;
}) {
  return (
    <row gap={2} semantic={`message:${props.message.id}:actions`}>
      <text color="accent" semantic="action:undo" onClick={props.onUndo}>
        [u] undo
      </text>
      <text color="accent" semantic="action:fork" onClick={props.onFork}>
        [f] fork
      </text>
      <text color="accent" semantic="action:retry" onClick={props.onRetry}>
        [r] retry
      </text>
      <text color="accent" semantic="action:copy" onClick={props.onCopy}>
        [c] copy
      </text>
      <Show when={props.onInspect}>
        <text color="accent" semantic="action:inspect" onClick={() => props.onInspect?.()}>
          [i] inspect
        </text>
      </Show>
    </row>
  );
}

/** SPEC §10.2：revert 冲突对话框。冲突时**一个文件都不会写**。 */
export function RevertConflictDialog(props: { files: string[]; onClose: () => void }) {
  return (
    <box border="double" borderColor="danger" padding={1} gap={1} width={56} semantic="revert:conflict">
      <text color="danger" bold>
        ⚠ revert 冲突
      </text>
      <text color="muted">以下文件已被外部修改，未做任何写入：</text>
      <For each={props.files}>{file => <text color="fg">· {file}</text>}</For>
      <text color="accent" semantic="revert:close" onClick={props.onClose}>
        [关闭]
      </text>
    </box>
  );
}

export function TodoPanel(props: { todos: Todo[]; onToggle?: (id: string) => void }) {
  const done = () => props.todos.filter(t => t.status === "completed").length;
  return (
    <box gap={0} semantic="todo:panel">
      <text color="muted">
        {"todo "}
        {done()}
        {"/"}
        {props.todos.length}
      </text>
      <For each={props.todos}>
        {todo => (
          <row
            gap={1}
            semantic={`todo:${todo.id}`}
            onClick={props.onToggle ? () => props.onToggle?.(todo.id) : undefined}
          >
            <text color={todo.status === "completed" ? "success" : "muted"}>
              {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○"}
            </text>
            <text color={todo.status === "completed" ? "muted" : "fg"}>{todo.label}</text>
          </row>
        )}
      </For>
    </box>
  );
}

export function PermissionDialog(props: {
  request: PermissionRequest;
  onRespond: (allow: boolean) => void;
}) {
  return (
    <box border="double" borderColor="danger" padding={1} gap={1} width={54}>
      <text color="danger" bold>
        ⚠ permission required
      </text>
      <text color="fg">{props.request.tool}</text>
      <text color="muted">{props.request.detail}</text>
      <Show when={props.request.irreversible}>
        <text color="warning">该操作无法撤销</text>
      </Show>
      <row gap={2}>
        <text
          color="success"
          semantic={`permission:${props.request.id}:allow`}
          onClick={() => props.onRespond(true)}
        >
          [y] 允许
        </text>
        <text
          color="danger"
          semantic={`permission:${props.request.id}:deny`}
          onClick={() => props.onRespond(false)}
        >
          [n] 拒绝
        </text>
      </row>
    </box>
  );
}

export function AskUserForm(props: {
  questions: AskUserQuestion[];
  onSubmit: (answers: unknown[]) => void;
}) {
  return (
    <box border="round" borderColor="accent" padding={1} gap={1} width={60}>
      <text color="accent" bold>
        ? 需要你的输入
      </text>
      <For each={props.questions}>
        {question => (
          <box gap={0} semantic={`ask:${question.id}`}>
            <text color="fg">{question.question}</text>
            <For each={question.options}>
              {option => (
                <text
                  color="muted"
                  semantic={`ask:${question.id}:${option.label}`}
                  onClick={() => props.onSubmit([option.label])}
                >
                  {"  · "}
                  {option.label}
                  {option.description ? ` — ${option.description}` : ""}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

export function CheckpointMarker(props: { checkpoint: Checkpoint; label?: string }) {
  return (
    <row gap={1} semantic={`checkpoint:${props.checkpoint.id}`}>
      <text color="accent">◈</text>
      <text color="muted">
        {props.label ?? props.checkpoint.kind}
        {" #"}
        {props.checkpoint.msgid}
      </text>
    </row>
  );
}

export function UndoPreviewPanel(props: {
  target: string;
  effects: Array<{ kind: string; description: string; count?: number; irreversible?: boolean }>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <box border="round" borderColor="warning" padding={1} gap={1} width={56} semantic="undo:preview">
      <text color="warning" bold>
        Undo Preview
      </text>
      <text color="muted">target: {props.target}</text>
      <For each={props.effects}>
        {effect => (
          <row gap={1}>
            <text color={effect.irreversible ? "danger" : "fg"}>
              {effect.irreversible ? "⚠" : "·"}
            </text>
            <text color={effect.irreversible ? "danger" : "fg"}>{effect.description}</text>
            <Show when={effect.count !== undefined}>
              <text color="muted">({effect.count})</text>
            </Show>
          </row>
        )}
      </For>
      <row gap={2}>
        <text color="success" semantic="undo:confirm" onClick={props.onConfirm}>
          [确认]
        </text>
        <text color="danger" semantic="undo:cancel" onClick={props.onCancel}>
          [取消]
        </text>
      </row>
    </box>
  );
}

export function BranchTree(props: {
  branches: Array<{ id: string; parentBranchId?: string; label?: string }>;
  active: string;
  onSwitch?: (id: string) => void;
}) {
  return (
    <box gap={0} semantic="branch:tree">
      <text color="muted">branches</text>
      <For each={props.branches}>
        {branch => (
          <row
            gap={1}
            semantic={`branch:${branch.id}`}
            onClick={props.onSwitch ? () => props.onSwitch?.(branch.id) : undefined}
          >
            <text color={branch.id === props.active ? "accent" : "muted"}>
              {branch.id === props.active ? "◉" : "○"}
            </text>
            <text color={branch.id === props.active ? "accent" : "fg"}>
              {branch.label ?? branch.id}
            </text>
          </row>
        )}
      </For>
    </box>
  );
}

export function StatusBar(props: { session: Session }) {
  return (
    <row gap={2} semantic="status:bar">
      <text color={props.session.state.status === "error" ? "danger" : "muted"}>
        {props.session.state.status}
      </text>
      <text color="muted">mode: {props.session.state.mode}</text>
      <text color="muted">branch: {props.session.state.activeBranch}</text>
      <Show when={props.session.state.lastError}>
        <text color="danger">{props.session.state.lastError}</text>
      </Show>
    </row>
  );
}

/** `1234` → `1.2k`；`128000` → `128k`；`1500000` → `1.5M`（状态栏空间紧张，别写全数字） */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  const trim = (scaled: number): string => scaled.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

/**
 * `<ContextMeter>` —— 上下文占用条（SPEC §11.3）。
 *
 * ```tsx
 * <ContextMeter usage={session.state.usage} />
 * ```
 *
 * 占用取 `contextTokens ?? input`（**最近一次请求**的规模），不是会话累计 ——
 * 拿累计值除窗口会立刻超过 100%。窗口未知时只报数、不画比例条。
 */
export function ContextMeter(props: {
  usage: Usage;
  /** 条宽（cell），默认 10 */
  width?: number;
  /** 超过这个比例转 warning，默认 0.7 */
  warnAt?: number;
  /** 超过这个比例转 danger，默认 0.9 */
  dangerAt?: number;
}) {
  const used = (): number => props.usage.contextTokens ?? props.usage.input;
  const window = (): number | undefined =>
    props.usage.contextWindow && props.usage.contextWindow > 0
      ? props.usage.contextWindow
      : undefined;
  const ratio = (): number => (window() ? Math.min(1, used() / window()!) : 0);
  const color = (): string => {
    const r = ratio();
    if (r >= (props.dangerAt ?? 0.9)) return "danger";
    if (r >= (props.warnAt ?? 0.7)) return "warning";
    return "muted";
  };
  const barWidth = (): number => Math.max(1, Math.floor(props.width ?? 10));
  const filled = (): number => Math.round(ratio() * barWidth());
  const cachedPct = (): number | undefined => {
    const cached = props.usage.cached ?? 0;
    const total = used() + cached;
    return total > 0 && cached > 0 ? Math.round((cached / total) * 100) : undefined;
  };

  return (
    <row gap={1} semantic="context:meter">
      <text color={color()}>
        {"█".repeat(filled())}
        {"░".repeat(barWidth() - filled())}
      </text>
      <text color="muted">
        {formatTokens(used())}
        {window() ? `/${formatTokens(window()!)}` : ""}
      </text>
      <Show when={cachedPct()}>
        {pct => <text color="muted">cache {pct()}%</text>}
      </Show>
    </row>
  );
}

/**
 * `<ReasoningLine>` —— 思考链路（SPEC §10.2）。
 *
 * 刻意与正文分开：思考内容不落库、不回传、不进上下文，只用于实时展示。
 * 默认折成**一行**（`truncate`），展开才多行 —— 转录里思考通常只值一行提示。
 */
export function ReasoningLine(props: {
  text: string;
  streaming?: boolean;
  expanded?: boolean;
}) {
  return (
    <row gap={1} semantic="reasoning:line">
      <text color="reasoning">{props.streaming ? "✻ 思考中" : "✻ 思考"}</text>
      <Show
        when={props.expanded}
        fallback={
          <text color="muted" truncate>
            {props.text.replace(/\s+/g, " ").trim()}
          </text>
        }
      >
        <text color="muted" dim>
          {props.text}
        </text>
      </Show>
    </row>
  );
}

/**
 * SPEC §19 的最小闭环视图：消息 + tool card + todo + 权限 + undo preview + 状态栏。
 *
 * 弹窗默认内联渲染（在 flow 里）；需要覆盖层的场景由调用方包一层 `<layer>`。
 */
export function AgentView(props: { session: Session }) {
  const session = props.session;
  return (
    <box gap={1}>
      <MessageList session={session} />

      <Show when={session.state.todos.length > 0}>
        <TodoPanel todos={session.state.todos} />
      </Show>

      <Show when={session.state.undoPreview}>
        {preview => (
          <UndoPreviewPanel
            target={preview().target}
            effects={preview().effects}
            onConfirm={() => session.send({ type: "undo.apply", target: preview().target, mode: "branch" })}
            onCancel={() => session.send({ type: "cancel" })}
          />
        )}
      </Show>

      <Show when={session.state.questions.length > 0}>
        <AskUserForm
          questions={session.state.questions}
          onSubmit={answers => session.send({ type: "ask_user.respond", id: "ask", answers })}
        />
      </Show>

      {/* when 直接给对象，Show 的回调才会拿到对象而不是 boolean */}
      <Show when={session.state.revertConflicts.length > 0}>
        <RevertConflictDialog
          files={session.state.revertConflicts}
          onClose={() => session.send({ type: "cancel" })}
        />
      </Show>

      <Show when={session.state.permissions[0]}>
        {request => (
          <PermissionDialog
            request={request()}
            onRespond={allow => session.respondPermission(request().id, allow)}
          />
        )}
      </Show>

      <StatusBar session={session} />
    </box>
  );
}
