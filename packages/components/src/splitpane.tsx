/**
 * `<SplitPane>` —— 可拖动分隔条的双窗格容器。
 *
 * 根节点持有 pointer capture，拖动坐标始终相对根节点；分隔条移动时不会让
 * `localX / localY` 的参考原点跟着漂移。两个窗格用 flexGrow 分配父容器空间，
 * 因而嵌套在任意容器里都能跟随尺寸，`size` 只负责拖动几何与 min/max。
 */
import type { KeyEvent, Node } from "@butui/core";
import { useMouseCapture, useSize } from "@butui/solid";
import type { JSX } from "@butui/solid/jsx-runtime";
import { createSignal } from "solid-js";
import type { SplitPaneModel } from "./splitpane.ts";

export interface SplitPaneProps {
  model: SplitPaneModel;
  first: JSX.Element;
  second: JSX.Element;
  /**
   * 拖动几何使用的总尺寸（cell）。
   *
   * 默认取终端对应轴；外层容器不是终端全尺寸、且 width / height 也不是数字时，
   * 应显式传入实际尺寸。
   */
  size?: number;
  width?: number | `${number}%`;
  height?: number | `${number}%`;
  /** 分隔条字符；默认水平分栏 `│`、垂直分栏 `─` */
  separatorChar?: string;
  separatorColor?: string;
  semantic?: string;
}

export function SplitPane(props: SplitPaneProps) {
  const appSize = useSize();
  const [node, setNode] = createSignal<Node>();
  const capture = useMouseCapture();

  const orientation = (): ReturnType<SplitPaneModel["orientation"]> =>
    props.model.orientation();
  const size = (): number => {
    if (props.size !== undefined) return Math.max(0, Math.floor(props.size));
    if (orientation() === "horizontal" && typeof props.width === "number") {
      return Math.max(0, Math.floor(props.width));
    }
    if (orientation() === "vertical" && typeof props.height === "number") {
      return Math.max(0, Math.floor(props.height));
    }
    return orientation() === "horizontal" ? appSize().columns : appSize().rows;
  };
  const geometry = (): ReturnType<SplitPaneModel["geometry"]> =>
    props.model.geometry(size());
  const separatorChar = (): string =>
    props.separatorChar ?? (orientation() === "horizontal" ? "│" : "─");

  const begin = (): void => {
    if (!props.model.beginDrag(size())) return;
    const current = node();
    if (current) capture?.capture(current);
  };

  const drag = (local: number | undefined): void => {
    if (local === undefined) return;
    props.model.drag(local, size());
  };

  const end = (): void => {
    if (!props.model.dragging()) return;
    props.model.endDrag();
    const current = node();
    if (current && capture?.captured() === current) capture.release();
  };

  const onKey = (event: KeyEvent): void => {
    if (props.model.handleKey(event, size())) event.preventDefault();
  };

  const separator = () => (
    <box
      width={orientation() === "horizontal" ? geometry().separator : "100%"}
      height={orientation() === "vertical" ? geometry().separator : "100%"}
      focusable
      selectable={false}
      cursor={orientation() === "horizontal" ? "col-resize" : "row-resize"}
      semantic={`${props.semantic ?? "split-pane"}:separator`}
      onMouseDown={begin}
      onKey={onKey}
    >
      <text color={props.separatorColor ?? "border"} wrap={false}>
        {separatorChar().repeat(400)}
      </text>
    </box>
  );

  const common = {
    ref: setNode,
    width: props.width ?? "100%",
    height: props.height ?? "100%",
    semantic: props.semantic ?? "split-pane",
    onDrag: (event: Parameters<NonNullable<JSX.BoxProps["onDrag"]>>[0]) =>
      drag(orientation() === "horizontal" ? event.localX : event.localY),
    onDragEnd: end,
    onMouseUp: end,
  } as const;

  if (orientation() === "horizontal") {
    return (
      <row {...common}>
        <box flexGrow={geometry().first} height="100%" overflow="hidden">
          {props.first}
        </box>
        {separator()}
        <box flexGrow={geometry().second} height="100%" overflow="hidden">
          {props.second}
        </box>
      </row>
    );
  }

  return (
    <box {...common}>
      <box flexGrow={geometry().first} width="100%" overflow="hidden">
        {props.first}
      </box>
      {separator()}
      <box flexGrow={geometry().second} width="100%" overflow="hidden">
        {props.second}
      </box>
    </box>
  );
}
