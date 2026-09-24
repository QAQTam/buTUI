/**
 * 流式渲染组件。
 *
 * 每个流渲染成**一个 `<stream>` 节点**：Solid 侧每次 push 只产生一次
 * `setProp`（version / tail），布局侧只把新增行转成 cell。没有中间数组，
 * 也没有 O(N) 的 reconcile。
 */
import { onCleanup } from "solid-js";
import { createSmoothStream, type SmoothStreamOptions } from "./smooth.ts";
import type { StreamSource } from "./source.ts";

export interface StreamTextProps {
  source: StreamSource;
  /**
   * 平滑显现。`true` 使用默认 160 列/秒；也可传 speed / catchUpMs 等参数。
   * 已有历史会立即显示，只有组件挂载后新增的内容做 reveal。
   */
  smooth?: boolean | SmoothStreamOptions;
  color?: string;
  /** 语义标识，hit test 用（SPEC §4.2） */
  semantic?: string;
}

function streamSourceFor(props: StreamTextProps): StreamSource {
  if (!props.smooth) return props.source;
  const smooth = createSmoothStream(
    props.source,
    typeof props.smooth === "object" ? props.smooth : {}
  );
  onCleanup(() => smooth.dispose());
  return smooth;
}

/** 纯文本流：等宽、逐行渲染 */
export function StreamText(props: StreamTextProps) {
  const source = streamSourceFor(props);
  return (
    <stream
      lines={source.lines}
      version={source.version()}
      tail={source.tail()}
      color={props.color}
      semantic={props.semantic}
    />
  );
}

export interface StreamMarkdownProps extends StreamTextProps {
  codeColor?: string;
}

/** Markdown 流：行内样式已经由引擎烤进 ANSI */
export function StreamMarkdown(props: StreamMarkdownProps) {
  const source = streamSourceFor(props);
  return (
    <stream
      lines={source.lines}
      version={source.version()}
      tail={source.tail()}
      color={props.color}
      semantic={props.semantic}
    />
  );
}
