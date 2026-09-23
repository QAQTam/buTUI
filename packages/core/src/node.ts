/**
 * buTUI 节点树。
 *
 * 这是 SPEC §6 里 `@butui/core` 的「节点、属性、生命周期」部分。
 *
 * 设计约束（来自 SPEC §4.5）：这棵树必须刚好满足 `@solidjs/universal`
 * 的 `RendererOptions` 契约，不能多也不能少 —— Solid 已经自带 reconciler，
 * buTUI 只提供树。
 *
 * 失效模型：每个节点有单调递增的 `rev`。任何修改都会把 `rev` 沿祖先链向上
 * 刷成同一个新值。布局缓存以 `(rev, width)` 为键，因此：
 *   - 改了 text 节点 → 它自己和所有祖先 rev 变化 → 重新测量
 *   - 兄弟子树 rev 不变 → 直接命中缓存
 * 这就是 SPEC §17「流式输出不整屏闪烁」的结构性保证。
 */

export type NodeKind = "element" | "text" | "sentinel";

export interface NodeBase {
  readonly id: number;
  readonly kind: NodeKind;
  parent: Node | null;
  readonly children: Node[];
  /** 节点自身 + 子树的修改版本号 */
  rev: number;
  /**
   * 所有子节点 `rev` 之和。
   *
   * 因为 rev 只增不减，这个和在 O(1) 时间里就能判断「某个前缀有没有被改过」：
   * 前缀和不变 ⟺ 前缀里每个子节点都没动。增量布局靠它判断「只有最后一段
   * 内容在增长」而不用扫描全部子节点。
   */
  childrenRevSum: number;
  /** 语义标识，供 hit test 返回 `message:<id>` / `tool:<callId>`（SPEC §4.2） */
  semantic?: string;
}

export interface ElementNode extends NodeBase {
  readonly kind: "element";
  tag: string;
  props: Record<string, unknown>;
}

export interface TextNode extends NodeBase {
  readonly kind: "text" | "sentinel";
  value: string;
}

/**
 * 可辨识联合，而不是 `interface Node { kind: NodeKind }`。
 * 这样 `node.kind !== "element"` 就能把类型收窄到 TextNode，
 * layout / focus 里不需要到处写类型断言。
 */
export type Node = ElementNode | TextNode;

export function isElement(node: Node): node is ElementNode {
  return node.kind === "element";
}

export function isText(node: Node): node is TextNode {
  return node.kind !== "element";
}

export const stats = { created: 0, touched: 0 };
let nextId = 1;
let revision = 1;

/** 单调递增的全局修订号，供渲染器做帧级比较 */
export function currentRevision(): number {
  return revision;
}

/**
 * 变更订阅 —— 任何 `touch()` 都会通知。
 *
 * 这是「应用不需要自己安排重绘」的基础设施：运行时订阅一次，之后不管变更来自
 * 键盘、定时器、还是异步图片加载，都会自动合并到下一帧。没有它，每个 app 都要
 * 手写 `schedulePaint` 并在每个可能改状态的地方记得调用（demo 里曾经有 6 处）。
 *
 * 回调必须是 O(1) 且不能改树 —— 它会在 `touch()` 的调用栈里同步执行。
 */
const mutationListeners = new Set<(node: Node) => void>();

export function onMutation(listener: (node: Node) => void): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

/** 把一个节点及其全部祖先标记为脏 */
export function touch(node: Node): void {
  stats.touched++;
  const rev = ++revision;
  let cur: Node | null = node;
  let previousRev = cur.rev;
  while (cur) {
    cur.rev = rev;
    const parent: Node | null = cur.parent;
    if (!parent) break;
    // 维护父节点的子节点 rev 和：cur 的 rev 从 previousRev 变成 rev
    parent.childrenRevSum += rev - previousRev;
    previousRev = parent.rev;
    cur = parent;
  }
  for (const listener of mutationListeners) listener(node);
}

