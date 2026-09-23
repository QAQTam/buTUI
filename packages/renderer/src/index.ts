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
  /** 实际写出的字节数 */
  bytes: number;
  /** 是否整屏重绘（尺寸变化 / 首次绘制） */
  full: boolean;
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
    if (x.ch !== y.ch || x.sgr !== y.sgr) return false;
  }
  return true;
}

/** 一行 cell → ANSI 字符串（含 SGR 状态机） */
export function paintLine(line: Line): string {
  let out = "";
  let currentSgr = "";
  for (const cell of line) {
    if (cell.width === 0) continue; // 宽字符的后继占位，不重复输出
    if (cell.sgr !== currentSgr) {
      out += cell.sgr || RESET;
      currentSgr = cell.sgr;
    }
    out += cell.ch;
  }
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

  constructor(private readonly write: FrameWriter) {}

  /** 输出一帧，返回本次差分统计 */
  draw(frame: Frame): RenderStats {
    const full = this.previous.length === 0 || this.width !== frame.width || this.height !== frame.height;
    let out = "";
    let changedLines = 0;

    if (full) {
      out += CLEAR_SCREEN + CURSOR_HOME;
    }

    for (let y = 0; y < frame.lines.length; y++) {
      const line = frame.lines[y];
      if (!full && cellsEqual(this.previous[y], line)) continue;
      changedLines++;
      out += moveTo(y, 0) + paintLine(line) + ERASE_TO_END;
    }

    // 帧变矮：把残留行清掉
    if (frame.lines.length < this.previous.length) {
      for (let y = frame.lines.length; y < this.previous.length; y++) {
        out += moveTo(y, 0) + ERASE_TO_END;
        changedLines++;
      }
    }

    if (out) this.write(out);
    this.previous = frame.lines;
    this.width = frame.width;
    this.height = frame.height;
    return { changedLines, bytes: out.length, full };
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
