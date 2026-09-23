/** @jsxImportSource @solidjs/web */
/**
 * WebUI —— 与 TUI **共享 Session 和事件协议，不共享组件代码**（SPEC §3 非目标）。
 *
 * 这里用 `@solidjs/web`（`generate: "dom"`，SPEC §5.4）渲染 DOM，消费的是
 * 同一个 `@butui/agent` Session：同一串事件，TUI 和浏览器里看到的是同一份状态。
 */
import { For, Show, createEffect } from "solid-js";
import type {
  AgentMessage,
  AskUserQuestion,
  PermissionRequest,
  Session,
  Todo,
  ToolCall,
} from "@butui/agent";
import type { StreamSource } from "@butui/stream";
import { ansiToHtml } from "./ansi-html.ts";

const TOOL_GLYPH: Record<ToolCall["status"], string> = {
  pending: "○",
  running: "⚙",
  success: "✓",
  error: "✗",
  cancelled: "⊘",
};

const ROLE_LABEL: Record<AgentMessage["role"], string> = {
  user: "user",
  assistant: "assistant",
  tool: "tool",
  system: "system",
};

/**
 * 流式 markdown 的 DOM 版本。
 *
 * 刻意用命令式 append 而不是 `<For>`：`lines` 是只增不改的数组，DOM 节点
 * 一旦创建就不该重建。每次只追加新增的行，尾部单独更新 —— 与 TUI 侧
 * `measureStreamNode` 是同一个思路，只是产物从 cell 变成 DOM。
 */
export function StreamMarkdown(props: { source: StreamSource }) {
  let body!: HTMLDivElement;
  let tail!: HTMLDivElement;
  let rendered = 0;

  // Solid 2 RC 的 createEffect 需要**两个**参数：compute + effect
  createEffect(
    () => ({ version: props.source.version(), tail: props.source.tail() }),
    () => {
      const lines = props.source.lines;
      while (rendered < lines.length) {
        const line = document.createElement("div");
        line.className = "butui-line";
        line.innerHTML = ansiToHtml(lines[rendered].text);
        body.insertBefore(line, tail);
        rendered++;
      }
      tail.innerHTML = ansiToHtml(props.source.tail());
    }
  );

  return (
    <div class="butui-md" ref={body}>
      <div class="butui-line butui-tail" ref={tail} />
    </div>
  );
}

export function ToolCard(props: { call: ToolCall }) {
  return (
    <div class="butui-tool" data-semantic={`tool:${props.call.id}`}>
      <span class={`butui-glyph butui-${props.call.status}`}>{TOOL_GLYPH[props.call.status]}</span>
      <span class="butui-tool-name">{props.call.name}</span>
      <Show when={props.call.reversible === false}>
        <span class="butui-warn">不可撤销</span>
      </Show>
    </div>
  );
}

export function MessageView(props: { session: Session; message: AgentMessage }) {
  const tools = () =>
    props.session.state.toolCalls.filter(call => call.turnId === props.message.turnId);

  return (
    <div
      class={`butui-message${
        props.session.state.selectedMessage === props.message.id ? " butui-selected" : ""
      }`}
      data-semantic={`message:${props.message.id}`}
      onClick={() => props.session.selectMessage(props.message.id)}
    >
      <div class={`butui-role${props.message.role === "user" ? " user" : ""}`}>
        {ROLE_LABEL[props.message.role]}
        <Show when={props.message.streaming}>
          <span class="butui-streaming">streaming…</span>
        </Show>
      </div>

      <Show
        when={props.session.sourceFor(props.message.id)}
        fallback={<div class="butui-text">{props.message.text}</div>}
      >
        {source => <StreamMarkdown source={source()} />}
      </Show>

      <For each={tools()}>{call => <ToolCard call={call} />}</For>

      <Show when={props.session.state.selectedMessage === props.message.id}>
        <div class="butui-actions" data-semantic={`message:${props.message.id}:actions`}>
          <button
            data-semantic="action:undo"
            onClick={event => {
              event.stopPropagation();
              props.session.requestUndoPreview(props.message.id);
            }}
          >
            undo
          </button>
          <button
            data-semantic="action:fork"
            onClick={event => {
              event.stopPropagation();
              props.session.send({ type: "session.fork", msgid: props.message.msgid });
            }}
          >
            fork
          </button>
          <button
            data-semantic="action:retry"
            onClick={event => {
              event.stopPropagation();
              props.session.send({ type: "session.fork", msgid: props.message.msgid });
            }}
          >
            retry
          </button>
        </div>
      </Show>
    </div>
  );
}

export function MessageList(props: { session: Session }) {
  return (
    <div class="butui-messages">
      <For each={props.session.visibleMessages()}>
        {message => <MessageView session={props.session} message={message} />}
      </For>
    </div>
  );
}

