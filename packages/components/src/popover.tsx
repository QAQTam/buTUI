import type { KeyEvent } from "@butui/core";
import { useSize } from "@butui/solid";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show } from "solid-js";
import type { PopoverController } from "./popover.ts";
import {
  tooltipPosition,
  type TooltipPlacement,
  type TooltipPoint,
} from "./tooltip.ts";

export interface PopoverProps {
  controller: PopoverController;
  children: JSX.Element;
  placement?: TooltipPlacement;
  offset?: number;
  width?: number;
  height?: number;
  onDismiss?: () => void;
  semantic?: string;
}

/**
 * 交互式 Popover layer。
 *
 * 目标节点负责调用 controller 的 show / toggle / hide；本组件只负责根 layer
 * 定位和 Esc 关闭。内容可放 Button / Input 等交互组件。
 */
export function Popover(props: PopoverProps) {
  const size = useSize();
  const width = (): number => Math.max(4, Math.floor(props.width ?? 32));
  const height = (): number => Math.max(1, Math.floor(props.height ?? 8));
  const position = (): TooltipPoint => {
    const anchor = props.controller.anchor() ?? { x: 0, y: 0 };
    const current = size();
    return tooltipPosition({
      anchor,
      width: width(),
      height: height(),
      placement: props.placement ?? "bottom",
      columns: current.columns,
      rows: current.rows,
      offset: props.offset,
    });
  };
  const dismiss = (): void => {
    props.controller.hide();
    props.onDismiss?.();
  };

  return (
    <Show when={props.controller.open()}>
      <layer x={position().x} y={position().y}>
        <box
          width={width()}
          height={height()}
          border="round"
          borderColor="border"
          bg="bg"
          padding={1}
          focusable
          semantic={props.semantic ?? "popover"}
          onKey={(event: KeyEvent) => {
            if (event.name === "escape") {
              event.preventDefault();
              dismiss();
            }
          }}
        >
          {props.children}
        </box>
      </layer>
    </Show>
  );
}
