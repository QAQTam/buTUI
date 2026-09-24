import type { KeyEvent } from "@butui/core";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show, createEffect } from "solid-js";
import { filterAutocompleteOptions } from "./autocomplete.ts";
import { createTextEditor } from "./editor.ts";
import { Input } from "./input.tsx";
import { List } from "./list.tsx";
import type { SelectOption } from "./select.tsx";
import { createSelection } from "./selection.ts";

export interface AutocompleteProps<T> {
  options: readonly SelectOption<T>[];
  query?: string;
  onQueryChange?: (query: string) => void;
  onSelect?: (value: T, option: SelectOption<T>) => void;
  placeholder?: string;
  width?: number;
  height?: number;
  autoFocus?: boolean;
  /** false 时即使 query 为空也展示全部可选结果；默认 true。 */
  showAll?: boolean;
  empty?: JSX.Element;
  semantic?: string;
}

export function Autocomplete<T>(props: AutocompleteProps<T>) {
  const editor = createTextEditor({
    value: props.query ?? "",
    multiline: false,
    clearOnSubmit: false,
    onChange: query => props.onQueryChange?.(query),
  });
  const results = (): readonly SelectOption<T>[] => {
    const query = editor.value();
    if (!query.trim() && props.showAll === false) return [];
    return filterAutocompleteOptions(props.options ?? [], query);
  };
  const selection = createSelection({
    count: () => results().length,
    isSelectable: index => !results()[index]?.disabled,
  });

  createEffect(
    () => editor.value(),
    () => selection.setIndex(0)
  );
  createEffect(
    () => props.query,
    query => {
      if (query !== undefined && query !== editor.value()) editor.setValue(query);
    }
  );

  const commit = (option = results()[selection.index()]): void => {
    if (!option || option.disabled) return;
    editor.setValue(option.label);
    props.onSelect?.(option.value, option);
  };

  const onKey = (event: KeyEvent): boolean => {
    if (event.name === "escape") {
      event.preventDefault();
      editor.clear();
      return true;
    }
    if (event.name === "enter") {
      event.preventDefault();
      commit();
      return true;
    }
    if (selection.handleKey(event)) {
      event.preventDefault();
      return true;
    }
    return false;
  };

  return (
    <box gap={1} semantic={props.semantic ?? "autocomplete"}>
      <Input
        editor={editor}
        width={props.width}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        semantic={`${props.semantic ?? "autocomplete"}:input`}
        onKey={onKey}
      />
      <Show when={results().length > 0}>
        <List
          items={results()}
          selection={selection}
          height={props.height ?? 5}
          activateOnClick
          semantic={`${props.semantic ?? "autocomplete"}:list`}
          itemSemantic={option => `autocomplete:${String(option.value)}`}
          onActivate={option => commit(option)}
          renderItem={(option, _index, state) => (
            <row gap={1}>
              <text color={state.selected() ? "focus" : "fg"}>
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
      </Show>
      <Show when={results().length === 0 && props.empty}>
        <box>{props.empty}</box>
      </Show>
    </box>
  );
}
