/**
 * `<Diff>` —— 可流式追加、按视口虚拟化的 diff 视图。
 *
 * 关键约束：
 *   - 每个 diff 行只占一个终端行，长行用 truncate，不参与折行；
 *   - 只创建视口内的行节点，大 diff 与总行数无关；
 *   - 行内容通过 `source.lineVersion(index)` 建立**逐行依赖**，改一行不会让
 *     整个 diff 重算；
 *   - `stable=false` 的行显示一个轻量游标；默认 30fps 共享时钟，所有行定稿后
 *     自动退订，reduced-motion / dumb terminal 下不启动。
 */
import type { KeyEvent, MouseEvent } from "@butui/core";
import { prefersReducedMotion, useAnimationFrame } from "@butui/solid";
import type { DiffLine, DiffLineKind, DiffStream } from "@butui/stream";
import { For, Repeat, Show, createEffect, createSignal } from "solid-js";
import {
  type Token,
  type TokenKind,
  TOKEN_COLOR,
  tokenizeLine,
  tokenizeOptionsFor,
} from "./highlight.ts";
import { createScrollBar } from "./scrollbar.ts";
import { ScrollBar } from "./scrollbar.tsx";

export interface DiffProps {
  source: DiffStream;
  /** 视口高度；不传 = 全部渲染（只适合已知的小 diff） */
  height?: number;
  /** 在右侧显示 1 cell 宽的滚动条；默认 false */
  scrollbar?: boolean;
  /** 初始是否跟随尾部，默认 true */
  follow?: boolean;
  lineNumbers?: boolean;
  /** 默认语言；单行可覆盖 */
  language?: string;
  /** context 行是否做轻量语法高亮，默认 true */
  highlight?: boolean;
  /** 流式游标动画，默认在 reduced-motion / TERM=dumb 下关闭 */
  animate?: boolean;
  cursor?: [active: string, idle: string];
  addColor?: string;
  removeColor?: string;
  hunkColor?: string;
  metaColor?: string;
  contextColor?: string;
  addBg?: string;
  removeBg?: string;
  semantic?: string;
}

const SIGN: Record<DiffLineKind, string> = {
  meta: " ",
  file: " ",
  hunk: " ",
  context: " ",
  add: "+",
  remove: "-",
};

const DEFAULT_COLOR: Record<DiffLineKind, string> = {
  meta: "muted",
  file: "accent",
  hunk: "accent",
  context: "fg",
  add: "success",
  remove: "danger",
};

function pad(value: number | undefined, width: number): string {
  return value === undefined ? " ".repeat(width) : String(value).padStart(width);
}

