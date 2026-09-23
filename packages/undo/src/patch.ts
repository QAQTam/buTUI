/**
 * 行级 patch —— SPEC §8.4 的「反向 patch」。
 *
 * 刻意不实现 unified diff 的文本格式，而是用**编辑脚本**：
 *
 *     { at, remove: string[], insert: string[] }
 *
 * 理由：
 *   - 可逆是结构性的（交换 remove/insert 即可），不需要重新解析 diff 文本；
 *   - 应用时能做精确的上下文校验（`remove` 必须逐行匹配），冲突检测免费；
 *   - 不需要引入 diff 依赖，符合 SPEC §2.2「默认零 native core」。
 *
 * 内存代价是「被删除/插入的行」而不是整个文件，对 agent 场景足够。
 */

export interface PatchOp {
  /** 在 before 文本中的起始行号（0-based） */
  at: number;
  /** 被删除的行（不含换行符） */
  remove: string[];
  /** 插入的行（不含换行符） */
  insert: string[];
}

/**
 * 编辑脚本 + 末尾换行标记。
 *
 * 末尾换行必须单独记：`""` → `"hello\n"` 的行内容只差一个 insert，
 * 但「有没有末尾换行」是文本属性，不记就还原不回去。
 */
export interface Patch {
  ops: PatchOp[];
  beforeTrailingNewline: boolean;
  afterTrailingNewline: boolean;
}

export interface ApplyOk {
  ok: true;
  text: string;
}

export interface ApplyConflict {
  ok: false;
  /** 冲突发生的行号 */
  at: number;
  expected: string[];
  actual: string[];
}

export type ApplyResult = ApplyOk | ApplyConflict;

/** 按行切分，保留「是否有末尾换行」的信息 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // "a\n" → ["a", ""]：最后那个空串代表末尾换行，不当作一行内容
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? "\n" : "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** 去掉公共前后缀，剩下的中间段再算 LCS —— 让典型编辑的 diff 很便宜 */
export function diffLines(before: string, after: string): Patch {
  const a = splitLines(before);
  const b = splitLines(after);
  const beforeTrailingNewline = before.endsWith("\n");
  const afterTrailingNewline = after.endsWith("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  if (middleA.length === 0 && middleB.length === 0) {
    return { ops: [], beforeTrailingNewline, afterTrailingNewline };
  }

  // 中间段太大时退化成「整体替换」：仍然是正确的编辑脚本，只是不最小
  const MAX_LCS_CELLS = 250_000;
  if (middleA.length * middleB.length > MAX_LCS_CELLS) {
    return {
      ops: [{ at: start, remove: middleA, insert: middleB }],
      beforeTrailingNewline,
      afterTrailingNewline,
    };
  }

  return { ops: lcsOps(middleA, middleB, start), beforeTrailingNewline, afterTrailingNewline };
}

/** 标准 LCS 编辑脚本 */
function lcsOps(a: string[], b: string[], offset: number): PatchOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: PatchOp[] = [];
  let i = 0;
  let j = 0;
  let pending: PatchOp | undefined;

  const flush = () => {
    if (pending && (pending.remove.length || pending.insert.length)) ops.push(pending);
    pending = undefined;
  };

  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
      continue;
    }
    if (!pending) pending = { at: offset + i, remove: [], insert: [] };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      pending.insert.push(b[j]);
      j++;
    } else if (i < n) {
      pending.remove.push(a[i]);
      i++;
    }
  }
  flush();
  return ops;
}

/**
 * 把 patch 反过来（用于 undo）。
 *
 * 注意 `at` 是「在哪个文本里的行号」：正向 patch 的 `at` 是 before 坐标，
 * 反过来之后必须换算成 after 坐标 —— 也就是要加上前面所有 op 的行数增量。
 * 直接照抄 `at` 是错的（早期版本就是这么错的）。
 *
 * 换算后 ops 仍然按 `at` 升序，`applyPatch` 照常顺序应用即可；
 * 「按逆序撤销」是**变更之间**的顺序（plan.changes 已逆序），不是 op 之间。
 */
export function reversePatch(patch: Patch): Patch {
  const ops: PatchOp[] = [];
  let delta = 0;
  for (const op of patch.ops) {
    ops.push({ at: op.at + delta, remove: op.insert, insert: op.remove });
    delta += op.insert.length - op.remove.length;
  }
  return {
    ops,
    beforeTrailingNewline: patch.afterTrailingNewline,
    afterTrailingNewline: patch.beforeTrailingNewline,
  };
}

/** 应用 patch；上下文不匹配就报冲突（SPEC §8.4 第 2 步） */
export function applyPatch(text: string, patch: Patch): ApplyResult {
  const lines = splitLines(text);
  const out: string[] = [];
  let cursor = 0;

  for (const op of patch.ops) {
    if (op.at < cursor) {
      return { ok: false, at: op.at, expected: op.remove, actual: [] };
    }
    while (cursor < op.at && cursor < lines.length) out.push(lines[cursor++]);
    const actual = lines.slice(op.at, op.at + op.remove.length);
    if (actual.length !== op.remove.length || !actual.every((line, k) => line === op.remove[k])) {
      return { ok: false, at: op.at, expected: op.remove, actual };
    }
    out.push(...op.insert);
    cursor = op.at + op.remove.length;
  }
  while (cursor < lines.length) out.push(lines[cursor++]);

  return { ok: true, text: joinLines(out, patch.afterTrailingNewline) };
}

/** 内容哈希 —— SPEC §8.4 用它判断「文件是否被外部修改」 */
export function hashContent(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex").slice(0, 16);
}
