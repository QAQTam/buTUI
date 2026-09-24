import { useSize } from "@butui/solid";
import { Show } from "solid-js";
import {
  tooltipPosition,
  type TooltipController,
  type TooltipPlacement,
  type TooltipPoint,
} from "./tooltip.ts";

export interface TooltipProps {
  controller: TooltipController;
  content: string;
  placement?: TooltipPlacement;
  offset?: number;
  maxWidth?: number;
  disabled?: boolean;
  semantic?: string;
}

/**
 * 文本 tooltip layer。
 *
 * 目标节点自行绑定 controller 的 show / hide；本组件只负责根据屏幕锚点把
 * tooltip 合成到根 `<layer>`。应该和 `<Modal>` 一样挂在视图根部。
 */
export function Tooltip(props: TooltipProps) {
  const size = useSize();
  const tooltipSize = () => {
    const lines = props.content.split("\n");
    const naturalWidth =
      Math.max(0, ...lines.map(line => line.length)) + 4;
    const maxWidth = Math.max(4, props.maxWidth ?? 40);
    return {
      width: Math.min(maxWidth, Math.max(4, naturalWidth)),
      height: lines.length + 2,
    };
  };
  const position = (): TooltipPoint => {
    const anchor = props.controller.anchor() ?? { x: 0, y: 0 };
    const box = tooltipSize();
    const current = size();
    return tooltipPosition({
      anchor,
      width: box.width,
      height: box.height,
      placement: props.placement ?? "bottom",
      columns: current.columns,
      rows: current.rows,
      offset: props.offset,
    });
  };

  return (
    <Show when={!props.disabled && props.controller.visible()}>
      <layer x={position().x} y={position().y}>
        <box
          width={tooltipSize().width}
          border="round"
          borderColor="border"
          bg="bg"
          padding={1}
          semantic={props.semantic ?? "tooltip"}
          onMouseEnter={() => props.controller.show()}
          onMouseLeave={() => props.controller.hide()}
        >
          <text color="fg" wrap>
            {props.content}
          </text>
        </box>
      </layer>
    </Show>
  );
}
