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

export interface MouseEvent {
  type: "mouse";
  action: "press" | "release" | "move" | "wheel" | "enter" | "leave";
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
  modifiers: KeyModifiers;
  target?: Node;
  /** 语义标识：`message:<id>` / `tool:<callId>` / `checkpoint:<id>`（SPEC §4.2） */
  semantic?: string;
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
