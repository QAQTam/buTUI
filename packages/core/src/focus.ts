/**
 * 焦点树（SPEC §9.4）。
 *
 * 只处理 Tab 顺序与 focus trap；键盘事件冒泡由事件层负责。
 */
import { type Node, walk } from "./node.ts";

export interface FocusState {
  /** 当前聚焦节点的 id */
  current: number | null;
  /** focus trap：只在子树内循环（modal / dialog 用） */
  trap: Node | null;
}

const states = new WeakMap<Node, FocusState>();

export function getFocusState(root: Node): FocusState {
  let state = states.get(root);
  if (!state) {
    state = { current: null, trap: null };
    states.set(root, state);
  }
  return state;
}

/** 可聚焦判定：显式 `focusable` 为 true，且自身与祖先都不 disabled */
export function isFocusable(node: Node): boolean {
  if (node.kind !== "element") return false;
  if (node.props.focusable !== true) return false;
  let cur: Node | null = node;
  while (cur) {
    if (cur.kind === "element" && cur.props.disabled) return false;
    cur = cur.parent;
  }
  return true;
}

/** 按树序收集可聚焦节点；focus trap 生效时只收 trap 子树 */
export function focusOrder(root: Node): Node[] {
  const state = getFocusState(root);
  const scope = state.trap ?? root;
  const out: Node[] = [];
  for (const node of walk(scope)) if (isFocusable(node)) out.push(node);
  return out;
}

function move(root: Node, delta: number): Node | undefined {
  const order = focusOrder(root);
  if (order.length === 0) return undefined;
  const state = getFocusState(root);
  const index = order.findIndex(n => n.id === state.current);
  // 当前焦点不在顺序里（首次 / 被卸载）时，从两端进入
  const next = index === -1
    ? (delta > 0 ? order[0] : order[order.length - 1])
    : order[(index + delta + order.length) % order.length];
  state.current = next.id;
  return next;
}

export function focusNext(root: Node): Node | undefined {
  return move(root, 1);
}

export function focusPrev(root: Node): Node | undefined {
  return move(root, -1);
}

export function focusNode(root: Node, node: Node | undefined): void {
  getFocusState(root).current = node ? node.id : null;
}

export function isFocused(root: Node, node: Node): boolean {
  return getFocusState(root).current === node.id;
}

/** 打开 focus trap（modal 用）；返回一个恢复函数 */
export function trapFocus(root: Node, scope: Node): () => void {
  const state = getFocusState(root);
  const previousTrap = state.trap;
  const previousCurrent = state.current;
  state.trap = scope;
  const order = focusOrder(root);
  if (order.length > 0) state.current = order[0].id;
  return () => {
    state.trap = previousTrap;
    state.current = previousCurrent;
  };
}
