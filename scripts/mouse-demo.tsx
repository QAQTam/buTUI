import { Slider, createSlider } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { For, createSignal } from "solid-js";

const [message, setMessage] = createSignal(
  "移动鼠标试 hover / OSC 22，双击 / 右键试语义"
);
const [hover, setHover] = createSignal<string | null>(null);
const [slider, setSlider] = createSignal(12);
const sliderModel = createSlider({
  value: slider,
  min: 0,
  max: 30,
  step: 1,
  onChange: setSlider,
});

createTuiApp({
  mouseMotion: "hover",
  view: () => (
    <box border padding={1} gap={1}>
      <text bold color="accent">
        buTUI mouse demo
      </text>
      <text>{message()}</text>
      <row gap={1}>
        <For
          each={[
            { label: "A", cursor: "pointer" },
            { label: "B", cursor: "help" },
            { label: "C", cursor: "text" },
          ] as const}
        >
          {target => (
            <box
              width={8}
              height={1}
              cursor={target.cursor}
              bg={hover() === target.label ? "accent" : "bg"}
              onMouseEnter={() => {
                setHover(target.label);
                setMessage(`enter ${target.label}: ${target.cursor}`);
              }}
              onMouseLeave={() => setHover(null)}
              onClick={event =>
                setMessage(`click ${target.label}:${event.clickCount ?? 1}`)
              }
              onDoubleClick={() => setMessage(`double click ${target.label}`)}
              onContextMenu={() => setMessage(`context menu ${target.label}`)}
            >
              <text>{target.label}</text>
            </box>
          )}
        </For>
      </row>
      <Slider model={sliderModel} width={31} showValue />
      <text color="muted">拖 slider 可移出矩形；快速释放会按速度继续滑动</text>
    </box>
  ),
});
