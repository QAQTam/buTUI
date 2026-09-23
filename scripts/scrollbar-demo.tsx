/**
 * ScrollBar 手工观察：拖 thumb、点轨道、滚轮。
 *
 *   bun --conditions=browser run scripts/scrollbar-demo.tsx
 */
import { ScrollBar, createScrollBar } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { For, createSignal } from "solid-js";

const HEIGHT = 18;
const lines = Array.from({ length: 240 }, (_, i) =>
  `${String(i + 1).padStart(3, " ")}  line ${i + 1} · drag the right edge`
);
const [top, setTop] = createSignal(0);

const clamp = (value: number): number =>
  Math.max(0, Math.min(Math.floor(value), Math.max(0, lines.length - HEIGHT)));

const bar = createScrollBar({
  top,
  total: () => lines.length,
  viewport: () => HEIGHT,
  track: () => HEIGHT,
  onScroll: value => setTop(clamp(value)),
});

const app = createTuiApp({
  view: () => (
    <box
      border="round"
      borderColor="accent"
      padding={1}
      gap={0}
      focusable
      onWheel={event => {
        if (event.wheel === "up") setTop(value => clamp(value - 1));
        if (event.wheel === "down") setTop(value => clamp(value + 1));
      }}
      onKey={event => {
        if (event.name === "up") setTop(value => clamp(value - 1));
        else if (event.name === "down") setTop(value => clamp(value + 1));
        else if (event.name === "pageup") setTop(value => clamp(value - HEIGHT));
        else if (event.name === "pagedown") setTop(value => clamp(value + HEIGHT));
        else if (event.name === "home") setTop(0);
        else if (event.name === "end") setTop(clamp(lines.length));
      }}
    >
      <row height={HEIGHT}>
        <box flexGrow={1} height={HEIGHT} overflow="hidden">
          <For each={lines.slice(top(), top() + HEIGHT)}>
            {line => <text color="fg">{line}</text>}
          </For>
        </box>
        <ScrollBar model={bar} />
      </row>
      <text color="muted">拖 thumb / 点轨道 / 滚轮 · Ctrl+C 退出</text>
    </box>
  ),
  onQuit: () => app.dispose(),
});
