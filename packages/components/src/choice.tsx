import type { KeyEvent } from "@butui/core";
import type { Node } from "@butui/core";
import { useFocus, useFocusScope } from "@butui/solid";
import { For, Show, createEffect, createSignal } from "solid-js";
import type { SelectOption } from "./select.tsx";

export interface CheckboxProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  semantic?: string;
}

export function Checkbox(props: CheckboxProps) {
  const scope = useFocusScope();
  const isFocused = useFocus();
  const [node, setNode] = createSignal<Node>();
  const focused = (): boolean => isFocused(node());

  createEffect(
    () => ({ node: node(), auto: props.autoFocus }),
    ({ node: current, auto }) => {
      if (auto && current) scope?.focus(current);
    }
  );

  const toggle = (): void => {
    if (props.disabled) return;
    props.onChange?.(!props.checked);
  };

  return (
    <row
      ref={setNode}
      gap={1}
      focusable={!props.disabled}
      disabled={props.disabled}
      semantic={props.semantic ?? "checkbox"}
      color={props.disabled ? "muted" : focused() ? "focus" : "fg"}
      onKey={(event: KeyEvent) => {
        if (event.name === " " || event.name === "enter") {
          event.preventDefault();
          toggle();
        }
      }}
      onClick={toggle}
    >
      <text>{props.checked ? "[x]" : "[ ]"}</text>
      <Show when={props.label}>
        <text bold={focused()} dim={props.disabled}>
          {props.label}
        </text>
      </Show>
      <Show when={props.description}>
        <text color="muted" dim>
          {props.description}
        </text>
      </Show>
    </row>
  );
}

export type RadioOrientation = "vertical" | "horizontal";

export interface RadioGroupProps<T> {
  options: readonly SelectOption<T>[];
  value?: T;
  onChange?: (value: T, option: SelectOption<T>) => void;
  orientation?: RadioOrientation;
  gap?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  semantic?: string;
}

export function RadioGroup<T>(props: RadioGroupProps<T>) {
  const scope = useFocusScope();
  const isFocused = useFocus();
  const [node, setNode] = createSignal<Node>();
  const options = (): readonly SelectOption<T>[] => props.options ?? [];
  const orientation = (): RadioOrientation => props.orientation ?? "vertical";
  const activeIndex = (): number =>
    options().findIndex(option => option.value === props.value);

  createEffect(
    () => ({ node: node(), auto: props.autoFocus }),
    ({ node: current, auto }) => {
      if (auto && current) scope?.focus(current);
    }
  );

  const seek = (from: number, step: 1 | -1): number => {
    const list = options();
    if (list.length === 0) return -1;
    let cursor = from < 0 ? (step > 0 ? -1 : 0) : from;
    for (let index = 0; index < list.length; index++) {
      cursor = (cursor + step + list.length) % list.length;
      const option = list[cursor];
      if (option && !option.disabled && option.heading !== true) return cursor;
    }
    return from;
  };

  const commitAt = (index: number): void => {
    const option = options()[index];
    if (!option || option.disabled || option.heading) return;
    if (option.value !== props.value) props.onChange?.(option.value, option);
  };

  const onKey = (event: KeyEvent): void => {
    if (props.disabled) return;
    const previous = orientation() === "vertical" ? "up" : "left";
    const next = orientation() === "vertical" ? "down" : "right";
    if (event.name === previous) {
      event.preventDefault();
      commitAt(seek(activeIndex(), -1));
      return;
    }
    if (event.name === next) {
      event.preventDefault();
      commitAt(seek(activeIndex(), 1));
      return;
    }
    if (event.name === "home") {
      event.preventDefault();
      commitAt(seek(-1, 1));
      return;
    }
    if (event.name === "end") {
      event.preventDefault();
      commitAt(seek(-1, -1));
      return;
    }
    if (event.name === " " || event.name === "enter") {
      event.preventDefault();
      commitAt(activeIndex());
    }
  };

  const optionNode = (option: SelectOption<T>) => (
    <text
      semantic={`${props.semantic ?? "radio"}:${String(option.value)}`}
      color={
        option.disabled
          ? "muted"
          : option.value === props.value
            ? "focus"
            : "fg"
      }
      bold={option.value === props.value}
      dim={option.disabled}
      onClick={() => {
        const index = options().indexOf(option);
        commitAt(index);
      }}
    >
      {option.value === props.value ? "(•)" : "( )"} {option.label}
      {option.description ? ` ${option.description}` : ""}
    </text>
  );

  return (
    <Show
      when={orientation() === "horizontal"}
      fallback={
        <box
          ref={setNode}
          focusable={!props.disabled}
          disabled={props.disabled}
          gap={props.gap ?? 1}
          semantic={props.semantic ?? "radio"}
          onKey={onKey}
        >
          <For each={options()}>{optionNode}</For>
        </box>
      }
    >
      <row
        ref={setNode}
        focusable={!props.disabled}
        disabled={props.disabled}
        gap={props.gap ?? 2}
        semantic={props.semantic ?? "radio"}
        onKey={onKey}
      >
        <For each={options()}>{optionNode}</For>
      </row>
    </Show>
  );
}
