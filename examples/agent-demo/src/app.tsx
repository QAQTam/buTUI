/**
 * Agent demo —— 完全由事件协议驱动。
 *
 * 界面里没有任何「模拟 agent」的逻辑：所有内容都来自 `AgentEvent`，
 * 所有操作都走 `UiCommand`。mock agent 换成真 agent 时这个文件不用改。
 */
import { AgentView, ArtifactCanvas, type Session } from "@butui/agent";
import { type ImageLayer, artifactImageRenderer } from "@butui/image";
import { Show } from "solid-js";
import { type TextEditor, Input } from "@butui/components";
import type { TuiSize } from "@butui/runtime";
import { permission, status } from "./state.ts";

/** 宽终端才开侧栏；窄终端里 artifact 面板会把对话挤没 */
const PANEL_WIDTH = 42;
const PANEL_MIN_COLUMNS = 100;

export interface AppProps {
  session: Session;
  /** 由 @butui/runtime 提供：resize 后读到的就是新值 */
  size: () => TuiSize;
  /** 输入框的编辑模型（光标 / 历史 / 提交都在里面） */
  editor: TextEditor;
  /** 图片 artifact 走 Kitty / iTerm2 / Sixel / 半块（SPEC §12），由图层统一摆放 */
  imageLayer?: ImageLayer;
  /** 图片是异步加载的：加载完要主动重绘一帧 */
  onImageLoad?: () => void;
}

export function App(props: AppProps) {
  const session = props.session;
  const size = props.size;
  const showPanel = () => size().columns >= PANEL_MIN_COLUMNS && session.state.artifacts.length > 0;
  const renderArtifactImage = artifactImageRenderer({
    layer: props.imageLayer,
    policy: { roots: [process.cwd()] },
    width: PANEL_WIDTH - 6,
    onUpdate: props.onImageLoad,
  });

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

        <row gap={1} width={size().columns - 4}>
          <box flexGrow={1}>
            <AgentView session={session} />
          </box>

          {/* SPEC §11.1：artifact 面板是**独立面板**，不塞进对话流里 */}
          <Show when={showPanel()}>
            <box border="round" borderColor="muted" padding={1} width={PANEL_WIDTH}>
              <ArtifactCanvas
                artifacts={session.state.artifacts}
                session={session}
                compare
                title="artifacts"
                renderers={{ image: renderArtifactImage }}
              />
            </box>
          </Show>
        </row>
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
            <Show
              when={!permission()}
              fallback={<text color="warning">等待权限响应（y / n）</text>}
            >
              <Input
                editor={props.editor}
                width={size().columns - 8}
                placeholder="说点什么…（Enter 发送，↑↓ 翻历史）"
                autoFocus
              />
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
