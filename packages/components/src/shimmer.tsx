/**
 * `<Shimmer>` —— 单行状态文本的高亮扫过效果。
 *
 * 默认按 word 分段，适合 "thinking..." / 工具状态；`cell` 只用于确实需要逐
 * grapheme 的窄状态行。组件只改颜色，不改变文本宽度或行数。
 */
import {
  type AnimationScheduler,
  interpolateTween,
  prefersReducedMotion,
  useAnimationFrame,
} from "@butui/solid";
import { Repeat } from "solid-js";
import {
  type ShimmerGranularity,
  type ShimmerSegment,
  shimmerSegments,
} from "./shimmer.ts";

export interface ShimmerProps {
  /** 要显示的文本；也可以用字符串 children */
  text?: string;
  children?: string;
  active?: boolean;
  granularity?: ShimmerGranularity;
  /** 一次完整扫过的毫秒数，默认 1400 */
  period?: number;
  /** 高亮带宽度（cell），默认 6 */
  highlightWidth?: number;
  /** 受控相位 0..1；给了就不订阅动画时钟 */
  phase?: number;
  baseColor?: string;
  highlightColor?: string;
  /** 测试 / 嵌入方注入调度器 */
  scheduler?: AnimationScheduler;
  /** 测试 / 嵌入方覆盖 reduced-motion 检测 */
  reducedMotion?: boolean;
  wrap?: boolean;
  semantic?: string;
}

export function Shimmer(props: ShimmerProps) {
  const content = (): string => props.text ?? props.children ?? "";
  const period = (): number => Math.max(1, props.period ?? 1400);
  const reduced = (): boolean => props.reducedMotion ?? prefersReducedMotion();
  const animated = (): boolean =>
    props.active !== false && props.phase === undefined && !reduced() && content() !== "";
  const time = useAnimationFrame({
    enabled: animated,
    ...(props.scheduler ? { scheduler: props.scheduler } : {}),
  });
  const phase = (): number => {
    const value = props.phase ?? (time() / period()) % 1;
    return ((value % 1) + 1) % 1;
  };
  const segments = (): ShimmerSegment[] =>
    shimmerSegments(content(), {
      granularity: props.granularity ?? "word",
      phase: phase(),
      highlightWidth: props.highlightWidth ?? 6,
      active: props.active !== false && !reduced(),
    });
  const base = (): string => props.baseColor ?? "muted";
  const highlight = (): string => props.highlightColor ?? "accent";
  const color = (segment: ShimmerSegment): string => {
    if (segment.intensity <= 0) return base();
    if (segment.intensity >= 1) return highlight();
    return interpolateTween(base(), highlight(), segment.intensity);
  };

  return (
    <text
      color={base()}
      wrap={props.wrap ?? false}
      semantic={props.semantic ?? "shimmer"}
    >
      <Repeat count={segments().length}>
        {index => {
          const segment = (): ShimmerSegment | undefined => segments()[index];
          return (
            <text color={segment() ? color(segment()!) : base()}>
              {segment()?.text ?? ""}
            </text>
          );
        }}
      </Repeat>
    </text>
  );
}
