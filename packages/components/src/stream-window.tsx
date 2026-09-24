/**
 * 固定高度、可滚动的 cold/hot transcript 窗口。
 *
 * 与普通 `<StreamText>` 不同，这个组件不要求完整 transcript 在内存中：
 * controller 只加载当前窗口，并按页预取相邻内容。
 */
import {
  StreamText,
  createStreamWindowController,
  type SmoothStreamOptions,
  type StreamId,
  type StreamLedger,
} from "@butui/stream";
import { useAppScope, useFocusScope } from "@butui/solid";
import type { FrameClock } from "@butui/core";
import { createEffect, Show } from "solid-js";
import { ScrollBar } from "./scrollbar.tsx";
import {
  createScrollBarForStreamWindow,
  createStreamWindowInput,
} from "./stream-window.ts";

export interface StreamWindowProps {
  ledger: StreamLedger;
  streamId: StreamId;
  height: number;
  width?: number | `${number}%`;
  scrollbar?: boolean;
  prefetchPages?: number;
  cacheSize?: number;
  wheelStep?: number;
  pageOverlap?: number;
  smooth?: boolean | SmoothStreamOptions;
  color?: string;
  semantic?: string;
  /** 覆盖 runtime 共享 FrameClock；测试 / 嵌入方使用。 */
  clock?: FrameClock;
  /** 点击窗口时自动聚焦；默认 true。 */
  focusOnClick?: boolean;
}

export function StreamWindow(props: StreamWindowProps) {
  const height = (): number => Math.max(0, Math.floor(props.height));
  const scope = useAppScope();
  const clock = props.clock ?? scope?.frameClock;
  const controller = createStreamWindowController({
    ledger: props.ledger,
    streamId: props.streamId,
    height: height(),
    ...(clock ? { clock } : {}),
    ...(props.prefetchPages !== undefined
      ? { prefetchPages: props.prefetchPages }
      : {}),
    ...(props.cacheSize !== undefined ? { cacheSize: props.cacheSize } : {}),
  });
  const input = createStreamWindowInput(controller, {
    ...(props.wheelStep !== undefined ? { wheelStep: props.wheelStep } : {}),
    ...(props.pageOverlap !== undefined ? { pageOverlap: props.pageOverlap } : {}),
  });
  const scrollBar = createScrollBarForStreamWindow(controller);
  const focus = useFocusScope();

  createEffect(
    () => height(),
    nextHeight => {
      if (controller.height() !== nextHeight) {
        void controller.setHeight(nextHeight);
      } else {
        void controller.load();
      }
    }
  );

  return (
    <box
      width={props.width}
      height={height()}
      overflow="hidden"
      focusable
      semantic={props.semantic ?? `stream-window:${props.streamId}`}
      onKey={input.handleKey}
      onWheel={input.handleWheel}
      onClick={event => {
        if (props.focusOnClick !== false && event.target) {
          focus?.focus(event.target);
        }
      }}
    >
      <row width="100%" height="100%">
        <box flexGrow={1} overflow="hidden">
          <StreamText
            source={controller.source}
            smooth={props.smooth}
            color={props.color}
          />
        </box>
        <Show when={props.scrollbar}>
          <ScrollBar model={scrollBar} />
        </Show>
      </row>
    </box>
  );
}
