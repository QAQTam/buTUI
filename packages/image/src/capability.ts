/**
 * 图片协议能力探测 —— SPEC §12.1 的优先级表。
 *
 *   1. Kitty graphics protocol
 *   2. iTerm2 inline image
 *   3. Sixel
 *   4. Unicode half-block / ANSI
 *   5. 纯文本占位符
 *
 * 探测只看环境变量，绝不发查询序列。理由：查询序列（DA1 / XTGETTCAP）需要
 * 读回终端响应，会跟输入解码器抢字节；而环境变量在 tmux / ssh / 容器里
 * 反而更可靠。探测错了的代价只是降级，不是崩掉（SPEC §4.4）。
 */
import type { ColorDepth } from "@butui/core";

export type ImageProtocol = "kitty" | "iterm2" | "sixel" | "halfblock" | "placeholder" | "none";

/** SPEC §12.1 的顺序，数值越小优先级越高 */
export const PROTOCOL_PRIORITY: readonly ImageProtocol[] = [
  "kitty",
  "iterm2",
  "sixel",
  "halfblock",
  "placeholder",
];

export interface ImageEnv {
  TERM?: string | undefined;
  TERM_PROGRAM?: string | undefined;
  TERM_PROGRAM_VERSION?: string | undefined;
  KITTY_WINDOW_ID?: string | undefined;
  GHOSTTY_RESOURCES_DIR?: string | undefined;
  WEZTERM_PANE?: string | undefined;
  WT_SESSION?: string | undefined;
  KONSOLE_VERSION?: string | undefined;
  XTERM_VERSION?: string | undefined;
  VTE_VERSION?: string | undefined;
  LC_TERMINAL?: string | undefined;
  COLORTERM?: string | undefined;
  NO_COLOR?: string | undefined;
  TMUX?: string | undefined;
  STY?: string | undefined;
  BUTUI_IMAGE_PROTOCOL?: string | undefined;
}

export interface ProtocolSupport {
  kitty: boolean;
  iterm2: boolean;
  sixel: boolean;
  /** 处于 tmux / screen 之下；原生协议需要透传，默认按不支持处理 */
  multiplexed: boolean;
}

const has = (v: string | undefined): boolean => v !== undefined && v !== "";

export function detectProtocolSupport(env: ImageEnv = process.env as ImageEnv): ProtocolSupport {
  const term = (env.TERM ?? "").toLowerCase();
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();

  const multiplexed = has(env.TMUX) || has(env.STY);

  // ── Kitty ────────────────────────────────────────────────────────────────
  // KITTY_WINDOW_ID 是 Kitty 自己注入的，最可靠；ghostty / konsole 也实现了
  // kitty 图形协议的一个子集（konsole 从 22.04 起支持 kitty 图形）。
  const kitty =
    !multiplexed &&
    (has(env.KITTY_WINDOW_ID) ||
      term.includes("kitty") ||
      has(env.GHOSTTY_RESOURCES_DIR) ||
      program === "ghostty" ||
      (has(env.KONSOLE_VERSION) && Number(env.KONSOLE_VERSION) >= 220400));

  // ── iTerm2 inline image ──────────────────────────────────────────────────
  // VS Code 内置终端从 1.80 起实现 OSC 1337；WezTerm 也实现了。
  const iterm2 =
    !multiplexed &&
    (program === "iterm.app" ||
      program === "wezterm" ||
      program === "vscode" ||
      has(env.WEZTERM_PANE) ||
      (env.LC_TERMINAL ?? "").toLowerCase() === "iterm2");

  // ── Sixel ────────────────────────────────────────────────────────────────
  // xterm 的 sixel 是编译期开关，光看 TERM 不可靠，只认明确自报家门的。
  const sixel =
    term.includes("sixel") ||
    ["mintty", "contour", "foot", "mlterm", "yaft", "wezterm", "ghostty"].some(
      p => program === p || term.includes(p)
    ) ||
    // VTE 3.79（GNOME 46）起支持 sixel
    (has(env.VTE_VERSION) && Number(env.VTE_VERSION) >= 7800);

  return { kitty, iterm2, sixel, multiplexed };
}

export interface PickProtocolOptions {
  /** 强制指定协议（测试 / 用户覆盖 / SPEC §12.3 的显式授权） */
  force?: ImageProtocol | undefined;
  depth?: ColorDepth | undefined;
  env?: ImageEnv | undefined;
}

/**
 * 按 SPEC §12.1 的优先级选出当前终端实际可用的协议。
 *
 * `depth` 只用来判断 **cell 降级路径**是否成立：半块图完全依赖 24bit / 256 色，
 * 所以 `depth === "none"`（NO_COLOR / TERM=dumb）时直接降到纯文本占位符。
 * 原生协议不受影响 —— Kitty / iTerm2 / Sixel 画的是真像素，不经过调色板。
 */
export function pickProtocol(options: PickProtocolOptions = {}): ImageProtocol {
  const env = options.env ?? (process.env as ImageEnv);
  if (options.force) return options.force;

  const depth = options.depth ?? "truecolor";
  const support = detectProtocolSupport(env);

  if (support.kitty) return "kitty";
  if (support.iterm2) return "iterm2";
  if (support.sixel) return "sixel";
  if (depth === "truecolor" || depth === "256") return "halfblock";
  return "placeholder";
}

/** 协议是否走「原生图形」路径（终端自己画像素，不进 cell 网格） */
export function isNativeProtocol(protocol: ImageProtocol): boolean {
  return protocol === "kitty" || protocol === "iterm2" || protocol === "sixel";
}
