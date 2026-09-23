/**
 * `<Tree>` —— SPEC §10.1。
 *
 * 展开状态**受控**（`expanded` + `onToggle`），组件不藏状态：文件树、分支树、
 * 会话树都要能被命令 / 快捷键 / 回放同时驱动，藏一份内部状态就做不到。
 *
 * 键盘（SPEC §9.4 的树约定）：
 *
 *   ↑ ↓        上下移动（跳过折叠起来的子树）
 *   →          展开；已展开则进入第一个子节点
 *   ←          收起；已是叶子或已收起则回到父节点
 *   Enter      叶子 → onActivate；有子节点 → 展开/收起
 *
 * 实现上就是「把树按当前展开状态拍平成一列」再交给 `<List>` —— 虚拟化、滚动
 * 跟随、鼠标点击、语义标识全部复用，一行都不用重写。
 */
import type { KeyEvent } from "@butui/core";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show } from "solid-js";
import { List } from "./list.tsx";
import { createSelection } from "./selection.ts";
import { createEffect } from "solid-js";

export interface TreeNode<T = unknown> {
  id: string;
  label: string;
  children?: readonly TreeNode<T>[];
  /** 叶子被激活时回传给应用 */
  data?: T;
}

export interface TreeProps<T = unknown> {
  nodes: readonly TreeNode<T>[];
  /** 展开的节点 id 集合（受控） */
  expanded: ReadonlySet<string> | readonly string[];
  onToggle: (id: string, expanded: boolean) => void;
  /** 叶子被 Enter / 点击时触发 */
  onActivate?: (node: TreeNode<T>) => void;
  height?: number;
  autoFocus?: boolean;
  /** 缩进宽度（cell），默认 2 */
  indent?: number;
  semantic?: string;
  /** 额外按键处理：先于树自己的键位；返回 true 表示已消费 */
  onKey?: (event: KeyEvent) => boolean | void;
}

interface FlatRow<T> {
  node: TreeNode<T>;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  /** 父节点在拍平数组里的下标（根为 -1） */
  parentIndex: number;
}

/** 按展开状态把树拍平成一列（只包含可见节点） */
export function flattenTree<T>(
  nodes: readonly TreeNode<T>[],
  expanded: ReadonlySet<string> | readonly string[],
  has: (id: string) => boolean = id =>
    expanded instanceof Set ? expanded.has(id) : (expanded as readonly string[]).includes(id)
): FlatRow<T>[] {
  const rows: FlatRow<T>[] = [];
  const walk = (list: readonly TreeNode<T>[], depth: number, parentIndex: number): void => {
    for (const node of list) {
      const children = node.children ?? [];
      const isExpanded = has(node.id);
      const index = rows.length;
      rows.push({ node, depth, hasChildren: children.length > 0, isExpanded, parentIndex });
      if (isExpanded && children.length > 0) walk(children, depth + 1, index);
    }
  };
  walk(nodes, 0, -1);
  return rows;
}

export function Tree<T = unknown>(props: TreeProps<T>) {
  const indent = (): number => Math.max(0, props.indent ?? 2);
  const rows = (): FlatRow<T>[] => flattenTree(props.nodes, props.expanded);
  const selection = createSelection({
    count: () => rows().length,
    index: 0,
  });

  // 收起子树后，选中项可能落在不存在的行上 —— 让选择模型自己夹回来
  createEffect(
    () => rows().length,
    total => selection.setIndex(Math.min(selection.index(), Math.max(0, total - 1)))
  );

  const current = (): FlatRow<T> | undefined => rows()[selection.index()];

  const toggle = (row: FlatRow<T>): void => {
    if (!row.hasChildren) return;
    props.onToggle(row.node.id, !row.isExpanded);
  };

  const handleKey = (event: KeyEvent): boolean | void => {
    if (props.onKey?.(event) === true) return true;
    const row = current();
    if (!row) return;
    if (event.name === "right") {
      // 展开；已经展开就走进第一个子节点
      if (row.hasChildren && !row.isExpanded) props.onToggle(row.node.id, true);
      else if (row.isExpanded) selection.move(1);
      return true;
    }
    if (event.name === "left") {
      if (row.hasChildren && row.isExpanded) props.onToggle(row.node.id, false);
      else if (row.parentIndex >= 0) selection.setIndex(row.parentIndex);
      return true;
    }
    return false; // ↑↓ / Home / End / PageUp / PageDown 交给 <List>
  };

  return (
    <List
      items={rows()}
      selection={selection}
      height={props.height}
      autoFocus={props.autoFocus}
      semantic={props.semantic ?? "tree"}
      activateOnClick
      itemSemantic={row => `tree:${row.node.id}`}
      onKey={handleKey}
      onActivate={row => {
        if (row.hasChildren) toggle(row);
        else props.onActivate?.(row.node);
      }}
      renderItem={(row, _index, state) => (
        <row gap={1}>
          <text color="muted">
            {" ".repeat(row.depth * indent())}
            <Show when={row.hasChildren} fallback={" "}>
              {row.isExpanded ? "▾" : "▸"}
            </Show>
          </text>
          <text color={state.selected() ? "fg" : "muted"}>{row.node.label}</text>
        </row>
      )}
    />
  );
}
