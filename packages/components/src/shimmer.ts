/**
 * Shimmer 的纯分段模型。
 *
 * 组件不直接扫描整行 cell；它只把文本切成 grapheme / word，按离高亮中心的
 * 距离计算 intensity。这样 shimmer 的带宽和速度可测，也不会改变文本宽度。
 */
export type ShimmerGranularity = "line" | "word" | "cell";

export interface ShimmerSegment {
  text: string;
  /** 相对行首的显示列 */
  start: number;
  width: number;
  /** 0 = 基础色，1 = 高亮色 */
  intensity: number;
}

export interface ShimmerSegmentsOptions {
  granularity?: ShimmerGranularity;
  /** 0..1，高亮从左到右扫过 */
  phase?: number;
  /** 高亮带宽度（cell），默认 6 */
  highlightWidth?: number;
  /** false 时所有 segment 都回到基础色 */
  active?: boolean;
}

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/** 返回保持原文顺序、可直接拼接回原文的分段。 */
export function shimmerSegments(
  text: string,
  options: ShimmerSegmentsOptions = {}
): ShimmerSegment[] {
  if (text === "") return [];
  const granularity = options.granularity ?? "word";
  const active = options.active ?? true;
  const phase = ((options.phase ?? 0) % 1 + 1) % 1;
  const band = Math.max(1, options.highlightWidth ?? 6);

  const pieces =
    granularity === "line"
      ? [{ segment: text }]
      : [...(granularity === "cell" ? GRAPHEME_SEGMENTER : WORD_SEGMENTER).segment(text)];
  const total = pieces.reduce(
    (sum, piece) => sum + Math.max(1, Bun.stringWidth(piece.segment)),
    0
  );
  const center = -band + phase * (total + band * 2);

  let cursor = 0;
  return pieces.map(piece => {
    const width = Math.max(1, Bun.stringWidth(piece.segment));
    const start = cursor;
    cursor += width;
    if (!active) return { text: piece.segment, start, width, intensity: 0 };
    if (granularity === "line") {
      const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
      return { text: piece.segment, start, width, intensity: pulse };
    }
    const distance = Math.abs(start + width / 2 - center);
    return {
      text: piece.segment,
      start,
      width,
      intensity: smoothstep(1 - distance / band),
    };
  });
}
