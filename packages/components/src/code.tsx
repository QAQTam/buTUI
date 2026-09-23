/**
 * `<Code>` —— SPEC §10.1。
 *
 * 逐行渲染 + 轻量高亮（`highlight.ts`）。行号、最大行数截断、单行高亮
 * （`highlightLines`，用来标「改动的那几行」）都在这里。
 *
 * 高亮是**可替换**的：`highlight={myTokenizer}` 换成你自己的（bugent 那套、
 * 或者以后接 tree-sitter）。默认实现是逐行、无跨行状态的扫描器 —— 这样流式
 * 场景下每行到达时都能立刻上色。
 */
import type { JSX } from "@butui/solid/jsx-runtime";
import { For, Show } from "solid-js";
import {
  type Token,
  type TokenKind,
  TOKEN_COLOR,
  tokenize,
} from "./highlight.ts";

export interface CodeProps {
  /** 代码文本 */
  source: string;
  /** 语言（只影响注释风格识别，不做严格语法） */
  language?: string;
  /** 显示行号 */
  lineNumbers?: boolean;
  /** 行号颜色 */
  lineNumberColor?: string;
  /** 最多显示几行（超出部分截断并提示） */
  maxLines?: number;
  /** 这些行（1-based）加背景高亮 */
  highlightLines?: readonly number[];
  /** 高亮行的背景色 */
  highlightBg?: string;
  /** 自定义 token 颜色 */
  colors?: Partial<Record<TokenKind, string>>;
  /** 自定义分词器 */
  highlight?: (source: string, language?: string) => Token[][];
  /** 被截断时的提示文案 */
  truncatedHint?: (hidden: number) => string;
  semantic?: string;
}

export function Code(props: CodeProps) {
  const allLines = (): string[] => (props.source ?? "").split("\n");
  const shown = (): string[] => {
    const lines = allLines();
    const limit = props.maxLines;
    return limit !== undefined && limit >= 0 ? lines.slice(0, limit) : lines;
  };
  const hidden = (): number => Math.max(0, allLines().length - shown().length);
  const gutter = (): number => (props.lineNumbers ? String(allLines().length).length + 1 : 0);
  const tokens = (): Token[][] =>
    (props.highlight ?? tokenize)(shown().join("\n"), props.language);
  const colorOf = (kind: TokenKind): string => props.colors?.[kind] ?? TOKEN_COLOR[kind];
  const isHighlighted = (line: number): boolean => props.highlightLines?.includes(line) ?? false;

  return (
    <box semantic={props.semantic ?? "code"}>
      <For each={tokens()}>
        {(lineTokens, index) => {
          const lineNumber = (): number => index() + 1;
          return (
            <row bg={isHighlighted(lineNumber()) ? (props.highlightBg ?? "border") : undefined}>
              <Show when={props.lineNumbers}>
                <text color={props.lineNumberColor ?? "muted"}>
                  {`${String(lineNumber()).padStart(gutter() - 1)} `}
                </text>
              </Show>
              <text>
                <For each={lineTokens}>
                  {token => <text color={colorOf(token.kind)}>{token.text}</text>}
                </For>
              </text>
            </row>
          );
        }}
      </For>
      <Show when={hidden() > 0}>
        <text color="muted">
          {props.truncatedHint?.(hidden()) ?? `… 还有 ${hidden()} 行`}
        </text>
      </Show>
    </box>
  );
}
