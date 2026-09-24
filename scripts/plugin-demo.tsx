import path from "node:path";
import { loadPlugins, readPluginConfig } from "@butui/plugins/loader";
import { createSlot, createSolidSlotRegistry } from "@butui/plugins/solid";
import { createTuiApp } from "@butui/runtime";

interface Slots {
  header: { title: string };
  footer: { hint: string };
}

const context = { theme: "dark" };
const host = {};
const registry = createSolidSlotRegistry<Slots, typeof context>(host, context);
const configPath = path.resolve("scripts/plugins/butui.config.json");
const config = await readPluginConfig(configPath);
const loaded = await loadPlugins<unknown, Slots, typeof context>({
  registry,
  host,
  context,
  entries: config,
  cwd: path.dirname(configPath),
  allowedCapabilities: ["slots"],
});

const Header = createSlot(registry);
const Footer = createSlot(registry);

createTuiApp({
  view: () => (
    <box border padding={1} gap={1}>
      <Header name="header" title="buTUI plugin demo" />
      <text>应用壳只声明 Slot；插件由 butui.config.json 加载。</text>
      <Footer name="footer" hint="Ctrl+C 退出" />
    </box>
  ),
  onQuit: () => loaded.dispose(),
});
