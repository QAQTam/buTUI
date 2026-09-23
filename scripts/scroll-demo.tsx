/**
 * 滚动视口 demo —— 聊天式转录的正确行为。
 *
 *   bun --conditions=browser run scripts/scroll-demo.tsx
 *
 * 每 200ms 追加一行。`↑↓` / `PageUp` / `PageDown` / 滚轮往回翻，
 * `End` 回到最新，`q` / `Ctrl+C` 退出。
 *
 * 看点是状态栏：
 *   - 贴底时新内容**自动跟着走**（follow 是 "bottom"，不需要任何通知）
 *   - 往上翻之后新内容**不会把视口拽回去**（停在同一行号）
 *   - 自己滚回底部 → 自动恢复跟随
 */
import { createScrollView } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { createSignal } from "solid-js";

const view = createScrollView();
const [lines, setLines] = createSignal<string[]>(["会话开始"]);

let n = 0;
const timer = setInterval(() => {
  n += 1;
  const tail = n % 7 === 0 ? "（这条长一点，用来看看折行）" : "";
  setLines([...lines(), `chunk ${n} · ${"·".repeat(n % 20)}${tail}`]);
}, 200);

const app = createTuiApp({
  view: () => (
    <box>
      {/* 转录本体：只增不减，超出屏幕时由 runtime 的 scroll 选项决定窗口 */}
      {lines().map(line => (
        <text>{line}</text>
      ))}
      {/* 最后一行 = 固定状态栏（stickyBottom: 1），往回翻也不会滚走 */}
      <row gap={2}>
        <text color={view.following() ? "success" : "warning"}>
          {view.following() ? "● 跟随中" : `○ 已滚回 ${view.top()}/${view.maxTop()}`}
        </text>
        <text color="muted" truncate>↑↓ PageUp/PageDown 往回翻，End 回到最新，q 退出</text>
      </row>
    </box>
  ),
  scroll: view,
  stickyBottom: 1,
  afterDraw: frame => view.measure(frame),
  onKey: event => {
    if (event.name === "q" || event.name === "escape") {
      app.dispose();
      return true;
    }
    return view.handleKey(event);
  },
  onMouse: event => view.handleWheel(event),
  onQuit: () => clearInterval(timer),
});

app.start();
