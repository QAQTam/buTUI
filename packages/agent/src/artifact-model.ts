/**
 * Artifact 模型与纯函数 —— SPEC §11.1 的内容层。
 *
 * 这一层**不依赖 Solid / 终端**，所以可以被 reducer 直接调用（`session.ts` 在
 * `tool.result` 时用它从 tool result 生成 artifact），也可以在 WebUI / 测试里
 * 单独使用。组件在 `artifacts.tsx`。
 */
import type { Artifact, ToolCall, ToolResult } from "./protocol.ts";

// ── 纯函数：分类与格式化 ────────────────────────────────────────────────────

export type ArtifactKind = Artifact["kind"];
export type { Artifact, ToolCall, ToolResult };

export interface DiffLine {
  kind: "add" | "remove" | "context" | "header" | "meta";
  text: string;
}

/** 解析 unified diff；不认识的行走 context，绝不丢行 */
export function parseUnifiedDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) lines.push({ kind: "meta", text: raw });
    else if (raw.startsWith("@@")) lines.push({ kind: "header", text: raw });
    else if (raw.startsWith("diff ") || raw.startsWith("index ")) lines.push({ kind: "meta", text: raw });
    else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw });
    else if (raw.startsWith("-")) lines.push({ kind: "remove", text: raw });
    else lines.push({ kind: "context", text: raw });
  }
  return lines;
}

/** 从两段文本生成 unified diff（够用的 LCS，行数大时退回「整块替换」） */
export function unifiedDiff(before: string, after: string, path = "file", context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const header = [`--- a/${path}`, `+++ b/${path}`];

  // 大文件不做 LCS：直接全量替换，避免 O(n²) 卡住 UI
  if (a.length * b.length > 250_000) {
    return [...header, `@@ -1,${a.length} +1,${b.length} @@`, ...a.map(l => `-${l}`), ...b.map(l => `+${l}`)].join("\n");
  }

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "context", text: ` ${a[i]}` });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "remove", text: `-${a[i]}` });
      i++;
    } else {
      ops.push({ kind: "add", text: `+${b[j]}` });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "remove", text: `-${a[i++]}` });
  while (j < b.length) ops.push({ kind: "add", text: `+${b[j++]}` });

  // 折叠掉远离改动的大段上下文（显示层的事，这里做掉省得每个调用方各写一遍）
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].kind === "context") continue;
    for (let d = -context; d <= context; d++) {
      const at = k + d;
      if (at >= 0 && at < ops.length) keep[at] = true;
    }
  }

  const body: DiffLine[] = [];
  let skipped = 0;
  for (let k = 0; k < ops.length; k++) {
    if (keep[k]) {
      if (skipped > 0) {
        body.push({ kind: "header", text: `@@ … 省略 ${skipped} 行 @@` });
        skipped = 0;
      }
      body.push(ops[k]);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) body.push({ kind: "header", text: `@@ … 省略 ${skipped} 行 @@` });

  const head = [...header, `@@ -1,${a.length} +1,${b.length} @@`];
  return [...head, ...body.map(line => line.text)].join("\n");
}

function countDelimiter(line: string, delimiter: string): number {
  let count = 0;
  for (const ch of line) if (ch === delimiter) count++;
  return count;
}

/**
 * 表格解析：先猜分隔符（tab / 逗号 / 竖线 / 连续空格），再看哪一列数最稳定。
 * 猜不出来就按整行单列返回 —— 永远不丢内容。
 */
export function parseTable(text: string): string[][] {
  const lines = text.split("\n").filter(line => line.trim() !== "");
  if (lines.length === 0) return [];

  const candidates: Array<[string, RegExp]> = [
    ["\t", /\t/],
    [",", /,/],
    ["|", /\|/],
  ];
  let bestDelimiter: string | undefined;
  let bestScore = 0;
  for (const [delimiter, pattern] of candidates) {
    if (!lines.every(line => pattern.test(line))) continue;
    const counts = lines.map(line => countDelimiter(line, delimiter));
    const columns = counts[0] + 1;
    const stable = counts.every(count => count === counts[0]);
    const score = columns > 1 && stable ? columns * 10 + lines.length : 0;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }

  if (bestDelimiter) {
    const delimiter = bestDelimiter;
    return lines.map(line => {
      const cells = line.split(delimiter).map(cell => cell.trim());
      // 竖线表格的首尾空单元是边框，不是数据
      if (delimiter === "|") {
        if (cells[0] === "") cells.shift();
        if (cells[cells.length - 1] === "") cells.pop();
      }
      return cells;
    });
  }

  // 连续两个以上空格也当分隔符（`ps` / `ls -l` 这类输出）
  if (lines.every(line => /\s{2,}/.test(line))) {
    return lines.map(line => line.split(/\s{2,}/).map(cell => cell.trim()));
  }

  return lines.map(line => [line]);
}

/** 用显示宽度对齐（CJK 不能按 .length 算），可选截断 */
export function formatTable(rows: string[][], options: { maxWidth?: number } = {}): string[] {
  if (rows.length === 0) return [];
  const columns = Math.max(...rows.map(row => row.length));
  const widths = new Array(columns).fill(0);
  for (const row of rows) {
    for (let c = 0; c < columns; c++) {
      widths[c] = Math.max(widths[c], Bun.stringWidth(row[c] ?? ""));
    }
  }

  const total = widths.reduce((sum, w) => sum + w + 2, 0);
  if (options.maxWidth && total > options.maxWidth) {
    // 按比例压缩最宽的列，至少留 3 个字符
    const scale = (options.maxWidth - 2 * columns) / widths.reduce((sum, w) => sum + w, 0);
    for (let c = 0; c < columns; c++) {
      widths[c] = Math.max(3, Math.floor(widths[c] * scale));
    }
  }

  return rows.map(row =>
    row
      .map((cell, c) => {
        const width = widths[c];
        const clipped = clipToWidth(cell, width);
        return clipped + " ".repeat(Math.max(0, width - Bun.stringWidth(clipped)));
      })
      .join("  ")
  );
}

