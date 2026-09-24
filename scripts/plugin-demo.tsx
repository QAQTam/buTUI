import { createSlot, createSolidSlotRegistry } from "@butui/plugins/solid";
import { createTuiApp } from "@butui/runtime";

interface Slots {
  header: { title: string };
  footer: { hint: string };
}

const context = { theme: "dark" };
const host = {};
const registry = createSolidSlotRegistry<Slots, typeof context>(host, context);

registry.register({
  id: "demo.header",
  order: 0,
  slots: {
    header: (ctx, props) => (
      <text bold color="accent">
        {`${props.title} · ${ctx.theme}`}
      </text>
    ),
  },
});

registry.register({
  id: "demo.footer",
  order: 0,
  slots: {
    footer: (_ctx, props) => <text color="muted">{props.hint}</text>,
  },
});

const Header = createSlot(registry);
const Footer = createSlot(registry);

createTuiApp({
  view: () => (
    <box border padding={1} gap={1}>
      <Header name="header" title="buTUI plugin demo" />
      <text>应用壳只声明 Slot；header/footer 都由插件贡献。</text>
      <Footer name="footer" hint="Ctrl+C 退出" />
    </box>
  ),
});
