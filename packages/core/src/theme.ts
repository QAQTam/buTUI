/**
 * 主题 token（SPEC §14「theme tokens」）。
 *
 * 组件只允许引用 token 名，不硬编码颜色 —— 这样终端能力降级（truecolor →
 * 256 → 16 → 无色）只发生在这一层。
 */

export interface Theme {
  fg: string;
  bg: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  border: string;
  focus: string;
  user: string;
  assistant: string;
  tool: string;
  reasoning: string;
}

export const darkTheme: Theme = {
  fg: "#e2e8f0",
  bg: "#0f172a",
  muted: "#94a3b8",
  accent: "#7dd3fc",
  success: "#4ade80",
  warning: "#facc15",
  danger: "#f87171",
  border: "#334155",
  focus: "#38bdf8",
  user: "#f472b6",
  assistant: "#a3e635",
  tool: "#94a3b8",
  reasoning: "#c084fc",
};

export const lightTheme: Theme = {
  fg: "#1e293b",
  bg: "#f8fafc",
  muted: "#64748b",
  accent: "#0284c7",
  success: "#16a34a",
  warning: "#ca8a04",
  danger: "#dc2626",
  border: "#cbd5e1",
  focus: "#0284c7",
  user: "#db2777",
  assistant: "#65a30d",
  tool: "#64748b",
  reasoning: "#9333ea",
};

export const noColorTheme: Theme = Object.fromEntries(
  Object.keys(darkTheme).map(k => [k, "default"])
) as unknown as Theme;

let active: Theme = darkTheme;

export function setTheme(theme: Theme): void {
  active = theme;
}

export function theme(): Theme {
  return active;
}

export type ColorDepth = "truecolor" | "256" | "16" | "none";

/**
 * token 名 → ANSI SGR。用 Bun.color 做转换（SPEC §5.1）。
 * 非法 token（不是已知主题键、也不是颜色字面量）会被忽略，避免污染输出。
 */
export type ColorLayer = "fg" | "bg";

/**
 * 前景序列 → 背景序列。
 *
 * `Bun.color` 只产出前景（`\x1b[38;...m`），没有背景变体，所以背景色要把
 * `38;` 换成 `48;`。少了这一步，`bg="..."` 会被当成前景色画出来 —— 看着
 * 「有颜色」，其实完全不是想要的效果。
 */
function toBackground(sgr: string): string {
  return sgr.replace(/\x1b\[38;/g, "\x1b[48;");
}

export function resolveColor(value: unknown, depth: ColorDepth, layer: ColorLayer = "fg"): string {
  if (typeof value !== "string") return "";
  if (depth === "none" || value === "default") return "";
  const named = (active as unknown as Record<string, string>)[value] ?? value;
  const format = depth === "truecolor" ? "ansi-16m" : depth === "256" ? "ansi-256" : "ansi-16";
  const sgr = Bun.color(named, format) ?? "";
  return layer === "bg" ? toBackground(sgr) : sgr;
}
