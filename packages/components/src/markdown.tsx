/**
 * `<Markdown>` —— SPEC §10.1。
 *
 * 静态 markdown 走的是**和流式同一套引擎**（`@butui/stream` 的
 * `createMarkdownStream`）：块解析 + 行内样式一次性做完，交给 `<stream>` 节点
 * 渲染。于是「历史消息」和「正在流式的消息」画出来完全一样 —— 不需要两套
 * markdown 实现，也不会出现「流式时一种样子、定稿后另一种样子」。
 *
 * `width` 必须由调用方给：折行宽度决定行数与块结构，而组件拿不到自己的列宽
 * （它可能在侧栏、在带 padding 的盒子里）。给一个比可用宽度小的值只会让文字
 * 提前折行，不会画错。
 */
import { createMarkdownStream } from "@butui/stream";
import { createMemo } from "solid-js";

export interface MarkdownProps {
  /** markdown 源文本 */
  source: string;
  /** 折行宽度（cell），默认 80 */
  width?: number;
  color?: string;
  semantic?: string;
}

export function Markdown(props: MarkdownProps) {
  const stream = createMemo(() => {
    const source = createMarkdownStream({ width: Math.max(8, props.width ?? 80) });
    source.push(props.source ?? "");
    source.flush();
    return source;
  });

  return (
    <stream
      lines={stream().lines}
      version={stream().lines.length}
      tail=""
      color={props.color}
      semantic={props.semantic ?? "markdown"}
    />
  );
}
