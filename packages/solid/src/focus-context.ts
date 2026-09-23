/**
 * 焦点上下文 —— 让**任意深度的组件**知道「我是不是焦点」。
 *
 * 组件拿不到 root，而 `getFocusState(root)` 需要 root；靠 props 把 runtime
 * 一路传下去又太脏。所以：
 *
 *   core     焦点变化时通知（`onFocusChange`）
 *   runtime  把它转成响应式信号，并用这个上下文提供给整棵视图树
 *   组件     `useFocus()` 拿到 `(node) => boolean`，O(1) 且响应式
 *
 * 注意 Solid 2 RC 的 `createContext` **返回的就是 provider 函数本身**
 * （不是 `{ Provider }`），且没有默认值时 `useContext` 会抛
 * `ContextNotFoundError` —— 所以默认值必须给 `null`。
 */
import type { Node } from "@butui/core";
import { createContext, useContext } from "solid-js";

export interface FocusScope {
  /** 当前焦点节点 id（响应式） */
  focusedId(): number | null;
  /** 主动聚焦某个节点（`autoFocus` / 点击进入用） */
  focus(node: Node | undefined): void;
  /**
   * 把焦点限制在这个子树里（modal / dialog 用）；返回恢复函数。
   *
   * 恢复函数会**恢复之前的焦点**，所以 `<Dialog>` 关掉之后 Tab 会回到原来
   * 那个输入框，而不是从头开始。
   */
  trap(node: Node): () => void;
}

const FocusContext = createContext<FocusScope | null>(null);

/**
 * 在视图树外层提供焦点作用域。
 *
 * `children` 必须是 **getter**：Solid 的 provider 会在自己的 root 里延迟读取
 * `props.children`，只有到那时上下文才装好。直接传值会让子树在上下文生效前
 * 就创建完，`useFocus()` 全部拿到 null。
 */
export function provideFocusScope(scope: FocusScope, children: () => unknown): unknown {
  return FocusContext({
    value: scope,
    get children() {
      return children() as never;
    },
  });
}

/**
 * `const isFocused = useFocus(); isFocused(node())`
 *
 * 在运行时之外（没有 provider）调用是安全的：永远返回 false，组件退化成
 * 「不显示焦点态」，而不是抛异常。
 */
export function useFocus(): (node: Node | undefined) => boolean {
  const scope = useContext(FocusContext);
  if (!scope) return () => false;
  return (node: Node | undefined) => node !== undefined && node.id === scope.focusedId();
}

/** 需要直接读焦点 id 的场景（比如自己实现列表导航） */
export function useFocusScope(): FocusScope | null {
  return useContext(FocusContext);
}
