/**
 * 列表 / 虚拟列表 demo。
 *
 *   bun --conditions=browser run scripts/list-demo.tsx
 *
 * 10 万条数据、视口只放得下十几行。`↑↓` `Home` `End` `PageUp/PageDown`
 * `Ctrl+P/N` 移动，滚轮移动选中项，`q` / `Ctrl+C` 退出。
 *
 * 状态栏里那行是重点：**节点数恒等于视口行数**，跟总条数没关系 ——
 * 所以 10 万条和 10 条的渲染成本一样。
 */
import { VirtualList, createSelection } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { createSignal } from "solid-js";

const TOTAL = 100_000;
const items = Array.from({ length: TOTAL }, (_, i) => `第 ${i} 行 · ${"x".repeat(i % 12)}`);

const [version, bump] = createSignal(0);
const selection = createSelection({
  count: TOTAL,
  onChange: () => bump(n => n + 1),
});

const app = createTuiApp({
  view: runtime => {
    const rows = runtime.size().rows;
    // 上下各留 1 行给标题和状态栏
    const listHeight = Math.max(1, rows - 2);
    return (
      <box>
        <row gap={1}>
          <text color="accent" bold>
            buTUI list
          </text>
          <text color="muted">{TOTAL.toLocaleString()} 条</text>
        </row>
        <VirtualList
          items={items}
          selection={selection}
          height={listHeight}
          autoFocus
          selectedBg="accent"
          selectedColor="bg"
          renderItem={item => <text>{item}</text>}
        />
        <row gap={2}>
          <text color="muted">
            {selection.index() + 1}/{TOTAL}
          </text>
          <text color="success">
            节点数 = 视口行数（v{version()}，这里只是让状态栏跟着刷新）
          </text>
        </row>
      </box>
    );
  },
  onKey: event => {
    if (event.name === "q" || event.name === "escape") {
      app.dispose();
      return true;
    }
    return false;
  },
});

app.start();
