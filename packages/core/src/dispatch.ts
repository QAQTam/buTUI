/**
 * 事件派发（SPEC §9.4「键盘事件冒泡」）。
 *
 * 从目标节点向上冒泡，遇到 `stopPropagation()` 就停。
 * 目标节点由 hit test（鼠标）或焦点树（键盘）决定。
 */
import { type ButuiEvent, type MouseEvent, isPropagationStopped } from "./events.ts";
import { type Node, isElement, semanticOf } from "./node.ts";

export function handlerName(event: ButuiEvent): string {
  switch (event.type) {
    case "key":
      return "onKey";
    case "mouse":
      switch (event.action) {
        case "wheel":
          return "onWheel";
        case "press":
          return "onMouseDown";
        case "release":
          return "onMouseUp";
        case "move":
          return "onMouseMove";
      }
    case "paste":
      return "onPaste";
    case "focus":
      return event.type === "focus" ? "onFocus" : "onBlur";
    case "resize":
      return "onResize";
    default:
      return "onEvent";
  }
}

function handlerNames(event: ButuiEvent): readonly string[] {
  const primary = handlerName(event);
  // 兼容原来的 onClick 语义：没有 onMouseDown 时，按下仍触发 onClick。
  // release / move 不再回退到 onClick，否则拖拽会被当成连续点击。
  if (event.type === "mouse" && event.action === "press") return [primary, "onClick"];
  return [primary];
}

export interface DispatchOptions {
  /** 只冒泡到该节点为止（focus trap 用） */
  until?: Node;
}

/**
 * 派发事件。返回实际收到事件的节点数，便于测试断言。
 */
export function dispatchEvent(
  target: Node | undefined,
  event: ButuiEvent,
  options: DispatchOptions = {}
): number {
  if (!target) return 0;
  const names = handlerNames(event);
  let delivered = 0;
  let cur: Node | null = target;

  // 鼠标事件顺手补上语义标识，handler 不必自己算（SPEC §4.2）
  if (event.type === "mouse" && event.semantic === undefined) {
    (event as MouseEvent).semantic = semanticOf(target);
  }
  (event as { target?: Node }).target = target;

  while (cur) {
    if (isElement(cur)) {
      // disabled 节点既不触发自己的 handler，也不继续向上冒泡
      if (cur.props.disabled) break;
      for (const name of names) {
        const handler = cur.props[name];
        if (typeof handler !== "function") continue;
        delivered++;
        (handler as (event: ButuiEvent) => void)(event);
        if (isPropagationStopped(event)) break;
        // 同一节点只取第一个可用别名：有 onMouseDown 就不再触发 onClick。
        break;
      }
      if (isPropagationStopped(event)) break;
    }
    if (options.until && cur === options.until) break;
    cur = cur.parent;
  }
  return delivered;
}
