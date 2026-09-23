/**
 * `@butui/solid` —— SPEC §6 的 Solid 适配层。
 *
 * 这里是整个 buTUI 最薄也最关键的一层：只实现 `@solidjs/universal` 的
 * `RendererOptions`（13 个 host ops），把 Solid 的「DOM 式锚点插入」映射到
 * `@butui/core` 的节点树。
 *
 * 明确不做的事（SPEC §5.5）：
 *   - 不 fork / vendor solid-js
 *   - 不自己写 reconciler —— `createRenderer` 已经包含 insert / spread /
 *     reconcileArrays / cleanChildren 的全部逻辑
 */
import { createRenderer } from "@solidjs/universal";
import * as core from "@butui/core";

const renderer = createRenderer({
  createElement: core.createElement,
  createTextNode: core.createTextNode,
  createSentinel: core.createSentinel,
  replaceText: core.replaceText,
  isTextNode: core.isText,
  setProperty: core.setProp,
  insertNode: core.insertNode,
  removeNode: core.removeNode,
  getParentNode: core.getParentNode,
  getFirstChild: core.getFirstChild,
  getNextSibling: core.getNextSibling,
});

/** 编译器产物直接依赖这些名字，导出名必须精确匹配 */
export const {
  effect,
  memo,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  applyRef,
  ref,
} = renderer;

/**
 * 组件返回值的类型边界。
 *
 * Solid 的 `JSX.Element` 里包含 renderer-owned 的 `RenderedElement`（object）
 * 以及 string / number / null（文本插值），类型上收不到我们的 `Node`。
 * 这是 JSX 边界的固有松散度，运行时由 host ops 的 `insert` 负责归一化。
 */
export type Renderable = unknown;
export type Component<P = {}> = (props: P) => Renderable;

export const createComponent = renderer.createComponent as <T>(
  Comp: (props: T) => Renderable,
  props: T
) => core.Node;

export const render = renderer.render as (code: () => Renderable, node: core.Node) => () => void;

// 转发 Solid 控制流，使 `generate: "universal"` 的 moduleName 契约完整
export { For, Show, Switch, Match, Repeat, Errored, Loading } from "solid-js";

export type { Node, ElementNode, TextNode } from "@butui/core";