function base(kind: NodeKind): NodeBase {
  stats.created++;
  return { id: nextId++, kind, parent: null, children: [], rev: ++revision, childrenRevSum: 0 };
}

export function createElement(tag: string, staticProps?: Record<string, unknown>): ElementNode {
  const node = base("element") as unknown as ElementNode;
  node.tag = tag;
  node.props = staticProps ? { ...staticProps } : {};
  applySemantic(node, node.props.semantic);
  return node;
}

export function createTextNode(value: string): TextNode {
  const node = base("text") as unknown as TextNode;
  node.value = value;
  return node;
}

/**
 * Solid 的 `insert()` 在多子节点场景会插入一个哨兵占位。
 * TUI 里它必须是一个真实的、零宽度的节点，否则锚点定位会错位。
 */
export function createSentinel(): TextNode {
  const node = base("sentinel") as unknown as TextNode;
  node.value = "";
  return node;
}

export function replaceText(node: TextNode, value: string): void {
  if (node.value === value) return;
  node.value = value;
  touch(node);
}

export function setProp(node: ElementNode, name: string, value: unknown, prev?: unknown): void {
  if (Object.is(node.props[name], value)) return;
  node.props[name] = value;
  // `semantic` 是 SPEC §4.2 的一等公民，提升到节点字段上，
  // 这样 layout 的 hit test 不用每次都去翻 props
  if (name === "semantic") applySemantic(node, value);
  touch(node);
}

function applySemantic(node: ElementNode, value: unknown): void {
  node.semantic = typeof value === "string" ? value : undefined;
}

export function insertNode(parent: Node, node: Node, anchor?: Node): void {
  if (node.parent === parent) {
    const from = parent.children.indexOf(node);
    if (from !== -1) {
      parent.children.splice(from, 1);
      parent.childrenRevSum -= node.rev;
    }
  } else if (node.parent) {
    removeNode(node.parent, node);
  }
  const at = anchor ? parent.children.indexOf(anchor) : -1;
  if (at === -1) parent.children.push(node);
  else parent.children.splice(at, 0, node);
  node.parent = parent;
  parent.childrenRevSum += node.rev;
  touch(parent);
}

export function removeNode(parent: Node, node: Node): void {
  const at = parent.children.indexOf(node);
  if (at === -1) return;
  parent.children.splice(at, 1);
  parent.childrenRevSum -= node.rev;
  node.parent = null;
  touch(parent);
}

export function getParentNode(node: Node): Node | undefined {
  return node.parent ?? undefined;
}

export function getFirstChild(node: Node): Node | undefined {
  return node.children[0];
}

export function getNextSibling(node: Node): Node | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  return parent.children[parent.children.indexOf(node) + 1];
}

/** 深度优先遍历（含自身） */
export function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

/** 从任意节点向上找最近的根 */
export function rootOf(node: Node): Node {
  let cur = node;
  while (cur.parent) cur = cur.parent;
  return cur;
}

/** 打上语义标识，hit test 时直接返回它 */
export function setSemantic(node: Node, semantic: string | undefined): void {
  node.semantic = semantic;
}

/** 从某个节点向上找到第一个带语义标识的祖先（用于「点到文字也算点到卡片」） */
export function semanticOf(node: Node | undefined): string | undefined {
  let cur = node;
  while (cur) {
    if (cur.semantic) return cur.semantic;
    cur = cur.parent ?? undefined;
  }
  return undefined;
}

/**
 * 按 id 找节点。
 *
 * 帧里存的是节点 id（hit test / 焦点都只记 id，不持有对象引用），
 * 运行时要把 id 换回节点再派发事件，所以这个查找是一等公民。
 */
export function nodeById(root: Node, id: number | undefined): Node | undefined {
  if (id === undefined) return undefined;
  for (const node of walk(root)) if (node.id === id) return node;
  return undefined;
}
