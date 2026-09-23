/**
 * `<ScrollBar>` —— 精确轨道坐标的垂直滚动条。
 *
 * 每一行轨道都是一个独立 cell 坐标，因此拖动不需要把终端绝对 y 猜成局部 y。
 * 组件只负责画和把轨道行号交给模型；测量、比例和反算都在纯函数里。
 */
import type { ScrollBarModel } from "./scrollbar.ts";
import { Repeat, Show } from "solid-js";

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
        onMouseDown={() => props.model.beginDrag(index)}
        onMouseMove={() => props.model.drag(index)}
        onMouseUp={() => props.model.endDrag()}
      >
        <text color={active() ? (props.thumbColor ?? "accent") : (props.trackColor ?? "border")}>
          {char()}
        </text>
      </row>
    );
  };

  return (
    <box
      width={1}
      selectable={false}
      semantic={props.semantic ?? "scrollbar"}
      onMouseUp={() => props.model.endDrag()}
    >
      <Show when={geometry().track > 0}>
        <Repeat count={geometry().track}>{index => row(index)}</Repeat>
      </Show>
    </box>
  );
}
