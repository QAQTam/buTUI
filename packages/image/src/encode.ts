/**
 * 图片协议编码器 —— SPEC §12.1 的四条真实渲染路径 + 一条占位路径。
 *
 * 全部是**纯函数**：输入字节 / 像素，输出字符串。这样每一条协议都能用
 * 「字符串断言 + 反解」来测试，不需要真终端（SPEC §15）。
 *
 * 关于安全（SPEC §12.3）：这里输出的转义序列内容只可能来自
 *   - 我们自己生成的 base64（PNG 字节）
 *   - 数值化的颜色 / 尺寸
 * 绝不拼接未净化的用户字符串（alt 文本走的是 cell 渲染，不是转义序列）。
 */
import type { ColorDepth } from "@butui/core";

export type RGB = readonly [number, number, number];

export const BLACK: RGB = [0, 0, 0];

// ── 颜色工具 ────────────────────────────────────────────────────────────────

/** 把第 i 个像素按 alpha 混到背景色上 */
export function blend(rgba: Uint8Array, offset: number, background: RGB = BLACK): RGB {
  const a = rgba[offset + 3] / 255;
  if (a >= 1) return [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
  if (a <= 0) return background;
  return [
    Math.round(rgba[offset] * a + background[0] * (1 - a)),
    Math.round(rgba[offset + 1] * a + background[1] * (1 - a)),
    Math.round(rgba[offset + 2] * a + background[2] * (1 - a)),
  ];
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function cubeIndex(value: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < CUBE_LEVELS.length; i++) {
    const distance = Math.abs(CUBE_LEVELS[i] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** 24bit → xterm-256 调色板索引（16-255） */
export function to256([r, g, b]: RGB): number {
  const ri = cubeIndex(r);
  const gi = cubeIndex(g);
  const bi = cubeIndex(b);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeDistance =
    (CUBE_LEVELS[ri] - r) ** 2 + (CUBE_LEVELS[gi] - g) ** 2 + (CUBE_LEVELS[bi] - b) ** 2;

  // 灰阶斜坡：232 + i 对应灰度 8 + 10i
  const gray = Math.max(0, Math.min(23, Math.round((((r + g + b) / 3) - 8) / 10)));
  const grayLevel = 8 + 10 * gray;
  const grayDistance = (grayLevel - r) ** 2 + (grayLevel - g) ** 2 + (grayLevel - b) ** 2;

  return grayDistance < cubeDistance ? 232 + gray : cube;
}

const ANSI16: RGB[] = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

/** 24bit → 16 色 ANSI 索引（0-15） */
export function to16([r, g, b]: RGB): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < ANSI16.length; i++) {
    const [cr, cg, cb] = ANSI16[i];
    const distance = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export function sgrForeground(color: RGB, depth: ColorDepth): string {
  if (depth === "truecolor") return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`;
  if (depth === "256") return `\x1b[38;5;${to256(color)}m`;
  const index = to16(color);
  return index < 8 ? `\x1b[3${index}m` : `\x1b[9${index - 8}m`;
}

export function sgrBackground(color: RGB, depth: ColorDepth): string {
  if (depth === "truecolor") return `\x1b[48;2;${color[0]};${color[1]};${color[2]}m`;
  if (depth === "256") return `\x1b[48;5;${to256(color)}m`;
  const index = to16(color);
  return index < 8 ? `\x1b[4${index}m` : `\x1b[10${index - 8}m`;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

// ── Kitty graphics protocol ─────────────────────────────────────────────────

/** Kitty 单条 APC 转义序列的负载上限（协议规定 4096 字节 base64） */
export const KITTY_CHUNK = 4096;

export interface KittyOptions {
  cols: number;
  rows: number;
  /** 图片 id；同时用作 placement id，便于精确删除 */
  id?: number;
}

/**
 * Kitty graphics protocol。
 *
 * `a=T` 传输并显示，`f=100` 表示负载是 PNG（终端自己解码，我们不用转成
 * 原始像素），`C=1` 表示不移动光标 —— 这样它就是一个「叠加层」，不会打乱
 * 我们的 diff 渲染。`q=2` 抑制终端回执，避免响应字节混进输入流。
 */
export function kittySequence(png: Uint8Array, options: KittyOptions): string {
  const id = options.id ?? 1;
  const control = `a=T,f=100,q=2,C=1,c=${options.cols},r=${options.rows},i=${id},p=${id}`;
  const payload = base64(png);
  let out = "";
  for (let at = 0; at < payload.length; at += KITTY_CHUNK) {
    const chunk = payload.slice(at, at + KITTY_CHUNK);
    const last = at + KITTY_CHUNK >= payload.length;
    const params = at === 0 ? `${control},m=${last ? 0 : 1}` : `m=${last ? 0 : 1}`;
    out += `\x1b_G${params};${chunk}\x1b\\`;
  }
  return out;
}

export function kittyDelete(id: number): string {
  return `\x1b_Ga=d,d=i,i=${id},q=2\x1b\\`;
}

// ── iTerm2 inline image ─────────────────────────────────────────────────────

export interface Iterm2Options {
  cols: number;
  rows: number;
  name?: string;
}

/**
 * iTerm2 inline image（OSC 1337）。
 *
 * 注意：这个协议**没有删除指令**，图片是画在 cell 上的。所以用它的前提是
 * 占位 cell 一直是空白 —— 重绘时先画空白 cell 再重发图片即可覆盖旧图。
 * 这是 iTerm2 路径与 Kitty 路径在 diff 渲染里唯一的行为差异。
 */
export function iterm2Sequence(png: Uint8Array, options: Iterm2Options): string {
  const name = base64(new TextEncoder().encode(options.name ?? "image.png"));
  const params = [
    "inline=1",
    `width=${options.cols}`,
    `height=${options.rows}`,
    "preserveAspectRatio=0",
    `name=${name}`,
  ].join(";");
  return `\x1b]1337;File=${params}:${base64(png)}\x07`;
}

// ── Sixel ───────────────────────────────────────────────────────────────────

export interface SixelOptions {
  background?: RGB;
}

/**
 * Sixel 编码：6×6×6 固定色立方（216 色）。
 *
 * 为什么用固定调色板而不是中位切分：确定性。测试可以逐字节反解验证，
 * 而且不需要在 TS 里做 k-means。216 色对终端里的截图 / 图表够用，
 * 对照片偏色，但照片本来就该走 Kitty / iTerm2 路径。
 */
export function sixelSequence(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: SixelOptions = {}
): string {
  const background = options.background ?? BLACK;
  const bands = Math.ceil(height / 6);
  const pixels = new Uint8Array(width * height);

  // 像素 → 调色板索引；同时记录哪些颜色真的出现过（只定义用到的颜色）
  const used = new Set<number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = blend(rgba, (y * width + x) * 4, background);
      const index = Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
      pixels[y * width + x] = index;
      used.add(index);
    }
  }

  let out = `\x1bPq"1;1;${width};${height}`;
  const order = [...used].sort((a, b) => a - b);
  for (const index of order) {
    const r = Math.floor(index / 36);
    const g = Math.floor((index % 36) / 6);
    const b = index % 6;
    out += `#${index};2;${Math.round((r * 100) / 5)};${Math.round((g * 100) / 5)};${Math.round(
      (b * 100) / 5
    )}`;
  }

  const column = new Uint8Array(width);
  for (let band = 0; band < bands; band++) {
    const bandPixels = order.filter(index => {
      for (let y = band * 6; y < Math.min(height, band * 6 + 6); y++) {
        for (let x = 0; x < width; x++) {
          if (pixels[y * width + x] === index) return true;
        }
      }
      return false;
    });

    for (let c = 0; c < bandPixels.length; c++) {
      const index = bandPixels[c];
      for (let x = 0; x < width; x++) {
        let mask = 0;
        for (let bit = 0; bit < 6; bit++) {
          const y = band * 6 + bit;
          if (y < height && pixels[y * width + x] === index) mask |= 1 << bit;
        }
        column[x] = mask;
      }
      out += `#${index}`;
      // 行程编码：连续相同的列合并成 !count<char>
      let x = 0;
      while (x < width) {
        const value = column[x];
        let run = 1;
        while (x + run < width && column[x + run] === value) run++;
        const char = String.fromCharCode(63 + value);
        out += run > 3 ? `!${run}${char}` : char.repeat(run);
        x += run;
      }
      if (c < bandPixels.length - 1) out += "$";
    }
    if (band < bands - 1) out += "-";
  }

  return `${out}\x1b\\`;
}

// ── Unicode half-block ──────────────────────────────────────────────────────

export interface HalfBlockOptions {
  depth?: ColorDepth;
  background?: RGB;
  /** 半透明像素（alpha < 128）是否留空；默认混到背景色 */
  transparent?: boolean;
}

/**
 * 半块图：每个字符位画上下两个像素。
 *
 * `▀` 的前景覆盖上半格、背景覆盖下半格 —— 一个 cell 承载两个像素，
 * 于是 1:2 的 cell 高宽比刚好被抵消，图片不会被拉长。
 */
export function halfblockLines(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: HalfBlockOptions = {}
): string[] {
  const depth = options.depth ?? "truecolor";
  const background = options.background ?? BLACK;
  const rows = Math.ceil(height / 2);
  const lines: string[] = [];

  for (let row = 0; row < rows; row++) {
    let line = "";
    let pending = "";
    let lastKey: string | undefined;

    for (let x = 0; x < width; x++) {
      const topOffset = (row * 2 * width + x) * 4;
      const bottomY = row * 2 + 1;
      const bottomOffset = (bottomY * width + x) * 4;

      const topAlpha = rgba[topOffset + 3];
      const bottomAlpha = bottomY < height ? rgba[bottomOffset + 3] : 0;
      if (options.transparent && topAlpha < 128 && bottomAlpha < 128) {
        if (pending) {
          line += pending;
          pending = "";
          lastKey = undefined;
        }
        line += " ";
        continue;
      }

      const top = blend(rgba, topOffset, background);
      const bottom =
        bottomY < height ? blend(rgba, bottomOffset, background) : background;
      const key = `${top[0]},${top[1]},${top[2]}/${bottom[0]},${bottom[1]},${bottom[2]}`;
      if (key !== lastKey) {
        if (pending) line += pending;
        pending = sgrForeground(top, depth) + sgrBackground(bottom, depth);
        lastKey = key;
      }
      pending += "▀";
    }
    if (pending) line += pending;
    lines.push(line + "\x1b[0m");
  }
  return lines;
}

// ── 纯文本占位符 ────────────────────────────────────────────────────────────

export interface PlaceholderOptions {
  cols: number;
  rows: number;
  text?: string;
}

/**
 * 纯文本占位符：不依赖任何颜色能力，NO_COLOR / dumb 终端的兜底。
 * 只画边框 + alt 文本，绝不把内容拼进 shell，也不回显未知转义。
 */
export function placeholderLines(options: PlaceholderOptions): string[] {
  const cols = Math.max(4, Math.round(options.cols));
  const rows = Math.max(3, Math.round(options.rows));
  const label = (options.text ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();

  const inner = cols - 2;
  const lines: string[] = [`┌${"─".repeat(inner)}┐`];
  const middle = rows - 2;
  const labelRow = Math.floor(middle / 2);
  for (let i = 0; i < middle; i++) {
    let text = "";
    // 只要中间还有行，就把标签放在正中间那一行（3 行的框也要显示得下）
    if (middle >= 1 && i === labelRow) {
      text = label.length > inner - 2 ? `${label.slice(0, Math.max(0, inner - 3))}…` : label;
    }
    const pad = Math.max(0, inner - text.length);
    const left = Math.floor(pad / 2);
    lines.push(`│${" ".repeat(left)}${text}${" ".repeat(pad - left)}│`);
  }
  lines.push(`└${"─".repeat(inner)}┘`);
  return lines;
}
