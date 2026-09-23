/**
 * Artifact Canvas —— SPEC §11.1。
 *
 * 差异化的点不是「能画图」，而是**把图片、diff、日志、表格、JSON 收敛成同一个
 * 一等公民**：它们都来自 tool result，都挂在 tool call / message 上，都能被
 * pin、展开、复制、并排比较、在 WebUI 打开、跟着回放重放。
 *
 * 分层：
 *   artifact-model.ts 纯函数（分类 / diff 解析 / 表格对齐 / sparkline）—— 好测
 *   artifacts.tsx     组件（ArtifactView / ArtifactCanvas）—— 只做布局与交互
 *
 * 关键约束：内容渲染必须是**有界**的。一个 50MB 的日志 artifact 不能把布局
 * 拖死，所以折叠态只取摘要，展开态也按 `maxLines` 截断并明确提示还剩多少行。
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import {
  type Artifact,
  type ArtifactKind,
  KIND_COLOR,
  KIND_GLYPH,
  artifactSummary,
  parseNumbers,
  parseTable,
  parseUnifiedDiff,
  prettyJson,
  sparkline,
  formatTable,
} from "./artifact-model.ts";
import type { Session } from "./session.ts";

// 纯函数从 model 层转出去，`@butui/agent` 的公开 API 不变
export * from "./artifact-model.ts";

// ── 组件 ────────────────────────────────────────────────────────────────────

/**
 * 渲染器注入。
 *
 * `@butui/agent` **不依赖** `@butui/image`：图片解码要用 Bun 内建（`bun` 的
 * `inflateSync`），而同一份组件树还要能进 WebUI 的 browser 打包。所以图片这块
 * 由调用方注入：
 *
 *   TUI    → `artifactImageRenderer()`（`@butui/image`，走 Kitty/半块）
 *   WebUI  → 直接 `<img src>`（浏览器自己解码）
 *   不注入 → 退化成纯文本占位符，永远不会炸
 */
export interface ArtifactRenderers {
  image?: (source: string, alt: string) => unknown;
}

function ImageArtifact(props: {
  artifact: Artifact;
  renderers?: ArtifactRenderers;
}) {
  const custom = props.renderers?.image;
  if (custom) return custom(props.artifact.source, artifactSummary(props.artifact)) as never;
  // 默认占位：不依赖任何图片能力，把路径和 MIME 老实写出来
  return (
    <box border="round" borderColor="muted" padding={1}>
      <text color="muted">🖼 {props.artifact.source}</text>
      <text color="muted">{props.artifact.mime ?? "unknown mime"}（未注入图片渲染器）</text>
    </box>
  );
}

/** 截断提示。做成组件而不是「返回 JSX 的函数」，避免动态槽里反复插入节点。 */
function HiddenNote(props: { hidden: number }) {
  return (
    <Show when={props.hidden > 0}>
      <text color="muted">
        {"… 还有 "}
        {props.hidden}
        {" 行（点击展开）"}
      </text>
    </Show>
  );
}

