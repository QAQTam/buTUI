import type { KeyEvent, MouseEvent, Node } from "@butui/core";
import {
  type AnimationScheduler,
  type DragInertiaHandle,
  startDragInertia,
  useMouseCapture,
} from "@butui/solid";
import { Show, createSignal, onCleanup } from "solid-js";
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
  /** 释放 thumb 后按速度继续移动；默认 true */
  inertia?: boolean;
  /** 测试 / 嵌入方注入惯性调度器 */
  inertiaScheduler?: AnimationScheduler;
  /** 测试 / 嵌入方覆盖 reduced-motion 检测 */
  inertiaReducedMotion?: boolean;
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
  let inertia: DragInertiaHandle | undefined;

  const stopInertia = (): void => {
    inertia?.cancel();
    inertia = undefined;
  };

  const beginAt = (position: number): void => {
    stopInertia();
    const current = node();
    if (current) capture?.capture(current);
    props.model.beginDrag(position, width());
  };

  const drag = (localX: number | undefined): void => {
    if (localX === undefined) return;
    props.model.drag(localX, width());
  };

  const end = (event?: MouseEvent): void => {
    if (props.model.dragging()) {
      props.model.endDrag();
      capture?.release();
    }
    if (
      event?.action === "dragend" &&
      props.inertia !== false &&
      (event.velocityX ?? 0) !== 0
    ) {
      stopInertia();
      inertia = startDragInertia({
        velocityX: event.velocityX,
        ...(props.inertiaScheduler ? { scheduler: props.inertiaScheduler } : {}),
        ...(props.inertiaReducedMotion !== undefined
          ? { reducedMotion: props.inertiaReducedMotion }
          : {}),
        onStep: deltaX => {
          props.model.setFromPosition(props.model.position(width()) + deltaX, width());
        },
        onEnd: () => {
          inertia = undefined;
        },
      });
    }
  };

  onCleanup(stopInertia);

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
        onDragEnd={event => end(event)}
        onMouseUp={event => end(event)}
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
