import type { MouseEvent, Node } from "@butui/core";
import { createTuiApp } from "@butui/runtime";
import { useMouseCapture } from "@butui/solid";
import { For, createSignal } from "solid-js";

const [message, setMessage] = createSignal("移动鼠标试 hover，双击 / 右键试语义");
const [hover, setHover] = createSignal<string | null>(null);
const [slider, setSlider] = createSignal(12);

function Slider() {
  const [node, setNode] = createSignal<Node>();
  const capture = useMouseCapture();

  const begin = (event: MouseEvent): void => {
    const current = node();
    if (current) capture?.capture(current);
    setSlider(Math.max(0, Math.min(30, event.localX ?? 0)));
  };
  const drag = (event: MouseEvent): void => {
    setSlider(Math.max(0, Math.min(30, event.localX ?? 0)));
  };
  const end = (): void => capture?.release();

  return (
    <box
      ref={setNode}
      width={42}
      height={1}
      selectable={false}
      onMouseDown={begin}
      onDrag={drag}
      onMouseUp={end}
    >
      <text>{`slider [${"#".repeat(slider())}${".".repeat(30 - slider())}]`}</text>
    </box>
  );
}

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
      <Slider />
      <text color="muted">拖 slider 可移出矩形，capture 会继续收到 move</text>
    </box>
  ),
});
