import type { KeyEvent, Node } from "@butui/core";
import { useMouseCapture } from "@butui/solid";
import { Show, createSignal } from "solid-js";
import type { SliderModel } from "./slider.ts";

export interface SliderProps {
  model: SliderModel;
  /** 轨道宽度（cell），默认 20 */
  width?: number;
  /** 轨道字符，默认 `─` */
  trackChar?: string;
  /** thumb 字符，默认 `●` */
  thumbChar?: string;
  trackColor?: string;
  thumbColor?: string;
  /** 右侧显示当前值 */
  showValue?: boolean;
  valueColor?: string;
  semantic?: string;
}

/**
 * 单行 slider。
 *
 * 鼠标拖动使用 runtime 的 `localX` + pointer capture；拖出组件矩形仍继续更新。
 */
export function Slider(props: SliderProps) {
  const width = (): number => Math.max(2, Math.floor(props.width ?? 20));
  const pos = (): number => props.model.position(width());
  const trackChar = (): string => props.trackChar ?? "─";
  const thumbChar = (): string => props.thumbChar ?? "●";
  const [node, setNode] = createSignal<Node>();
  const capture = useMouseCapture();

  const beginAt = (position: number): void => {
    const current = node();
    if (current) capture?.capture(current);
    props.model.beginDrag(position, width());
  };

  const drag = (localX: number | undefined): void => {
    if (localX === undefined) return;
    props.model.drag(localX, width());
  };

  const end = (): void => {
    props.model.endDrag();
    capture?.release();
  };

  const onKey = (event: KeyEvent): void => {
    if (props.model.handleKey(event)) event.preventDefault();
  };

  return (
    <row gap={1}>
      <row
        ref={setNode}
        width={width()}
        height={1}
        focusable
        selectable={false}
        semantic={props.semantic ?? "slider"}
        onDrag={event => drag(event.localX)}
        onDragEnd={end}
        onMouseUp={end}
        onKey={onKey}
      >
        <Show when={pos() > 0}>
          <text
            color={props.trackColor ?? "border"}
            onMouseDown={event => beginAt(event.localX ?? 0)}
          >
            {trackChar().repeat(pos())}
          </text>
        </Show>
        <text
          color={props.thumbColor ?? "accent"}
          onMouseDown={event => beginAt(pos() + (event.localX ?? 0))}
        >
          {thumbChar()}
        </text>
        <Show when={width() - pos() - 1 > 0}>
          <text
            color={props.trackColor ?? "border"}
            onMouseDown={event =>
              beginAt(pos() + 1 + (event.localX ?? 0))
            }
          >
            {trackChar().repeat(width() - pos() - 1)}
          </text>
        </Show>
      </row>
      <Show when={props.showValue}>
        <text color={props.valueColor ?? "muted"}>{String(props.model.value())}</text>
      </Show>
    </row>
  );
}