function clipToWidth(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const w = Bun.stringWidth(segment);
    if (used + w > width - 1) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** 数值序列 → sparkline。超过 width 时按块平均降采样。 */
export function sparkline(values: readonly number[], width?: number): string {
  if (values.length === 0) return "";
  const limit = width && width > 0 ? width : values.length;
  const sampled: number[] = [];
  if (values.length <= limit) {
    sampled.push(...values);
  } else {
    const bucket = values.length / limit;
    for (let i = 0; i < limit; i++) {
      const from = Math.floor(i * bucket);
      const to = Math.max(from + 1, Math.floor((i + 1) * bucket));
      let sum = 0;
      for (let k = from; k < to && k < values.length; k++) sum += values[k];
      sampled.push(sum / (to - from));
    }
  }

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const span = max - min;
  return sampled
    .map(value => {
      if (span === 0) return SPARK_LEVELS[3];
      const t = (value - min) / span;
      return SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, Math.floor(t * SPARK_LEVELS.length))];
    })
    .join("");
}

/** 从文本里抠出数字序列（`name value` / `value` 都认） */
export function parseNumbers(text: string): number[] {
  const numbers: number[] = [];
  for (const line of text.split("\n")) {
    const matches = line.match(/-?\d+(?:\.\d+)?/g);
    if (!matches) continue;
    numbers.push(Number(matches[matches.length - 1]));
  }
  return numbers.filter(value => Number.isFinite(value));
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const TABLE_LIKE = /^[\w.\- ]+$/;

/**
 * 输出分类启发式 —— 「从 tool result 直接生成 artifact」（SPEC §11.1）。
 *
 * 只做保守判断：拿不准就当 log（log 的渲染是「原样显示」，永远不会骗人）。
 */
export function classifyOutput(output: string, hint?: ArtifactKind): ArtifactKind {
  if (hint) return hint;
  const trimmed = output.trim();
  if (trimmed === "") return "log";

  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // 继续往下猜
    }
  }

  if (/^(diff --git|--- |\+\+\+ |@@ )/m.test(trimmed)) return "diff";

  const lines = trimmed.split("\n");
  if (lines.length >= 2 && lines.every(line => /\t/.test(line) || /\|/.test(line))) return "table";
  if (lines.length >= 2 && lines.every(line => /\s{2,}/.test(line)) && lines.every(line => TABLE_LIKE.test(line))) {
    return "table";
  }
  return "log";
}

/** 一条 artifact 的一行摘要（列表态、折叠态都用它） */
export function artifactSummary(artifact: Artifact): string {
  const lines = artifact.source.split("\n");
  const nonEmpty = lines.find(line => line.trim() !== "") ?? "";
  // 摘要是一行文本：制表符 / 连续空格压成单个空格，否则会撑破卡片标题
  const first = clipToWidth(nonEmpty.trim().replace(/\s+/g, " "), 60);
  switch (artifact.kind) {
    case "image":
      return artifact.mime ? `${artifact.source}（${artifact.mime}）` : artifact.source;
    case "diff": {
      const added = lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length;
      const removed = lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length;
      return `${added} 增 / ${removed} 删 · ${first || "无内容"}`;
    }
    case "table":
      return `${lines.filter(line => line.trim() !== "").length} 行 · ${first}`;
    case "chart": {
      const numbers = parseNumbers(artifact.source);
      return numbers.length > 0 ? `${numbers.length} 个数据点` : "无数据";
    }
    default:
      return first;
  }
}

export const KIND_GLYPH: Record<ArtifactKind, string> = {
  image: "🖼",
  diff: "±",
  log: "▤",
  table: "▦",
  json: "{}",
  file: "▭",
  chart: "▁▄█",
};

export const KIND_COLOR: Record<ArtifactKind, string> = {
  image: "accent",
  diff: "warning",
  log: "muted",
  table: "accent",
  json: "success",
  file: "muted",
  chart: "success",
};

export function artifactGlyph(kind: ArtifactKind): string {
  return KIND_GLYPH[kind];
}

/**
 * 从 tool result 生成 artifact（SPEC §11.1「从 tool result 直接生成」）。
 *
 * 工作区变更 → 每个文件一条 diff artifact；其余按输出内容分类。
 * 这样 agent 侧不需要额外发 `artifact.add`，UI 也能拿到可回放的结构。
 */
export function artifactsFromToolResult(
  call: ToolCall,
  result: ToolResult,
  options: { now?: number } = {}
): Artifact[] {
  const createdAt = options.now ?? Date.now();
  const out: Artifact[] = [];

  for (const change of result.workspace ?? []) {
    out.push({
      id: `${call.id}:${change.path}`,
      kind: "diff",
      source: unifiedDiff(change.before, change.after, change.path),
      createdAt,
      toolCallId: call.id,
    });
  }

  const output = result.output ?? result.error ?? "";
  if (output.trim() !== "") {
    out.push({
      id: `${call.id}:output`,
      kind: classifyOutput(output, call.name === "chart" ? "chart" : undefined),
      source: output,
      createdAt,
      toolCallId: call.id,
    });
  }

  return out;
}

