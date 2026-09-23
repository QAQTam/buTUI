/**
 * 流式 diff 数据源。
 *
 * 后端负责 diff 算法；前端只消费结构化的「行 upsert」。关键约束：
 *
 * 1. 每行有稳定 `id`。模型流中途可能改写同一行，后端重复 upsert 同一 id 即可，
 *    前端 O(1) 定位并只更新那一行。
 * 2. 正常路径是 append-only。`replaceTail` 只允许替换最后 N 行，处理后端
 *    在看到更多上下文后修正尾部 hunk 的情况，不做任意位置 splice。
 * 3. 行文本和行结构分开失效：新增行 bump 结构版本；改一行只 bump 该行的
 *    版本号。Solid 只重算可见且真正变化的那一行。
 *
 * 这个层不依赖布局 / 终端，可以单独回放、测试和给 WebUI 复用。
 */
import { createSignal, type Accessor } from "solid-js";

export type DiffLineKind = "meta" | "file" | "hunk" | "context" | "add" | "remove";

export interface DiffLine {
  /** 稳定 id；同一逻辑行每次修订都必须复用 */
  id: string;
  kind: DiffLineKind;
  /** 不含 `+` / `-` / `@@` 前缀的内容 */
  text: string;
  oldLine?: number;
  newLine?: number;
  /**
   * `false` 表示这一行仍可能被后续 chunk 改写。
   *
   * 默认 `true`。只有流式中的当前行 / hunk 才应该标 false；全量 diff 不要
   * 把它当动画开关，否则组件会一直保持动画订阅。
   */
  stable?: boolean;
  /** 覆盖 source 默认语言（多文件 diff 的每个文件可以不同） */
  language?: string;
}

export type DiffPatchOp =
  | { op: "upsert"; lines: readonly DiffLine[] }
  | { op: "replaceTail"; lines: readonly DiffLine[] };

export interface DiffPatch {
  ops: readonly DiffPatchOp[];
}

export interface DiffStreamStats {
  upserts: number;
  appended: number;
  updated: number;
  replaceTail: number;
  flushed: number;
}

export interface DiffStreamOptions {
  id?: string;
  path?: string;
  language?: string;
}

interface DiffRow {
  line: DiffLine;
  revision: number;
  version: Accessor<number>;
  bump: (value: number) => number;
}

export interface DiffStream {
  readonly id: string;
  readonly path?: string;
  readonly language?: string;
  /** 当前逻辑行；行对象可能被替换，请通过 lineAt / lineVersion 读取 */
  readonly lines: readonly DiffLine[];
  count(): number;
  version(): number;
  /** 读取某一行的响应式版本；组件必须调用它来建立细粒度依赖 */
  lineVersion(index: number): number;
  lineAt(index: number): DiffLine | undefined;
  /** 是否还有 stable=false 的行 */
  streaming(): boolean;
  /** 旧 / 新行号的最大位数，给 gutter 对齐用 */
  gutterWidth(): number;
  readonly stats: Readonly<DiffStreamStats>;
  apply(patch: DiffPatch): void;
  upsert(lines: readonly DiffLine[]): void;
  replaceTail(lines: readonly DiffLine[]): void;
  /** 把所有仍在流式的行定稿；幂等 */
  flush(): void;
}

function normalizeLine(line: DiffLine): DiffLine {
  return {
    ...line,
    stable: line.stable ?? true,
  };
}

function maxLineNumber(line: DiffLine): number {
  return Math.max(line.oldLine ?? 0, line.newLine ?? 0);
}

