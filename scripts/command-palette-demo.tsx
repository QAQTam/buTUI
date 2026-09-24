import { CommandPalette } from "@butui/components";
import { CommandRegistry } from "@butui/keymap";
import { createTuiApp } from "@butui/runtime";
import { createSignal } from "solid-js";

const [open, setOpen] = createSignal(false);
const [message, setMessage] = createSignal("按 Ctrl+K 打开命令面板");
const registry = new CommandRegistry();

registry.register({
  id: "demo.save",
  title: "保存文件",
  description: "演示命令：保存当前文件",
  run: () => {
    setMessage("已执行：保存文件");
  },
});
registry.register({
  id: "demo.close",
  title: "关闭窗口",
  description: "演示命令：关闭当前窗口",
  run: () => {
    setMessage("已执行：关闭窗口");
  },
});
registry.register({
  id: "demo.theme",
  title: "切换主题",
  description: "演示命令：切换明暗主题",
  run: () => {
    setMessage("已执行：切换主题");
  },
});

createTuiApp({
  onKey: event => {
    if (event.name === "k" && event.modifiers.ctrl) {
      setOpen(true);
      return true;
    }
    return false;
  },
  view: () => (
    <>
      <box padding={1} gap={1}>
        <text bold color="accent">
          buTUI command palette demo
        </text>
        <text>{message()}</text>
        <text color="muted">Ctrl+K: 打开 · Esc: 关闭</text>
      </box>
      <CommandPalette
        registry={registry}
        open={open()}
        onDismiss={() => setOpen(false)}
        shortcut={command =>
          command.id === "demo.save" ? "ctrl+s" : undefined
        }
      />
    </>
  ),
});
