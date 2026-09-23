/**
 * Agent 界面 —— 全部用 SPEC §10.2 的语义组件思路写的，但组件直接内联在
 * demo 里。`@butui/components` / `@butui/agent` 会把它们抽成正式包。
 */
import { For, Show } from "solid-js";
import { StreamMarkdown } from "@butui/stream";
import {
  type AgentMessage,
  type PermissionRequest,
  type Todo,
  input,
  messages,
  permission,
  respondPermission,
  selected,
  setSelected,
  size,
  status,
  todos,
  toggleTodo,
} from "./state.ts";

function MessageView(props: { msg: AgentMessage }) {
  return (
    <box
      semantic={`message:${props.msg.id}`}
      gap={0}
      onClick={() => setSelected(props.msg.id)}
    >
      <row gap={1}>
        <text color={props.msg.role === "user" ? "user" : "assistant"} bold>
          {props.msg.role === "user" ? "● user" : "○ assistant"}
        </text>
        <Show when={props.msg.streaming}>
          <text color="warning">streaming…</text>
        </Show>
      </row>
      <Show when={props.msg.source} fallback={<text color="fg">{props.msg.text}</text>}>
        {source => <StreamMarkdown source={source()} />}
      </Show>
      <Show when={props.msg.tool}>
        {tool => (
          <row gap={1}>
            <text color={tool().status === "success" ? "success" : "warning"}>
              {tool().status === "success" ? "✓" : "⚙"}
            </text>
            <text color="tool">{tool().name}</text>
            <Show when={tool().ms}>
              <text color="muted">{tool().ms}ms</text>
            </Show>
          </row>
        )}
      </Show>
      <Show when={selected() === props.msg.id}>
        <row gap={2}>
          <text color="accent">[u] undo</text>
          <text color="accent">[f] fork</text>
          <text color="accent">[r] retry</text>
          <text color="accent">[c] copy</text>
        </row>
      </Show>
    </box>
  );
}

function TodoPanel(props: { todos: Todo[] }) {
  const done = () => props.todos.filter(t => t.done).length;
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
          <row gap={1} semantic={`todo:${todo.id}`} onClick={() => toggleTodo(todo.id)}>
            <text color={todo.done ? "success" : "muted"}>{todo.done ? "✓" : "○"}</text>
            <text color={todo.done ? "muted" : "fg"}>{todo.label}</text>
          </row>
        )}
      </For>
    </box>
  );
}

function PermissionDialog(props: { request: PermissionRequest }) {
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
        <text color="success" semantic="perm:allow" onClick={() => respondPermission(true)}>
          [y] 允许
        </text>
        <text color="danger" semantic="perm:deny" onClick={() => respondPermission(false)}>
          [n] 拒绝
        </text>
      </row>
    </box>
  );
}

function InputBar() {
  return (
    <box border padding={[0, 1]} borderColor={permission() ? "muted" : "focus"} width={size().columns}>
      <row gap={1}>
        <text color="accent" bold>
          ›
        </text>
        <text color="fg">{input()}</text>
        <Show when={!permission()}>
          <text color="focus">▏</text>
        </Show>
      </row>
    </box>
  );
}

export function App() {
  return (
    <box width={size().columns} height={size().rows}>
      <box border padding={1} gap={1} flexGrow={1} overflow="hidden" width={size().columns}>
        <row justify="between" width={size().columns - 4}>
          <text color="accent" bold>
            buTUI · agent runtime
          </text>
          <text color="muted">
            {size().columns}×{size().rows}
          </text>
        </row>

        <For each={messages()}>{msg => <MessageView msg={msg} />}</For>

        <TodoPanel todos={todos()} />

        <text color="muted">status: {status()}</text>

        <Show when={permission()}>
          {request => (
            <layer x={6} y={4}>
              <PermissionDialog request={request()} />
            </layer>
          )}
        </Show>
      </box>

      <InputBar />
    </box>
  );
}