export function TodoPanel(props: { todos: Todo[] }) {
  const done = () => props.todos.filter(t => t.status === "completed").length;
  return (
    <div class="butui-todos" data-semantic="todo:panel">
      <div class="butui-section-title">
        todo {done()}/{props.todos.length}
      </div>
      <For each={props.todos}>
        {todo => (
          <div class="butui-todo" data-semantic={`todo:${todo.id}`}>
            <span class={todo.status === "completed" ? "butui-ok" : "butui-muted"}>
              {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○"}
            </span>
            <span>{todo.label}</span>
          </div>
        )}
      </For>
    </div>
  );
}

export function PermissionDialog(props: {
  request: PermissionRequest;
  onRespond: (allow: boolean) => void;
}) {
  return (
    <div class="butui-dialog butui-danger" data-semantic="permission:dialog">
      <div class="butui-dialog-title">⚠ permission required</div>
      <div class="butui-tool-name">{props.request.tool}</div>
      <pre class="butui-code">{props.request.detail}</pre>
      <Show when={props.request.irreversible}>
        <div class="butui-warn">该操作无法撤销</div>
      </Show>
      <div class="butui-dialog-actions">
        <button
          data-semantic={`permission:${props.request.id}:allow`}
          onClick={() => props.onRespond(true)}
        >
          允许
        </button>
        <button
          class="butui-secondary"
          data-semantic={`permission:${props.request.id}:deny`}
          onClick={() => props.onRespond(false)}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

export function AskUserForm(props: {
  questions: AskUserQuestion[];
  onSubmit: (answers: unknown[]) => void;
}) {
  return (
    <div class="butui-dialog" data-semantic="ask:dialog">
      <div class="butui-dialog-title">? 需要你的输入</div>
      <For each={props.questions}>
        {question => (
          <div data-semantic={`ask:${question.id}`}>
            <div>{question.question}</div>
            <For each={question.options}>
              {option => (
                <button class="butui-option" onClick={() => props.onSubmit([option.label])}>
                  {option.label}
                  <Show when={option.description}>
                    <span class="butui-muted"> — {option.description}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

export function UndoPreviewPanel(props: { session: Session; onConfirm: () => void }) {
  const preview = () => props.session.state.undoPreview;
  return (
    <Show when={preview()}>
      {value => (
        <div class="butui-dialog butui-warn-border" data-semantic="undo:preview">
          <div class="butui-dialog-title">Undo Preview</div>
          <div class="butui-muted">target: {value().target}</div>
          <ul class="butui-effects">
            <For each={value().effects}>
              {effect => (
                <li class={effect.irreversible ? "butui-warn" : undefined}>
                  {effect.irreversible ? "⚠ " : "· "}
                  {effect.description}
                </li>
              )}
            </For>
          </ul>
          <div class="butui-dialog-actions">
            <button data-semantic="undo:confirm" onClick={props.onConfirm}>
              确认
            </button>
            <button
              class="butui-secondary"
              data-semantic="undo:cancel"
              onClick={() => props.session.dismissUndoPreview()}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}

export function RevertConflictDialog(props: { session: Session }) {
  return (
    <Show when={props.session.state.revertConflicts.length > 0}>
      <div class="butui-dialog butui-danger" data-semantic="revert:conflict">
        <div class="butui-dialog-title">⚠ revert 冲突</div>
        <div class="butui-muted">以下文件已被外部修改，未做任何写入：</div>
        <ul class="butui-effects">
          <For each={props.session.state.revertConflicts}>{file => <li>· {file}</li>}</For>
        </ul>
        <div class="butui-dialog-actions">
          <button data-semantic="revert:close" onClick={() => props.session.dismissUndoPreview()}>
            关闭
          </button>
        </div>
      </div>
    </Show>
  );
}

export function StatusBar(props: { session: Session }) {
  return (
    <div class="butui-status" data-semantic="status:bar">
      <span class={props.session.state.status === "error" ? "butui-error" : undefined}>
        {props.session.state.status}
      </span>
      <span class="butui-muted">mode: {props.session.state.mode}</span>
      <span class="butui-muted">branch: {props.session.state.activeBranch}</span>
      <span class="butui-muted">branches: {props.session.state.branches.length}</span>
    </div>
  );
}

/** 完整的 WebUI 视图 */
export function AgentWebView(props: { session: Session }) {
  const session = props.session;
  return (
    <div class="butui-root">
      <header class="butui-header">
        <span class="butui-brand">buTUI · agent runtime</span>
        <StatusBar session={session} />
      </header>

      <MessageList session={session} />

      <Show when={session.state.todos.length > 0}>
        <TodoPanel todos={session.state.todos} />
      </Show>

      <UndoPreviewPanel
        session={session}
        onConfirm={() => {
          const preview = session.state.undoPreview;
          if (preview) session.send({ type: "undo.apply", target: preview.target, mode: "branch" });
        }}
      />

      <RevertConflictDialog session={session} />

      <Show when={session.state.questions.length > 0}>
        <AskUserForm
          questions={session.state.questions}
          onSubmit={answers => session.send({ type: "ask_user.respond", id: "ask", answers })}
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
    </div>
  );
}
