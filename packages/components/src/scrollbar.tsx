/**
 * `<ScrollBar>` —— 精确轨道坐标的垂直滚动条。
 *
 * 每一行轨道都是一个独立 cell 坐标，因此拖动不需要把终端绝对 y 猜成局部 y。
 * 组件只负责画和把轨道行号交给模型；测量、比例和反算都在纯函数里。
 */
import type { Node } from "@butui/core";
import { useMouseCapture } from "@butui/solid";
import { Repeat, Show, createSignal } from "solid-js";
import type { ScrollBarModel } from "./scrollbar.ts";

export interface ScrollBarProps {
  model: ScrollBarModel;
  /** 轨道字符，默认 `│` */
  trackChar?: string;
  /** thumb 字符，默认 `█` */
  thumbChar?: string;
  /** 没有溢出时显示什么；默认空格（保留宽度） */
  idleChar?: string;
  trackColor?: string;
  thumbColor?: string;
  semantic?: string;
}

export function ScrollBar(props: ScrollBarProps) {
  const geometry = (): ReturnType<ScrollBarModel["geometry"]> => props.model.geometry();
  const trackChar = (): string => props.trackChar ?? "│";
  const thumbChar = (): string => props.thumbChar ?? "█";
  const idleChar = (): string => props.idleChar ?? " ";
  const [node, setNode] = createSignal<Node>();
  const capture = useMouseCapture();

  const begin = (trackY: number): void => {
    if (!props.model.beginDrag(trackY)) return;
    const current = node();
    if (current) capture?.capture(current);
  };

  const drag = (localY: number | undefined): void => {
    if (localY === undefined) return;
    props.model.drag(localY);
  };

  const end = (): void => {
    props.model.endDrag();
    capture?.release();
  };

  const row = (index: number) => {
    const active = (): boolean => {
      const current = geometry();
      return current.overflow && index >= current.thumbStart && index < current.thumbStart + current.thumbSize;
    };
    const char = (): string => {
      if (!geometry().overflow) return idleChar();
      return active() ? thumbChar() : trackChar();
    };
    return (
      <row
        width={1}
        height={1}
        onMouseDown={() => begin(index)}
      >
        <text color={active() ? (props.thumbColor ?? "accent") : (props.trackColor ?? "border")}>
          {char()}
        </text>
      </row>
    );
  };

  return (
    <box
      ref={setNode}
      width={1}
      selectable={false}
      semantic={props.semantic ?? "scrollbar"}
      onDrag={event => drag(event.localY)}
      onDragEnd={end}
      onMouseUp={end}
    >
      <Show when={geometry().track > 0}>
        <Repeat count={geometry().track}>{index => row(index)}</Repeat>
      </Show>
    </box>
  );
}
