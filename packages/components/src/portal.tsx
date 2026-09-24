import { createSentinel, removeNode, type Node } from "@butui/core";
import {
  createElement,
  insert,
  insertNode,
  useRootNode,
} from "@butui/solid";
import type { JSX } from "@butui/solid/jsx-runtime";
import {
  createEffect,
  createMemo,
  getOwner,
  runWithOwner,
} from "solid-js";

export interface PortalProps {
  /** 目标挂载节点；不传时使用当前 app root。 */
  mount?: Node;
  children: JSX.Element;
}

/**
 * 把 children 渲染到另一个节点树位置。
 *
 * 原位置只保留零宽 sentinel，因此 Portal 不会影响当前布局；mount 变化或组件
 * 卸载时会自动移除容器。典型用途是 overlay / tooltip / toast 的显式挂载点。
 */
export function Portal(props: PortalProps): Node {
  const rootNode = useRootNode();
  const owner = getOwner();
  const marker = createSentinel();
  let content: (() => unknown) | undefined;

  createEffect(
    () => props.mount ?? rootNode(),
    mount => {
      if (!mount) return;
      content ||= runWithOwner(owner, () =>
        createMemo(() => props.children)
      );
      const container = createElement("box", { semantic: "portal" });
      insert(container, content);
      insertNode(mount, container);
      return () => removeNode(mount, container);
    }
  );

  return marker;
}
