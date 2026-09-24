/**
 * `<CommandPalette>` —— 命令注册表的搜索 / 执行 UI。
 *
 * 组件只组合已有模型：`TextEditor` 管查询，`createSelection` 管上下选择，
 * `filterCommands()` 管评分排序，`CommandRegistry` 管执行。命令面板不自己
 * 维护第二份命令表，插件 / keymap / 鼠标调用看到的始终是同一份命令。
 */
import type { KeyEvent } from "@butui/core";
import type { Command, CommandRegistry } from "@butui/keymap";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { filterCommands } from "./command-palette.ts";
import { createTextEditor } from "./editor.ts";
import { Input } from "./input.tsx";
import { List } from "./list.tsx";
import { Modal } from "./modal.tsx";
import { createSelection } from "./selection.ts";

export interface CommandPaletteProps {
  registry: CommandRegistry;
  open: boolean;
  onDismiss: () => void;
  /** 执行命令前 / 后回调；用于 telemetry 或替换执行策略。 */
  onSelect?: (command: Command, query: string) => void;
  title?: string;
  placeholder?: string;
  /** 对话框宽度（cell），默认 60 */
  width?: number;
  /** 列表可见高度，默认 8 */
  height?: number;
  /** 最多展示多少条结果 */
  limit?: number;
  empty?: JSX.Element;
  /** 查询为空时是否显示所有命令，默认 true */
  showAll?: boolean;
  /** 右侧显示快捷键；不提供则不画 */
  shortcut?: (command: Command) => string | undefined;
  semantic?: string;
}

export function CommandPalette(props: CommandPaletteProps) {
  const editor = createTextEditor({ multiline: false });
  const [rev, bumpRev] = createSignal(0);
  onCleanup(props.registry.subscribe(() => bumpRev(value => value + 1)));

  const commands = (): readonly Command[] => (rev(), props.registry.list());
  const results = (): Command[] =>
    filterCommands(commands(), editor.value(), {
      ...(props.limit !== undefined ? { limit: props.limit } : {}),
      includeDisabled: false,
    }).filter(command => props.showAll !== false || editor.value().trim() !== "");
  const selection = createSelection({
    count: () => results().length,
  });
  const selected = (): Command | undefined => results()[selection.index()];

  createEffect(
    () => editor.value(),
    () => selection.setIndex(0)
  );

  createEffect(
    () => props.open,
    open => {
      if (!open) return;
      editor.clear();
      selection.setIndex(0);
    }
  );

  const activate = (command = selected()): void => {
    if (!command) return;
    const query = editor.value();
    props.onDismiss();
    props.onSelect?.(command, query);
    props.registry.execute(command.id, {
      source: "command-palette",
      args: query,
    });
  };

  const handleKey = (event: KeyEvent): boolean => {
    if (event.name === "escape") {
      event.preventDefault();
      props.onDismiss();
      return true;
    }
    if (event.name === "enter") {
      event.preventDefault();
      activate();
      return true;
    }
    if (selection.handleKey(event)) {
      event.preventDefault();
      return true;
    }
    return false;
  };

  const width = (): number => Math.max(20, Math.floor(props.width ?? 60));
  const listHeight = (): number => Math.max(1, Math.floor(props.height ?? 8));

  return (
    <Modal
      open={props.open}
      title={props.title ?? "命令面板"}
      width={width()}
      autoFocus={false}
      onDismiss={props.onDismiss}
      semantic={props.semantic ?? "command-palette"}
    >
      <Input
        editor={editor}
        width={Math.max(1, width() - 4)}
        placeholder={props.placeholder ?? "输入命令…"}
        autoFocus
        onKey={handleKey}
      />
      <text color="muted">
        {results().length === 0 ? "没有匹配命令" : `${results().length} 条命令`}
      </text>
      <List
        items={results()}
        selection={selection}
        height={listHeight()}
        activateOnClick
        semantic="command-palette:list"
        empty={props.empty ?? <text color="muted">没有匹配命令</text>}
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
        onActivate={command => activate(command)}
      />
    </Modal>
  );
}
