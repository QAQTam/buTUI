import { createElement, insert, spread } from "@butui/solid";
import type { JSX } from "@butui/solid/jsx-runtime";
import { createMemo } from "solid-js";

export type DynamicComponent =
  | ((props: any) => unknown)
  | string
  | undefined;

export interface DynamicProps {
  component: DynamicComponent;
  [key: string]: unknown;
}

/**
 * 根据 `component` 动态渲染函数组件或 intrinsic tag。
 *
 * `component` 与其余 props 都是响应式的；切换类型时会重新创建目标节点。
 */
export function createDynamic(
  component: () => DynamicComponent,
  props: Record<string, unknown>
): JSX.Element {
  const selected = createMemo(component);
  return createMemo(() => {
    const target = selected();
    if (typeof target === "function") {
      return target(props) as JSX.Element;
    }
    if (typeof target === "string") {
      const node = createElement(target);
      spread(node, without(props, "children"));
      insert(node, () => props.children);
      return node as unknown as JSX.Element;
    }
    return null as unknown as JSX.Element;
  }) as unknown as JSX.Element;
}

export function Dynamic(props: DynamicProps): JSX.Element {
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (key === "component") continue;
    Object.defineProperty(rest, key, {
      enumerable: true,
      get: () => props[key],
    });
  }
  return createDynamic(() => props.component, rest);
}

function without(
  props: Record<string, unknown>,
  omitted: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (key === omitted) continue;
    Object.defineProperty(result, key, {
      enumerable: true,
      get: () => props[key],
    });
  }
  return result;
}
