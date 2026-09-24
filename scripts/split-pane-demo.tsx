import { SplitPane, createSplitPane } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { createSignal } from "solid-js";

const [ratio, setRatio] = createSignal(0.5);
const model = createSplitPane({
  ratio,
  onChange: setRatio,
  minFirst: 8,
  minSecond: 8,
});

createTuiApp({
  view: () => (
    <SplitPane
      model={model}
      first={
        <box padding={1} gap={1}>
          <text bold color="accent">
            left pane
          </text>
          <text>拖动中间分隔条，移出窗口后仍会继续。</text>
          <text color="muted">方向键 / Home / End 可键盘调整。</text>
        </box>
      }
      second={
        <box padding={1} gap={1}>
          <text bold color="accent">
            right pane
          </text>
          <text>{`ratio = ${model.ratio().toFixed(3)}`}</text>
          <text>{`first = ${model.position(process.stdout.columns ?? 80)} cells`}</text>
        </box>
      }
    />
  ),
});
