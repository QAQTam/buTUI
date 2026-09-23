/**
 * 渲染器 —— SPEC §6 的 `@butui/renderer`。
 *
 * 职责：把 layout 产出的 cell 网格差分成最小 ANSI 输出。
 *
 * 关键点（SPEC §17「流式输出不整屏闪烁」）：
 *   逐行比较，只重发变化的行；行内用 SGR 状态机避免逐 cell 重复发转义序列。
 *   流式文本变化只影响 1~2 行 → 只发 1~2 行。
 */
import type { Cell, Frame, Line } from "@butui/layout";

export interface FrameWriter {
  (chunk: string): void;
}

export interface RenderStats {
  /** 重绘的行数 */
  changedLines: number;
  /** 重绘的行号（原生图形图层用它判断要不要重放图片） */
  changed: number[];
  /** 实际写出的字节数 */
  bytes: number;
  /** 是否整屏重绘（尺寸变化 / 首次绘制） */
  full: boolean;
}

/**
 * 渲染钩子。
 *
 * `afterDraw` 在文字差分之后、写终端之前调用，返回值会被拼进同一批写入。
 * 原生图片协议（Kitty / iTerm2 / Sixel）靠它挂到网格之上，而渲染器本身
 * 不需要知道任何图片协议的存在 —— 这是 SPEC §6 分层的关键：renderer 依赖
 * layout，不依赖 image。
 */
export interface RenderHooks {
  /**
   * 返回值会被拼进同一批写入；返回 `undefined` / `""` 表示只做观察
   * （比如滚动视口把当前帧的 top/total 收回去）。
   */
  afterDraw?(frame: Frame, stats: RenderStats): string | void;
}

const ESC = "\x1b[";
export const CURSOR_HOME = `${ESC}H`;
export const CLEAR_SCREEN = `${ESC}2J`;
export const ERASE_TO_END = `${ESC}K`;
export const RESET = `${ESC}0m`;

/** 光标绝对定位，1-based */
export function moveTo(row: number, column = 1): string {
  return `${ESC}${row + 1};${column}H`;
}

function cellsEqual(a: Line | undefined, b: Line | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.ch !== y.ch || x.sgr !== y.sgr || x.graphic !== y.graphic) return false;
    if (x.selected !== y.selected) return false;
  }
  return true;
}

/** 一行 cell → ANSI 字符串（含 SGR 状态机） */
export function paintLine(line: Line): string {
  let out = "";
  let currentSgr = "";
  let inverse = false;
  for (const cell of line) {
    if (cell.width === 0) continue; // 宽字符的后继占位，不重复输出
    if (cell.sgr !== currentSgr) {
      // 换基础样式前先关掉选区反显；RESET 也会把它关掉。
      if (inverse) out += "\x1b[27m";
      out += cell.sgr || RESET;
      currentSgr = cell.sgr;
      inverse = false;
    }
    const selected = cell.selected === true;
    if (selected !== inverse) {
      out += selected ? "\x1b[7m" : "\x1b[27m";
      inverse = selected;
    }
    out += cell.ch;
  }
  if (inverse) out += "\x1b[27m";
  if (currentSgr !== "") out += RESET;
  return out;
}

/**
 * 供测试与 WebUI adapter 使用的纯文本视图。
 *
 * 尾部整行空白会被去掉 —— 帧本身仍是 width×height 的完整网格，这里只是让
 * 快照断言不被补白行淹没。
 */
export function plainText(frame: Frame): string {
  const lines = frame.lines.map(line =>
    line.map((c: Cell) => (c.width === 0 ? "" : c.ch)).join("").replace(/\s+$/, "")
  );
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end).join("\n");
}

export class Renderer {
  private previous: Line[] = [];
  private width = 0;
  private height = 0;

  constructor(private readonly write: FrameWriter, private readonly hooks?: RenderHooks) {}

  /** 输出一帧，返回本次差分统计 */
  draw(frame: Frame): RenderStats {
    const full = this.previous.length === 0 || this.width !== frame.width || this.height !== frame.height;
    let out = "";
    const changed: number[] = [];

    if (full) {
      out += CLEAR_SCREEN + CURSOR_HOME;
    }

    for (let y = 0; y < frame.lines.length; y++) {
      const line = frame.lines[y];
      if (!full && cellsEqual(this.previous[y], line)) continue;
      changed.push(y);
      out += moveTo(y, 0) + paintLine(line) + ERASE_TO_END;
    }

    // 帧变矮：把残留行清掉
    if (frame.lines.length < this.previous.length) {
      for (let y = frame.lines.length; y < this.previous.length; y++) {
        out += moveTo(y, 0) + ERASE_TO_END;
        changed.push(y);
      }
    }

    const stats: RenderStats = {
      changedLines: changed.length,
      changed,
      bytes: out.length,
      full,
    };

    if (this.hooks?.afterDraw) {
      // 钩子可以只做观察（比如滚动视口测量位置），不必为了签名返回 ""
      const extra = this.hooks.afterDraw(frame, stats);
      if (extra) out += extra;
    }

    if (out) this.write(out);
    this.previous = frame.lines;
    this.width = frame.width;
    this.height = frame.height;
    stats.bytes = out.length;
    return stats;
  }

  /** 强制下一帧整屏重绘（resize 后调用） */
  invalidate(): void {
    this.previous = [];
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
}

/** 无副作用版本：只算差分，不写出。测试用 */
export function diffFrames(previous: Line[], next: Line[]): number[] {
  const changed: number[] = [];
  const max = Math.max(previous.length, next.length);
  for (let y = 0; y < max; y++) {
    if (!cellsEqual(previous[y], next[y])) changed.push(y);
  }
  return changed;
}