/** 渲染 artifact 内容；`expanded` 决定截断长度 */
export function ArtifactBody(props: {
  artifact: Artifact;
  expanded: boolean;
  renderers?: ArtifactRenderers;
}) {
  const maxLines = () => (props.expanded ? 200 : 6);
  const lines = createMemo(() => props.artifact.source.split("\n"));

  const clipped = createMemo(() => {
    const all = lines();
    const limit = maxLines();
    const hidden = Math.max(0, all.length - limit);
    return { shown: all.slice(0, limit), hidden };
  });

  return (
    <box>
      <Show when={props.artifact.kind === "image"}>
        <ImageArtifact artifact={props.artifact} renderers={props.renderers} />
      </Show>

      <Show when={props.artifact.kind === "diff"}>
        <box>
          <For each={parseUnifiedDiff(clipped().shown.join("\n"))}>
            {line => (
              <text
                color={
                  line.kind === "add"
                    ? "success"
                    : line.kind === "remove"
                      ? "danger"
                      : line.kind === "header"
                        ? "accent"
                        : line.kind === "meta"
                          ? "muted"
                          : "fg"
                }
              >
                {line.text}
              </text>
            )}
          </For>
          <HiddenNote hidden={clipped().hidden} />
        </box>
      </Show>

      <Show when={props.artifact.kind === "table"}>
        <box>
          <For each={formatTable(parseTable(clipped().shown.join("\n")))}>
            {row => <text color="fg">{row}</text>}
          </For>
          <HiddenNote hidden={clipped().hidden} />
        </box>
      </Show>

      <Show when={props.artifact.kind === "json"}>
        <box>
          <For each={prettyJson(clipped().shown.join("\n")).split("\n").slice(0, maxLines())}>
            {line => <text color={/^\s*"[^"]+":/.test(line) ? "accent" : "fg"}>{line}</text>}
          </For>
          <HiddenNote hidden={clipped().hidden} />
        </box>
      </Show>

      <Show when={props.artifact.kind === "chart"}>
        <box gap={0}>
          <text color="success">{sparkline(parseNumbers(props.artifact.source), 60)}</text>
          <text color="muted">{chartRange(props.artifact.source)}</text>
        </box>
      </Show>

      <Show when={props.artifact.kind === "log" || props.artifact.kind === "file"}>
        <box>
          <For each={clipped().shown}>{line => <text color="fg">{line}</text>}</For>
          <HiddenNote hidden={clipped().hidden} />
        </box>
      </Show>
    </box>
  );
}

function chartRange(text: string): string {
  const numbers = parseNumbers(text);
  if (numbers.length === 0) return "无数据";
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const last = numbers[numbers.length - 1];
  return `min ${min} · max ${max} · last ${last} · ${numbers.length} 点`;
}

/** 单张 artifact 卡片：标题栏（pin / open / copy）+ 可折叠内容 */
export function ArtifactView(props: {
  artifact: Artifact;
  pinned?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onPin?: () => void;
  onOpen?: () => void;
  onCopy?: () => void;
  renderers?: ArtifactRenderers;
  /** 并排比较时由父级分配宽度 */
  flexGrow?: number;
  width?: number | `${number}%`;
}) {
  const artifact = props.artifact;
  return (
    <box
      border="round"
      borderColor={props.pinned ? "accent" : "muted"}
      padding={1}
      gap={0}
      flexGrow={props.flexGrow}
      width={props.width}
      semantic={`artifact:${artifact.id}`}
    >
      <row gap={1} onClick={props.onToggle} semantic={`artifact:${artifact.id}:toggle`}>
        <text color={KIND_COLOR[artifact.kind]}>{KIND_GLYPH[artifact.kind]}</text>
        <text color="fg" bold>
          {artifact.kind}
        </text>
        <text color="muted">{artifactSummary(artifact)}</text>
        <Show when={props.pinned}>
          <text color="accent">📌</text>
        </Show>
      </row>

      <ArtifactBody artifact={artifact} expanded={props.expanded ?? false} renderers={props.renderers} />

      <row gap={2} semantic={`artifact:${artifact.id}:actions`}>
        <text color="accent" onClick={props.onPin} semantic={`artifact:${artifact.id}:pin`}>
          {props.pinned ? "[unpin]" : "[pin]"}
        </text>
        <text color="accent" onClick={props.onOpen} semantic={`artifact:${artifact.id}:open`}>
          [open]
        </text>
        <text color="accent" onClick={props.onCopy} semantic={`artifact:${artifact.id}:copy`}>
          [copy]
        </text>
        <Show when={artifact.toolCallId}>
          <text color="muted" semantic={`artifact:${artifact.id}:tool`}>
            ← tool:{artifact.toolCallId}
          </text>
        </Show>
      </row>
    </box>
  );
}

export interface ArtifactCanvasProps {
  artifacts: readonly Artifact[];
  /** 有 session 时，[open] 走 `artifact.open` 命令（remote attach / WebUI 打开） */
  session?: Session;
  /** 复制回调；不给就退化成把路径写进 UI 提示 */
  onCopy?: (artifact: Artifact) => void;
  renderers?: ArtifactRenderers;
  /** 并排比较：pin 两张时左右排开（SPEC §11.1） */
  compare?: boolean;
  title?: string;
}

/**
 * Artifact Canvas（SPEC §11.1）。
 *
 * 交互：点击卡片展开/折叠、`[pin]` 固定、`[open]` 交给 agent / WebUI、
 * `[copy]` 复制路径。pin 两张且 `compare` 打开时左右并排比较。
 */
export function ArtifactCanvas(props: ArtifactCanvasProps) {
  const [pinned, setPinned] = createSignal<string[]>([]);
  const [expanded, setExpanded] = createSignal<string[]>([]);

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter(x => x !== id) : [...list, id];

  const pinnedArtifacts = createMemo(() => props.artifacts.filter(a => pinned().includes(a.id)));
  const comparing = () =>
    Boolean(props.compare) && pinnedArtifacts().length >= 2 && pinnedArtifacts().length <= 2;

  const open = (artifact: Artifact): void => {
    props.session?.send({ type: "artifact.open", id: artifact.id });
  };

  return (
    <box gap={1} semantic="artifact:canvas">
      <row gap={1} semantic="artifact:canvas:header">
        <text color="muted">
          {props.title ?? "artifacts"} {props.artifacts.length}
        </text>
        <Show when={pinned().length > 0}>
          <text color="accent">
            {"· "}
            {pinned().length}
            {" pinned"}
          </text>
        </Show>
        <Show when={comparing()}>
          <text color="success">· 并排比较</text>
        </Show>
      </row>

      <Show when={comparing()}>
        <row gap={1}>
          <For each={pinnedArtifacts().slice(0, 2)}>
            {artifact => (
              <ArtifactView
                artifact={artifact}
                pinned
                flexGrow={1}
                expanded={expanded().includes(artifact.id)}
                onToggle={() => setExpanded(list => toggle(list, artifact.id))}
                onPin={() => setPinned(list => toggle(list, artifact.id))}
                onOpen={() => open(artifact)}
                onCopy={() => props.onCopy?.(artifact)}
                renderers={props.renderers}
              />
            )}
          </For>
        </row>
      </Show>

      <Show when={!comparing()}>
        <For each={props.artifacts}>
          {artifact => (
            <ArtifactView
              artifact={artifact}
              pinned={pinned().includes(artifact.id)}
              expanded={expanded().includes(artifact.id)}
              onToggle={() => setExpanded(list => toggle(list, artifact.id))}
              onPin={() => setPinned(list => toggle(list, artifact.id))}
              onOpen={() => open(artifact)}
              onCopy={() => props.onCopy?.(artifact)}
              renderers={props.renderers}
            />
          )}
        </For>
      </Show>
    </box>
  );
}
