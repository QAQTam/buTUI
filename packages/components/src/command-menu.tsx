import type { KeyEvent } from "@butui/core";
import type { Command, CommandRegistry } from "@butui/keymap";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { filterCommands } from "./command-palette.ts";
import { createTextEditor } from "./editor.ts";
import { Input } from "./input.tsx";
import { List } from "./list.tsx";
import { createSelection } from "./selection.ts";

export interface CommandMenuProps {
  registry: CommandRegistry;
  query?: string;
  onQueryChange?: (query: string) => void;
  onExecute?: (command: Command, query: string) => void;
  placeholder?: string;
  width?: number;
  height?: number;
  limit?: number;
  autoFocus?: boolean;
  showAll?: boolean;
  empty?: JSX.Element;
  shortcut?: (command: Command) => string | undefined;
  semantic?: string;
}

/**
 * 非模态命令菜单。
 *
 * 直接消费 CommandRegistry；和 CommandPalette 使用同一套 filter / execute
 * 语义，但不创建 Modal / focus trap，适合嵌在页面、Popover 或插件面板里。
 */
export function CommandMenu(props: CommandMenuProps) {
  const editor = createTextEditor({
    value: props.query ?? "",
    multiline: false,
    clearOnSubmit: false,
    onChange: query => props.onQueryChange?.(query),
  });
  const [rev, bumpRev] = createSignal(0);
  onCleanup(props.registry.subscribe(() => bumpRev(value => value + 1)));

  const commands = (): readonly Command[] => (rev(), props.registry.list());
  const results = (): Command[] =>
    filterCommands(commands(), editor.value(), {
      ...(props.limit !== undefined ? { limit: props.limit } : {}),
      includeDisabled: false,
    }).filter(
      command =>
        props.showAll !== false || editor.value().trim() !== ""
    );
  const selection = createSelection({ count: () => results().length });
  const selected = (): Command | undefined => results()[selection.index()];

  createEffect(
    () => (editor.value(), rev()),
    () => selection.setIndex(0)
  );
  createEffect(
    () => props.query,
    query => {
      if (query !== undefined && query !== editor.value()) editor.setValue(query);
    }
  );

  const execute = (command = selected()): void => {
    if (!command) return;
    props.onExecute?.(command, editor.value());
    props.registry.execute(command.id, {
      source: "command-menu",
      args: editor.value(),
    });
  };

  const onKey = (event: KeyEvent): boolean => {
    if (event.name === "escape") {
      event.preventDefault();
      editor.clear();
      return true;
    }
    if (event.name === "enter") {
      event.preventDefault();
      execute();
      return true;
    }
    if (selection.handleKey(event)) {
      event.preventDefault();
      return true;
    }
    return false;
  };

  return (
    <box gap={1} semantic={props.semantic ?? "command-menu"}>
      <Input
        editor={editor}
        width={props.width}
        placeholder={props.placeholder ?? "搜索命令…"}
        autoFocus={props.autoFocus}
        semantic={`${props.semantic ?? "command-menu"}:input`}
        onKey={onKey}
      />
      <Show when={results().length > 0}>
        <List
          items={results()}
          selection={selection}
          height={props.height ?? 8}
          activateOnClick
          semantic={`${props.semantic ?? "command-menu"}:list`}
          itemSemantic={command => `command:${command.id}`}
          onActivate={command => execute(command)}
          renderItem={(command, _index, state) => (
            <row gap={1} width="100%">
              <text color={state.selected() ? "focus" : "fg"} bold={state.selected()}>
                {command.title ?? command.id}
              </text>
              <Show when={command.description}>
                <text color="muted" truncate>
                  {command.description}
                </text>
              </Show>
              <Show when={props.shortcut?.(command)}>
                {shortcut => <text color="muted">{shortcut()}</text>}
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
