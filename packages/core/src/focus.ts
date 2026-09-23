/**
 * 焦点树（SPEC §9.4）。
 *
 * 只处理 Tab 顺序与 focus trap；键盘事件冒泡由事件层负责。
 */
import { type Node, nodeById, walk } from "./node.ts";

export interface FocusState {
  /** 当前聚焦节点的 id */
  current: number | null;
  /** focus trap：只在子树内循环（modal / dialog 用） */
  trap: Node | null;
}

const states = new WeakMap<Node, FocusState>();

/**
 * 焦点变更订阅。
 *
 * 焦点是「应用级共享状态」，但组件不该为了知道「我是不是焦点」而去拿 root
 * （组件拿不到 root）。所以 core 负责通知，运行时把它转成响应式信号，组件再
 * 通过上下文读 —— 这样 `isFocused(node)` 是 O(1) 且响应式的。
 */
const focusListeners = new Set<(root: Node) => void>();

export function onFocusChange(listener: (root: Node) => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}

function notifyFocus(root: Node): void {
  for (const listener of focusListeners) listener(root);
}

export function getFocusState(root: Node): FocusState {
  let state = states.get(root);
  if (!state) {
    state = { current: null, trap: null };
    states.set(root, state);
  }
  return state;
}

/** 当前聚焦的节点（没有就是 undefined）。键盘事件的默认目标。 */
export function focusedNode(root: Node): Node | undefined {
  const state = getFocusState(root);
  return state.current === null ? undefined : nodeById(root, state.current);
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
  if (state.current !== next.id) {
    state.current = next.id;
    notifyFocus(root);
  }
  return next;
}

export function focusNext(root: Node): Node | undefined {
  return move(root, 1);
}

export function focusPrev(root: Node): Node | undefined {
  return move(root, -1);
}

export function focusNode(root: Node, node: Node | undefined): void {
  const state = getFocusState(root);
  const next = node ? node.id : null;
  if (state.current === next) return;
  state.current = next;
  notifyFocus(root);
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
  notifyFocus(root);
  return () => {
    state.trap = previousTrap;
    state.current = previousCurrent;
    notifyFocus(root);
  };
}
