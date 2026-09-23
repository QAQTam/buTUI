/**
 * 展示类基础组件 —— SPEC §10.1 里「不需要交互状态」的那一半。
 *
 * `ProgressBar` / `Spinner` / `Badge` / `Divider` / `KeyHint`。
 *
 * 共同约定：
 *   - 颜色只写主题 token（`accent` / `success` / `warning` / `danger` / `muted`）
 *   - 尺寸只写 cell 数，不写百分比（这些组件本来就该跟着父容器走）
 *   - 不自己开定时器，除非显式要求（`Spinner` 的 `active`）—— 需要驱动的
 *     动画由调用方给 `phase` / `frame`，这样渲染时机仍然可控
 */
import type { Node } from "@butui/core";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show, createEffect, createSignal } from "solid-js";

const FILLED = "█";
const EMPTY = "░";

export interface ProgressBarProps {
  /** 进度：`max` 给了就是 `value/max`，否则按 0..1 */
  value: number;
  max?: number;
  /** 条宽（cell），默认 20 */
  width?: number;
  color?: string;
  trackColor?: string;
  /** 右侧显示百分比 */
  showPercent?: boolean;
  /** 前面加一段说明文字 */
  label?: string;
  /**
   * 不确定进度（安装中 / 等待响应）。
   *
   * 给 `phase`（0..1）就是一个固定位置的滑块；不给则由调用方自己驱动 ——
   * 这里不偷偷开定时器，免得「谁在重绘」变得不可追踪。
   */
  indeterminate?: boolean;
  phase?: number;
}

export function ProgressBar(props: ProgressBarProps) {
  const barWidth = (): number => Math.max(1, Math.floor(props.width ?? 20));
  const ratio = (): number => {
    const raw = props.max !== undefined && props.max !== 0 ? props.value / props.max : props.value;
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  };
  /** 滑块宽度：不确定进度时占 1/4（至少 1 格） */
  const blockWidth = (): number =>
    props.indeterminate ? Math.max(1, Math.round(barWidth() / 4)) : Math.round(ratio() * barWidth());
  const blockStart = (): number => {
    if (!props.indeterminate) return 0;
    const travel = Math.max(0, barWidth() - blockWidth());
    const phase = props.phase ?? 0;
    return Math.round((((phase % 1) + 1) % 1) * travel);
  };
  const color = (): string => {
    if (props.color) return props.color;
    const r = ratio();
    if (props.indeterminate) return "accent";
    if (r >= 0.9) return "danger";
    if (r >= 0.7) return "warning";
    return "success";
  };
  const percent = (): string => `${Math.round(ratio() * 100)}%`;

  return (
    <row gap={1}>
      <Show when={props.label}>
        <text color="muted">{props.label}</text>
      </Show>
      <text color={color()}>
        {EMPTY.repeat(blockStart())}
        {FILLED.repeat(blockWidth())}
        {EMPTY.repeat(Math.max(0, barWidth() - blockStart() - blockWidth()))}
      </text>
      <Show when={props.showPercent}>
        <text color="muted">{percent()}</text>
      </Show>
    </row>
  );
}

/** 盲文点阵 spinner：宽度恒为 1，CJK 不会把行推歪 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerProps {
  /** 受控帧号（给了就不自走） */
  frame?: number;
  /** 自走：默认 true。false 时停在第一帧（用于「非活跃」状态） */
  active?: boolean;
  /** 自走间隔（毫秒），默认 80 */
  interval?: number;
  label?: string;
  color?: string;
  labelColor?: string;
}

export function Spinner(props: SpinnerProps) {
  const [tick, setTick] = createSignal(0);
  const selfDriven = (): boolean => props.frame === undefined && props.active !== false;

  createEffect(
    () => selfDriven(),
    driven => {
      if (!driven) return;
      const timer = setInterval(() => setTick(n => n + 1), Math.max(16, props.interval ?? 80));
      // 同上：必须**返回**清理函数，onCleanup 在 effect 体里不会被调用
      return () => clearInterval(timer);
    }
  );

  const index = (): number => {
    const raw = props.frame ?? tick();
    return ((raw % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
  };

  return (
    <row gap={1}>
      <text color={props.color ?? (props.active === false ? "muted" : "accent")}>
        {SPINNER_FRAMES[index()]}
      </text>
      <Show when={props.label}>
        <text color={props.labelColor ?? "muted"}>{props.label}</text>
      </Show>
    </row>
  );
}

export interface BadgeProps {
  children?: JSX.Element;
  color?: string;
  bg?: string;
  bold?: boolean;
  /** 两侧的括号字符，默认 `[]` */
  brackets?: string;
  semantic?: string;
  ref?: (node: Node) => void;
}

export function Badge(props: BadgeProps) {
  const [open, close] = (() => {
    const b = props.brackets ?? "[]";
    return [b[0] ?? "[", b[1] ?? "]"];
  })();
  return (
    <text
      ref={props.ref}
      color={props.color ?? "muted"}
      bg={props.bg}
      bold={props.bold}
      semantic={props.semantic}
    >
      {open}
      {props.children}
      {close}
    </text>
  );
}

export interface DividerProps {
  /** 默认 `─` */
  char?: string;
  color?: string;
  /** 左侧标签，例如 `── 工具输出 ──` */
  label?: string;
  labelColor?: string;
  semantic?: string;
}

/**
 * 一条横线。
 *
 * 宽度**不写死**：用 `wrap={false}` 让布局层把它裁到父容器宽度 —— 组件
 * 拿不到自己的宽度，而「和父容器一样宽」正是它要的。
 */
export function Divider(props: DividerProps) {
  const char = (): string => props.char ?? "─";
  return (
    <row semantic={props.semantic}>
      <Show when={props.label}>
        <text color={props.labelColor ?? props.color ?? "border"} wrap={false}>
          {`${char()}${char()} ${props.label} `}
        </text>
      </Show>
      <text color={props.color ?? "border"} wrap={false}>
        {char().repeat(400)}
      </text>
    </row>
  );
}

export interface KeyHintProps {
  /** `[["ctrl+c", "退出"], ["tab", "切换焦点"]]` */
  hints: ReadonlyArray<readonly [string, string]>;
  keyColor?: string;
  labelColor?: string;
  separator?: string;
  semantic?: string;
}

/** 状态栏尾部的快捷键提示 */
export function KeyHint(props: KeyHintProps) {
  const separator = (): string => props.separator ?? " · ";
  return (
    <row semantic={props.semantic}>
      {props.hints.map(([key, label], i) => (
        <text>
          <Show when={i > 0}>
            <text color="muted">{separator()}</text>
          </Show>
          <text color={props.keyColor ?? "accent"}>{key}</text>
          <text color={props.labelColor ?? "muted"}>{` ${label}`}</text>
        </text>
      ))}
    </row>
  );
}
