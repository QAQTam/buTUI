import type { KeyEvent } from "@butui/core";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show } from "solid-js";
import { List } from "./list.tsx";
import {
  createMultiSelect,
  type MultiSelectModel,
} from "./multi-select.ts";
import type { SelectOption } from "./select.tsx";
import { createSelection } from "./selection.ts";

export interface MultiSelectProps<T> {
  options: readonly SelectOption<T>[];
  values?: readonly T[];
  onChange?: (
    values: readonly T[],
    option?: SelectOption<T>
  ) => void;
  height?: number;
  autoFocus?: boolean;
  marker?: string;
  empty?: JSX.Element;
  semantic?: string;
}

/**
 * 多选列表。
 *
 * 受控 values；Space / Enter / 点击切换当前项，Ctrl+A 全选，
 * Ctrl+Shift+A 清空。heading / disabled 只展示，不参与切换与导航。
 */
export function MultiSelect<T>(props: MultiSelectProps<T>) {
  const options = (): readonly SelectOption<T>[] => props.options ?? [];
  const model: MultiSelectModel<T> = createMultiSelect({
    options,
    values: () => props.values ?? [],
    onChange: (values, option) => props.onChange?.(values, option),
  });
  const selection = createSelection({
    count: () => options().length,
    isSelectable: index => {
      const option = options()[index];
      return (
        option !== undefined &&
        option.heading !== true &&
        option.disabled !== true
      );
    },
  });

  const handleKey = (event: KeyEvent): boolean => {
    if (event.modifiers.ctrl && event.name === "a") {
      event.preventDefault();
      if (event.modifiers.shift) model.clear();
      else model.selectAll();
      return true;
    }
    if (event.name === " " || event.name === "enter") {
      const option = options()[selection.index()];
      if (option) {
        event.preventDefault();
        model.toggle(option.value);
      }
      return true;
    }
    if (selection.handleKey(event)) {
      event.preventDefault();
      return true;
    }
    return false;
  };

  return (
    <List
      items={options()}
      selection={selection}
      height={props.height}
      autoFocus={props.autoFocus}
      marker={props.marker}
      empty={props.empty}
      semantic={props.semantic ?? "multi-select"}
      activateOnClick
      itemSemantic={option => `option:${String(option.value)}`}
      onKey={handleKey}
      onActivate={(option, index) => {
        if (index >= 0) model.toggle(option.value);
      }}
      renderItem={(option, _index, state) => (
        <row gap={1}>
          <text
            color={option.disabled ? "muted" : state.selected() ? "focus" : "fg"}
            bold={option.heading}
            dim={option.disabled}
          >
            {option.heading
              ? option.label
              : `[${model.selected(option.value) ? "x" : " "}] ${option.label}`}
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
