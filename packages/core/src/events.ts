/**
 * 输入事件模型（SPEC §9.4）。
 *
 * 这里只有数据形状；把终端字节流解析成这些事件是 `@butui/terminal` 的职责。
 * 放在 core 是因为 JSX 类型和组件都依赖它。
 */
import type { Node } from "./node.ts";

export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface KeyEvent {
  type: "key";
  /** 归一化后的键名，如 `a` / `enter` / `escape` / `up` / `f1` */
  name: string;
  /** 若是一次文本输入，这里是实际字符（可能含 CJK / emoji） */
  text?: string;
  modifiers: KeyModifiers;
  /** 事件目标（hit test / focus 得出的节点） */
  target?: Node;
  /** 阻止冒泡 */
  stopPropagation: () => void;
  /** 标记已处理，避免上层再处理（如全局快捷键） */
  preventDefault: () => void;
  readonly defaultPrevented: boolean;
}

/** 滚轮方向（`action === "wheel"` 时才有值） */
export type WheelDirection = "up" | "down" | "left" | "right";

/**
 * 鼠标指针形状（OSC 22）。
 *
 * 名称与 CSS / OpenTUI 对齐；终端不支持时会忽略对应序列。`auto` 由 runtime
 * 根据节点是否可交互决定，`default` 强制恢复系统默认指针。
 */
export const MOUSE_POINTER_STYLES = [
  "auto",
  "default",
  "none",
  "context-menu",
  "help",
  "pointer",
  "progress",
  "wait",
  "cell",
  "crosshair",
  "text",
  "vertical-text",
  "alias",
  "copy",
  "move",
  "no-drop",
  "not-allowed",
  "grab",
  "grabbing",
  "all-scroll",
  "col-resize",
  "row-resize",
  "n-resize",
  "e-resize",
  "s-resize",
  "w-resize",
  "ne-resize",
  "nw-resize",
  "se-resize",
  "sw-resize",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "zoom-in",
  "zoom-out",
] as const;

export type MousePointerStyle = (typeof MOUSE_POINTER_STYLES)[number];

const MOUSE_POINTER_STYLE_SET = new Set<string>(MOUSE_POINTER_STYLES);

export function isMousePointerStyle(value: unknown): value is MousePointerStyle {
  return typeof value === "string" && MOUSE_POINTER_STYLE_SET.has(value);
}

export interface MouseEvent {
  type: "mouse";
  action:
    | "press"
    | "release"
    | "move"
    | "wheel"
    | "enter"
    | "leave"
    | "dragstart"
    | "drag"
    | "dragend";
  button: "left" | "middle" | "right" | "none";
  /**
   * 同一位置的连续点击次数。
   *
   * 原生终端只给 press/release，runtime 根据时间与坐标合成为 1 / 2。
   * `action === "enter" | "leave"` 的合成事件没有这个字段。
   */
  clickCount?: number;
  /**
   * 滚轮方向。
   *
   * 单独一个字段而不是塞进 `button`：`button` 的语义是「哪个键被按了」，
   * 滚轮没有键。终端解码器从 SGR 的 button 低位拿方向（64/65/66/67）。
   */
  wheel?: WheelDirection;
  /** 屏幕坐标（0-based，cell 单位） */
  x: number;
  y: number;
  /**
   * 相对事件目标节点左上角的坐标。
   *
   * 捕获 / drag 时可以是负数或超过节点尺寸 —— 这正是判断拖出边界所需的
   * 信息。目标节点不在当前 frame 时字段为 undefined。
   */
  localX?: number;
  localY?: number;
  /**
   * 释放速度，cell/ms；只在 `dragend` 上有值。
   *
   * runtime 用最近一小段指针采样计算；应用可据此启动惯性动画。
   */
  velocityX?: number;
  velocityY?: number;
  modifiers: KeyModifiers;
  target?: Node;
  /** 语义标识：`message:<id>` / `tool:<callId>` / `checkpoint:<id>`（SPEC §4.2） */
  semantic?: string;
  /**
   * presented routing 专用：事件目标来自已消失的旧 frame，随后按 semantic
   * 回退或退到 root。应用可据此忽略旧 UI 上的点击。
   */
  stale?: boolean;
  stopPropagation: () => void;
  preventDefault: () => void;
  readonly defaultPrevented: boolean;
}

export interface PasteEvent {
  type: "paste";
  text: string;
  target?: Node;
}

export interface ResizeEvent {
  type: "resize";
  columns: number;
  rows: number;
}

export interface FocusEvent {
  type: "focus" | "blur";
  target?: Node;
}

export type ButuiEvent = KeyEvent | MouseEvent | PasteEvent | ResizeEvent | FocusEvent;

export function createModifiers(
  ctrl = false,
  alt = false,
  shift = false,
  meta = false
): KeyModifiers {
  return { ctrl, alt, shift, meta };
}

/**
 * 构造一个带 stopPropagation / preventDefault 的事件外壳。
 *
 * 注意用 defineProperty 而不是 Object.assign —— 后者会把 getter 求值成
 * 快照，导致 `propagationStopped` 永远是 false。
 */
export function eventTarget<T extends object>(event: T): T & {
  stopPropagation: () => void;
  preventDefault: () => void;
  readonly defaultPrevented: boolean;
} {
  let stopped = false;
  let prevented = false;
  return Object.defineProperties(event, {
    stopPropagation: {
      value: () => {
        stopped = true;
      },
      enumerable: false,
    },
    preventDefault: {
      value: () => {
        prevented = true;
      },
      enumerable: false,
    },
    defaultPrevented: {
      get: () => prevented,
      enumerable: false,
    },
    propagationStopped: {
      get: () => stopped,
      enumerable: false,
    },
  }) as T & {
    stopPropagation: () => void;
    preventDefault: () => void;
    readonly defaultPrevented: boolean;
  };
}

export function isPropagationStopped(event: object): boolean {
  return (event as { propagationStopped?: boolean }).propagationStopped === true;
}
