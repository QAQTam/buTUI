/**
 * `<Select>` / `<Tabs>` —— SPEC §10.1 的选择类组件。
 *
 * 两者都是「选项集合 + 一个当前值」：
 *
 *   `<Select>` 竖着列，↑↓ 移动、Enter 确认 —— 适合菜单 / 命令列表 / 历史抽屉
 *   `<Tabs>`   横着排，←→ 移动**立即生效** —— 适合模式切换 / 分段控件
 *
 * 都是**受控**的：值由应用持有（`value` + `onChange`）。组件内部只维护「高亮
 * 在第几项」这一个瞬态，而且会在 `value` 变化时同步过来 —— 于是外部改值
 * （快捷键、命令、回放）和键盘操作走的是同一条路。
 */
import type { KeyEvent, MouseEvent, Node } from "@butui/core";
import { useFocus, useFocusScope } from "@butui/solid";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show, createEffect, createSignal } from "solid-js";
import { List } from "./list.tsx";
import { type Tone, toneColor } from "./modal.tsx";
import { createSelection } from "./selection.ts";

export interface SelectOption<T> {
  value: T;
  label: string;
  /** 右侧的灰色说明 */
  description?: string;
  disabled?: boolean;
  /** 分组标题：照常显示，但不可选、不参与键盘导航 */
  heading?: boolean;
}

export interface SelectProps<T> {
  options: readonly SelectOption<T>[];
  value?: T;
  /** Enter / 点击选中一项时触发 */
  onChange?: (value: T, option: SelectOption<T>) => void;
  /** 视口高度；不给就不裁剪 */
  height?: number;
  autoFocus?: boolean;
  marker?: string;
  empty?: JSX.Element;
  semantic?: string;
}

export function Select<T>(props: SelectProps<T>) {
  const options = (): readonly SelectOption<T>[] => props.options ?? [];
  const valueIndex = (): number => {
    const at = options().findIndex(option => option.value === props.value);
    return at < 0 ? 0 : at;
  };
  const selection = createSelection({
    count: () => options().length,
    index: valueIndex(),
    // 分组标题和 disabled 项跳过，但仍然显示
    isSelectable: i => {
      const option = options()[i];
      return option !== undefined && option.heading !== true && option.disabled !== true;
    },
  });

  // 外部改 value（快捷键 / 命令 / 回放）→ 高亮跟过去
  createEffect(
    () => props.value,
    () => selection.setIndex(valueIndex())
  );

  const commit = (index: number): void => {
    const option = options()[index];
    if (!option || option.heading || option.disabled) return;
    props.onChange?.(option.value, option);
  };

  return (
    <List
      items={options()}
      selection={selection}
      height={props.height}
      autoFocus={props.autoFocus}
      marker={props.marker}
      empty={props.empty}
      semantic={props.semantic ?? "select"}
      activateOnClick
      itemSemantic={option => `option:${String(option.value)}`}
      onActivate={(_option, index) => commit(index)}
      renderItem={(option, _index, _state) => (
        <row gap={1}>
          <text
            color={option.heading ? "muted" : "fg"}
            bold={option.heading}
            dim={option.disabled}
          >
            {option.label}
          </text>
          <Show when={option.description}>
            <text color="muted" dim>
              {option.description}
            </text>
          </Show>
        </row>
      )}
    />
  );
}

export interface TabItem<T> {
  value: T;
  label: string;
  disabled?: boolean;
  /** 右上角的小标记（数量、脏标记…） */
  badge?: string;
}

export interface TabsProps<T> {
  items: readonly TabItem<T>[];
  value?: T;
  /** ←→ 移动时**立即**触发（分段控件语义） */
  onChange?: (value: T, item: TabItem<T>) => void;
  autoFocus?: boolean;
  /** 选中态颜色，默认 accent */
  tone?: Tone;
  gap?: number;
  semantic?: string;
}

/** 横向分段控件。←→ / Home / End 直接切值，不要求再按 Enter */
export function Tabs<T>(props: TabsProps<T>) {
  const scope = useFocusScope();
  const isFocused = useFocus();
  const [node, setNode] = createSignal<Node>();
  const items = (): readonly TabItem<T>[] => props.items ?? [];
  const focused = (): boolean => isFocused(node());

  const activeIndex = (): number => items().findIndex(item => item.value === props.value);

  const commitAt = (index: number): void => {
    const item = items()[index];
    if (!item || item.disabled || item.value === props.value) return;
    props.onChange?.(item.value, item);
  };

  /** 从 index 出发找下一个可用项（跳过 disabled） */
  const seek = (from: number, step: 1 | -1): number => {
    const list = items();
    let cursor = from;
    for (let i = 0; i < list.length; i++) {
      cursor = (cursor + step + list.length) % list.length;
      if (!list[cursor]?.disabled) return cursor;
    }
    return from;
  };

  const move = (step: 1 | -1): void => {
    const from = activeIndex();
    if (from < 0) return;
    commitAt(seek(from, step));
  };

  createEffect(
    () => ({ node: node(), auto: props.autoFocus }),
    ({ node: current, auto }) => {
      if (auto && current) scope?.focus(current);
    }
  );

  return (
    <row
      ref={setNode}
      focusable
      gap={props.gap ?? 2}
      semantic={props.semantic ?? "tabs"}
      onKey={(event: KeyEvent) => {
        const { name, modifiers } = event;
        if (modifiers.ctrl || modifiers.alt || modifiers.meta) return;
        if (name === "left") move(-1);
        else if (name === "right") move(1);
        else if (name === "home") commitAt(0);
        else if (name === "end") commitAt(items().length - 1);
      }}
    >
      {items().map((item, index) => {
        const active = (): boolean => item.value === props.value;
        const color = (): string => {
          if (item.disabled) return "muted";
          return active() ? toneColor(props.tone ?? "accent") : focused() ? "fg" : "muted";
        };
        return (
          <text
            color={color()}
            bold={active()}
            dim={item.disabled}
            underline={active() && focused()}
            semantic={`tab:${String(item.value)}`}
            onClick={(_event: MouseEvent) => commitAt(index)}
          >
            {item.label}
            <Show when={item.badge}>
              <text color="muted">{` ${item.badge}`}</text>
            </Show>
          </text>
        );
      })}
    </row>
  );
}