export function Diff(props: DiffProps) {
  const source = props.source;
  const [top, setTop] = createSignal(0);
  const [following, setFollowing] = createSignal(props.follow ?? true);
  const animate = (): boolean => props.animate ?? !prefersReducedMotion();
  const frame = useAnimationFrame({
    enabled: () => animate() && source.streaming(),
  });
  const cursor = (): string => {
    const [active = "▌", idle = "▏"] = props.cursor ?? [];
    return Math.floor(frame() / 180) % 2 === 0 ? active : idle;
  };

  const viewport = (): number => {
    if (props.height === undefined || props.height <= 0) return Math.max(1, source.count());
    return Math.max(1, Math.floor(props.height));
  };
  const maxTop = (): number => Math.max(0, source.count() - viewport());
  const windowStart = (): number =>
    props.height === undefined ? 0 : Math.min(Math.max(0, top()), maxTop());
  const windowSize = (): number => {
    if (props.height === undefined) return source.count();
    return Math.max(0, Math.min(viewport(), source.count() - windowStart()));
  };

  createEffect(
    () => [source.count(), viewport(), following()] as const,
    ([total, size, follow]) => {
      if (follow) setTop(Math.max(0, total - size));
    }
  );

  const scrollTo = (next: number, keepFollowing = false): void => {
    const value = Math.max(0, Math.min(Math.floor(next), maxTop()));
    setTop(value);
    setFollowing(keepFollowing || value >= maxTop());
  };
  const scrollBy = (delta: number): void => scrollTo(top() + delta);

  const scrollBar = createScrollBar({
    top: windowStart,
    total: source.count,
    viewport,
    track: () => (props.height === undefined ? source.count() : Math.max(0, props.height)),
    onScroll: next => scrollTo(next, false),
  });

  const handleWheel = (event: MouseEvent): void => {
    const dir = event.wheel;
    if (dir !== "up" && dir !== "down") return;
    scrollBy(dir === "down" ? 1 : -1);
  };

  const handleKey = (event: KeyEvent): void => {
    if (event.modifiers.ctrl || event.modifiers.alt || event.modifiers.meta) return;
    switch (event.name) {
      case "up":
        scrollBy(-1);
        return;
      case "down":
        scrollBy(1);
        return;
      case "pageup":
        scrollBy(-Math.max(1, viewport() - 1));
        return;
      case "pagedown":
        scrollBy(Math.max(1, viewport() - 1));
        return;
      case "home":
        scrollTo(0);
        return;
      case "end":
        scrollTo(maxTop(), true);
    }
  };

  const line = (index: number): DiffLine | undefined => {
    source.lineVersion(index); // 逐行依赖：只让真正变化的行重算
    return source.lineAt(index);
  };

  const colorOf = (kind: DiffLineKind): string => {
    if (kind === "add") return props.addColor ?? DEFAULT_COLOR.add;
    if (kind === "remove") return props.removeColor ?? DEFAULT_COLOR.remove;
    if (kind === "hunk") return props.hunkColor ?? DEFAULT_COLOR.hunk;
    if (kind === "meta" || kind === "file") return props.metaColor ?? DEFAULT_COLOR.meta;
    return props.contextColor ?? DEFAULT_COLOR.context;
  };

  const tokenColor = (kind: TokenKind): string => TOKEN_COLOR[kind];

  const highlightedTokens = (current: DiffLine): Token[] | undefined => {
    if (props.highlight === false) return undefined;
    if (current.kind === "meta" || current.kind === "file" || current.kind === "hunk") {
      return undefined;
    }
    // add / remove 保持红绿语义，避免语法色把 diff 方向盖掉。
    if (current.kind !== "context") return undefined;
    const language = current.language ?? props.language ?? source.language;
    return tokenizeLine(current.text, tokenizeOptionsFor(language));
  };

  const row = (index: number) => {
    const current = (): DiffLine | undefined => line(index);
    const tokens = (): Token[] | undefined => {
      const value = current();
      return value ? highlightedTokens(value) : undefined;
    };
    const unstable = (): boolean => current()?.stable === false;
    const semantic = (): string => `${props.semantic ?? `diff:${source.id}`}:${index}`;
    return (
      <row
        width="100%"
        height={1}
        bg={
          current()?.kind === "add"
            ? props.addBg
            : current()?.kind === "remove"
              ? props.removeBg
              : undefined
        }
        semantic={semantic()}
      >
        <Show when={props.lineNumbers}>
          <text color="muted" truncate>
            {`${pad(current()?.oldLine, source.gutterWidth())} ${pad(current()?.newLine, source.gutterWidth())} `}
          </text>
        </Show>
        <text color={colorOf(current()?.kind ?? "context")} bold={unstable()} truncate>
          {`${SIGN[current()?.kind ?? "context"]} `}
        </text>
        <Show when={tokens()} fallback={
          <text color={colorOf(current()?.kind ?? "context")} bold={unstable()} truncate>
            {current()?.text ?? ""}
          </text>
        }>
          {lineTokens => (
            <text truncate>
              <For each={lineTokens()}>
                {token => <text color={tokenColor(token.kind)}>{token.text}</text>}
              </For>
            </text>
          )}
        </Show>
        <Show when={unstable()}>
          <text color="warning" bold>
            {cursor()}
          </text>
        </Show>
      </row>
    );
  };

  return (
    <box
      semantic={props.semantic ?? `diff:${source.id}`}
      width="100%"
      height={props.height}
      overflow={props.height === undefined ? undefined : "hidden"}
      focusable={props.height !== undefined}
      onWheel={handleWheel}
      onKey={handleKey}
    >
      <row width="100%" height={props.height}>
        <box
          flexGrow={1}
          height={props.height}
          overflow={props.height === undefined ? undefined : "hidden"}
        >
          <Show when={source.count() > 0} fallback={<text color="muted">等待 diff…</text>}>
            <Repeat count={windowSize()} from={windowStart()}>
              {index => row(index)}
            </Repeat>
          </Show>
        </box>
        <Show when={props.scrollbar && props.height !== undefined}>
          <ScrollBar model={scrollBar} />
        </Show>
      </row>
    </box>
  );
}
