/**
 * Agent demo —— 完全由事件协议驱动。
 *
 * 界面里没有任何「模拟 agent」的逻辑：所有内容都来自 `AgentEvent`，
 * 所有操作都走 `UiCommand`。mock agent 换成真 agent 时这个文件不用改。
 */
import { AgentView, type Session } from "@butui/agent";
import { Show } from "solid-js";
import { input, permission, size, status } from "./state.ts";

export function App(props: { session: Session }) {
  const session = props.session;
  return (
    <box width={size().columns} height={size().rows}>
      <box border padding={1} gap={1} width={size().columns}>
        <row justify="between" width={size().columns - 4}>
          <text color="accent" bold>
            buTUI · agent runtime
          </text>
          <text color="muted">
            {size().columns}×{size().rows}
          </text>
        </row>

        <AgentView session={session} />
      </box>

      {/* 输入栏钉在底部：不参与 flow，因此转录区可以一直往下长 */}
      <layer x={0} y={size().rows - 3}>
        <box
          border
          padding={[0, 1]}
          borderColor={permission() ? "muted" : "focus"}
          width={size().columns}
        >
          <row gap={1}>
            <text color="accent" bold>
              ›
            </text>
            <text color="fg">{input()}</text>
            <Show when={!permission()}>
              <text color="focus">▏</text>
            </Show>
            <Show when={permission()}>
              <text color="warning">等待权限响应（y / n）</text>
            </Show>
          </row>
        </box>
      </layer>

      <layer x={0} y={size().rows - 1}>
        <text color="muted">
          {" "}
          {status()} · ctrl+c 退出
        </text>
      </layer>
    </box>
  );
}
