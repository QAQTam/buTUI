/**
 * 流式渲染组件。
 *
 * 每个流渲染成**一个 `<stream>` 节点**：Solid 侧每次 push 只产生一次
 * `setProp`（version / tail），布局侧只把新增行转成 cell。没有中间数组，
 * 也没有 O(N) 的 reconcile。
 */
import type { StreamSource } from "./source.ts";

export interface StreamTextProps {
  source: StreamSource;
  color?: string;
  /** 语义标识，hit test 用（SPEC §4.2） */
  semantic?: string;
}

/** 纯文本流：等宽、逐行渲染 */
export function StreamText(props: StreamTextProps) {
  return (
    <stream
      lines={props.source.lines}
      version={props.source.version()}
      tail={props.source.tail()}
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
  return (
    <stream
      lines={props.source.lines}
      version={props.source.version()}
      tail={props.source.tail()}
      color={props.color}
      semantic={props.semantic}
    />
  );
}
