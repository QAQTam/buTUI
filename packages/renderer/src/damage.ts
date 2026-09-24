/**
 * Damage 最小闭环。
 *
 * 输入是 renderer 保留的上一帧与 layout 刚产出的下一帧；输出是 full 或
 * 逐行 cell span。Damage 是提示而不是安全边界：任何不确定情况都回退 full，
 * span 过碎时回退整行。
 */
import type { Cell, Line } from "@butui/layout";

export interface DamageSpan {
  /** 起始 cell 下标，包含。 */
  from: number;
  /** 结束 cell 下标，不包含。 */
  to: number;
}

export interface DamageLine {
  y: number;
  spans: readonly DamageSpan[];
}

export interface FrameDamage {
  full: boolean;
  lines: readonly DamageLine[];
}

export interface DamageOptions {
  /** 单行最多保留多少段；超过后退回整行。默认 8。 */
  maxSpansPerLine?: number;
  previousSize?: { width: number; height: number };
  nextSize?: { width: number; height: number };
}

const DEFAULT_MAX_SPANS = 8;

export function computeDamage(
  previous: readonly Line[],
  next: readonly Line[],
  options: DamageOptions = {}
): FrameDamage {
  const previousSize = options.previousSize;
  const nextSize = options.nextSize;
  const full =
    previous.length === 0 ||
    (previousSize !== undefined &&
      nextSize !== undefined &&
      (previousSize.width !== nextSize.width ||
        previousSize.height !== nextSize.height));

  if (full) return fullDamage(previous, next);

  const maxSpans = Math.max(1, Math.floor(options.maxSpansPerLine ?? DEFAULT_MAX_SPANS));
  const lines: DamageLine[] = [];
  const count = Math.max(previous.length, next.length);
  for (let y = 0; y < count; y++) {
    const spans = diffLine(previous[y], next[y], maxSpans);
    if (spans.length > 0) lines.push({ y, spans });
  }
  return { full: false, lines };
}

function fullDamage(previous: readonly Line[], next: readonly Line[]): FrameDamage {
  const count = Math.max(previous.length, next.length);
  const lines: DamageLine[] = [];
  for (let y = 0; y < count; y++) {
    lines.push({
      y,
      spans: [{ from: 0, to: Math.max(previous[y]?.length ?? 0, next[y]?.length ?? 0) }],
    });
  }
  return { full: true, lines };
}

function diffLine(
  previous: Line | undefined,
  next: Line | undefined,
  maxSpans: number
): readonly DamageSpan[] {
  if (previous === next) return [];
  const length = Math.max(previous?.length ?? 0, next?.length ?? 0);
  if (length === 0) return [];

  const runs: DamageSpan[] = [];
  let runStart = -1;
  for (let index = 0; index < length; index++) {
    const changed = !cellsEqual(previous?.[index], next?.[index]);
    if (changed && runStart === -1) runStart = index;
    if ((!changed || index === length - 1) && runStart !== -1) {
      const end = changed ? index + 1 : index;
      runs.push({ from: runStart, to: end });
      runStart = -1;
    }
  }

  const expanded: DamageSpan[] = [];
  for (const run of runs) {
    const span = expandGrapheme(previous, next, run, length);
    const previousSpan = expanded[expanded.length - 1];
    if (previousSpan && span.from <= previousSpan.to) {
      expanded[expanded.length - 1] = {
        from: previousSpan.from,
        to: Math.max(previousSpan.to, span.to),
      };
    } else {
      expanded.push(span);
    }
  }

  if (expanded.length > maxSpans) return [{ from: 0, to: length }];
  return expanded;
}

function expandGrapheme(
  previous: Line | undefined,
  next: Line | undefined,
  span: DamageSpan,
  length: number
): DamageSpan {
  let from = span.from;
  let to = span.to;

  // width=0 是宽字符后继占位；从任一侧碰到它都要扩到真实字符。
  while (from > 0 && (isZeroWidth(previous?.[from]) || isZeroWidth(next?.[from]))) {
    from--;
  }
  while (to < length && (isZeroWidth(previous?.[to]) || isZeroWidth(next?.[to]))) {
    to++;
  }

  // 如果变化从宽字符的后继 cell 开始，也把宽字符本体包进来。
  while (from > 0 && (isWide(previous?.[from - 1]) || isWide(next?.[from - 1]))) {
    from--;
  }
  return { from, to };
}

function cellsEqual(a: Cell | undefined, b: Cell | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.ch === b.ch &&
    a.width === b.width &&
    a.sgr === b.sgr &&
    a.graphic === b.graphic &&
    a.selected === b.selected
  );
}

function isZeroWidth(cell: Cell | undefined): boolean {
  return cell?.width === 0;
}

function isWide(cell: Cell | undefined): boolean {
  return (cell?.width ?? 0) > 1;
}
