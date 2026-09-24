import { Shimmer } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { createSignal } from "solid-js";

const [active, setActive] = createSignal(true);

createTuiApp({
  onKey: event => {
    if (event.name !== " ") return false;
    setActive(value => !value);
    return true;
  },
  view: () => (
    <box padding={1} gap={1}>
      <text bold color="accent">
        buTUI shimmer demo
      </text>
      <Shimmer text="thinking..." active={active()} />
      <Shimmer
        text="逐字高亮只改变颜色，不改变宽度"
        active={active()}
        granularity="cell"
        highlightWidth={4}
      />
      <text color="muted">Space: 暂停 / 恢复 · Ctrl+C: 退出</text>
    </box>
  ),
});
