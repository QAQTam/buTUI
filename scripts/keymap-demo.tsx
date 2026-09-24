import { createKeymap } from "@butui/keymap";
import { createTuiApp } from "@butui/runtime";
import { For, createSignal } from "solid-js";

const [message, setMessage] = createSignal(
  "F1 帮助 · Ctrl+O 作用域 · Ctrl+K Ctrl+P 多键 chord"
);
const [showHelp, setShowHelp] = createSignal(false);
const [helpVersion, setHelpVersion] = createSignal(0);
const keymap = createKeymap();
let popDialog: (() => void) | undefined;

keymap.subscribe(() => setHelpVersion(current => current + 1));

keymap.bindCommand(
  {
    id: "help.toggle",
    title: "切换帮助",
    description: "显示 / 隐藏快捷键列表",
    run: () => {
      setShowHelp(current => !current);
    },
  },
  "f1"
);

keymap.bindCommand(
  {
    id: "chord.demo",
    title: "多键 chord",
    description: "Ctrl+K 之后按 Ctrl+P",
    run: () => {
      setMessage("多键 chord 已触发");
    },
  },
  "ctrl+k ctrl+p"
);

keymap.bindCommand(
  {
    id: "dialog.open",
    title: "打开对话框",
    run: () => {
      popDialog ??= keymap.pushScope("dialog");
      setMessage("dialog scope 已启用：现在 Esc 会关闭");
    },
  },
  "ctrl+o"
);

keymap.bindCommand(
  {
    id: "dialog.close",
    title: "关闭对话框",
    run: () => {
      popDialog?.();
      popDialog = undefined;
      setMessage("dialog scope 已关闭");
    },
  },
  "escape",
  { scope: "dialog", priority: 100 }
);

createTuiApp({
  keymap,
  view: () => (
    <box border padding={1} gap={1}>
      <text bold color="accent">
        buTUI keymap demo
      </text>
      <text>{message()}</text>
      <For each={showHelp() ? [helpVersion(), ...keymap.help()] : []}>
        {entry =>
          typeof entry === "number" ? (
            <text color="muted">快捷键：</text>
          ) : (
            <text>
              {`${entry.sequence.padEnd(16)} ${entry.title ?? entry.command}`}
            </text>
          )
        }
      </For>
    </box>
  ),
});
