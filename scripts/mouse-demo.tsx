import { Slider, createSlider } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { For, createSignal } from "solid-js";

const [message, setMessage] = createSignal("移动鼠标试 hover，双击 / 右键试语义");
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
        <For each={["A", "B", "C"]}>
          {label => (
            <box
              width={8}
              height={1}
              bg={hover() === label ? "accent" : "bg"}
              onMouseEnter={() => {
                setHover(label);
                setMessage(`enter ${label}`);
              }}
              onMouseLeave={() => setHover(null)}
              onClick={event => setMessage(`click ${label}:${event.clickCount ?? 1}`)}
              onDoubleClick={() => setMessage(`double click ${label}`)}
              onContextMenu={() => setMessage(`context menu ${label}`)}
            />
          )}
        </For>
      </row>
      <Slider model={sliderModel} width={31} showValue />
      <text color="muted">拖 slider 可移出矩形，capture 会继续收到 drag</text>
    </box>
  ),
});