export function createDiffStream(options: DiffStreamOptions = {}): DiffStream {
  const lines: DiffLine[] = [];
  const rows: DiffRow[] = [];
  const indexById = new Map<string, number>();
  const unstable = new Set<string>();
  const [structureRev, bumpStructure] = createSignal(0);
  const [streamRev, bumpStream] = createSignal(0);
  const [gutterRev, bumpGutter] = createSignal(0);
  let structureVersion = 0;
  let streamVersion = 0;
  let gutterVersion = 0;
  let widestLine = 0;
  const stats: DiffStreamStats = {
    upserts: 0,
    appended: 0,
    updated: 0,
    replaceTail: 0,
    flushed: 0,
  };

  const markUnstable = (line: DiffLine): void => {
    if (line.stable === false) unstable.add(line.id);
    else unstable.delete(line.id);
  };

  const updateRow = (index: number, next: DiffLine): void => {
    const row = rows[index]!;
    const normalized = normalizeLine(next);
    lines[index] = normalized;
    row.line = normalized;
    row.revision++;
    row.bump(row.revision);
    const previousWidest = widestLine;
    widestLine = Math.max(widestLine, maxLineNumber(normalized));
    if (widestLine !== previousWidest) {
      gutterVersion++;
      bumpGutter(gutterVersion);
    }
    markUnstable(normalized);
    stats.updated++;
  };

  const appendRow = (line: DiffLine): void => {
    const normalized = normalizeLine(line);
    const [version, bump] = createSignal(0);
    const index = lines.length;
    lines.push(normalized);
    rows.push({ line: normalized, revision: 0, version, bump: value => bump(value) });
    indexById.set(normalized.id, index);
    widestLine = Math.max(widestLine, maxLineNumber(normalized));
    markUnstable(normalized);
    stats.appended++;
  };

  const bumpStructureVersion = (): void => {
    structureVersion++;
    bumpStructure(structureVersion);
  };

  const upsert = (nextLines: readonly DiffLine[]): void => {
    if (nextLines.length === 0) return;
    const wasStreaming = unstable.size > 0;
    let appended = false;
    for (const line of nextLines) {
      stats.upserts++;
      const index = indexById.get(line.id);
      if (index === undefined) {
        appendRow(line);
        appended = true;
      } else {
        updateRow(index, line);
      }
    }
    if (appended) bumpStructureVersion();
    if ((unstable.size > 0) !== wasStreaming) {
      streamVersion++;
      bumpStream(streamVersion);
    }
  };

  const replaceTail = (nextLines: readonly DiffLine[]): void => {
    if (nextLines.length === 0) return;
    const wasStreaming = unstable.size > 0;
    stats.replaceTail++;
    const start = Math.max(0, lines.length - nextLines.length);
    let appended = false;
    for (let i = 0; i < nextLines.length; i++) {
      const line = nextLines[i]!;
      const index = start + i;
      if (index < lines.length) {
        const previous = lines[index]!;
        if (previous.id !== line.id && indexById.get(previous.id) === index) {
          indexById.delete(previous.id);
          unstable.delete(previous.id);
        }
        updateRow(index, line);
        indexById.set(line.id, index);
      } else {
        appendRow(line);
        appended = true;
      }
    }
    if (appended) bumpStructureVersion();
    if ((unstable.size > 0) !== wasStreaming) {
      streamVersion++;
      bumpStream(streamVersion);
    }
  };

  return {
    id: options.id ?? "diff",
    path: options.path,
    language: options.language,
    lines,
    count: () => (structureRev(), lines.length),
    version: () => (structureRev(), structureVersion),
    lineVersion: index => {
      const row = rows[index];
      if (!row) {
        structureRev();
        return 0;
      }
      row.version();
      return row.revision;
    },
    lineAt: index => lines[index],
    streaming: () => (streamRev(), unstable.size > 0),
    gutterWidth: () => (structureRev(), gutterRev(), String(Math.max(1, widestLine)).length),
    stats,
    apply(patch) {
      for (const op of patch.ops) {
        if (op.op === "upsert") upsert(op.lines);
        else replaceTail(op.lines);
      }
    },
    upsert,
    replaceTail,
    flush() {
      if (unstable.size === 0) return;
      const ids = [...unstable];
      for (const id of ids) {
        const index = indexById.get(id);
        if (index === undefined) continue;
        const current = lines[index]!;
        const next: DiffLine = { ...current, stable: true };
        lines[index] = next;
        const row = rows[index]!;
        row.line = next;
        row.revision++;
        row.bump(row.revision);
      }
      unstable.clear();
      streamVersion++;
      bumpStream(streamVersion);
      stats.flushed++;
    },
  };
}
