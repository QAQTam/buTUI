/**
 * 原生图形图层 —— 把 Kitty / iTerm2 / Sixel 的图片叠到字符网格上。
 *
 * 为什么需要单独一层：cell 网格是「一个格子一个字符」，而原生图形协议画的
 * 是像素。二者必须解耦，否则要么污染 cell 模型，要么让 diff 渲染器知道协议
 * 细节。这里的契约非常窄：
 *
 *   layout 在占位 cell 上盖一个 `graphic` 标记（图片 id）
 *   → ImageLayer 扫描当前帧，把同一个 id 的 cell 聚成一个矩形
 *   → 只有当矩形所在行被重绘、或矩形本身移动时才重新发一次图形序列
 *
 * 于是「滚动 / 流式输出」不会重复发送几十 KB 的 base64（SPEC §5.7 的精神：
 * 每帧成本与图片负载无关）。
 */
import type { Frame } from "@butui/layout";
import type { ImageProtocol } from "./capability.ts";
import { kittyDelete } from "./encode.ts";

export interface GraphicEntry {
  protocol: ImageProtocol;
  sequence: string;
  id32: number;
}

const ESC = "\x1b[";

function moveTo(row: number, column = 1): string {
  return `${ESC}${row + 1};${column + 1}H`;
}

interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export class ImageLayer {
  private readonly graphics = new Map<string, GraphicEntry>();
  private readonly placed = new Map<string, string>();

  register(id: string, entry: GraphicEntry): void {
    const previous = this.graphics.get(id);
    if (previous && previous.sequence === entry.sequence) return;
    this.graphics.set(id, entry);
    // 序列变了（重新渲染 / resize）→ 下一帧强制重放
    this.placed.delete(id);
  }

  unregister(id: string): void {
    this.graphics.delete(id);
  }

  clear(): void {
    this.graphics.clear();
    this.placed.clear();
  }

  get size(): number {
    return this.graphics.size;
  }

  /** 扫描帧，找出每个 graphic id 覆盖的矩形 */
  private rects(frame: Frame): Map<string, Rect> {
    const rects = new Map<string, Rect>();
    for (let y = 0; y < frame.lines.length; y++) {
      const line = frame.lines[y];
      let column = 0;
      for (const cell of line) {
        const id = cell.graphic;
        if (id !== undefined) {
          const existing = rects.get(id);
          if (existing) {
            if (y < existing.top) existing.top = y;
            if (y > existing.bottom) existing.bottom = y;
            if (column < existing.left) existing.left = column;
            if (column > existing.right) existing.right = column;
          } else {
            rects.set(id, { top: y, left: column, right: column, bottom: y });
          }
        }
        column += cell.width === 0 ? 0 : cell.width;
      }
    }
    return rects;
  }

  /**
   * 产出本帧要写的图形序列（渲染器在文字差分之后调用）。
   *
   * `changed` 是被重绘的行号列表 —— 图片区域与它相交就必须重放，因为文字
   * 重绘会把底下的图片擦掉（Kitty 的叠加是终端的独立图层，但滚动 / 清行
   * 之后位置会错；iTerm2 / Sixel 则是真的画在 cell 上）。
   */
  render(frame: Frame, changed: readonly number[]): string {
    const rects = this.rects(frame);
    let out = "";

    // 已经不在帧里的图片：Kitty 能精确删除，其它协议只能靠占位 cell 被重绘擦掉
    for (const id of [...this.placed.keys()]) {
      if (rects.has(id)) continue;
      this.placed.delete(id);
      const graphic = this.graphics.get(id);
      if (graphic?.protocol === "kitty") out += kittyDelete(graphic.id32);
    }

    for (const [id, rect] of rects) {
      const graphic = this.graphics.get(id);
      if (!graphic) continue;

      const key = `${rect.top},${rect.left},${rect.right},${rect.bottom}`;
      const moved = this.placed.get(id) !== key;
      const touched = changed.some(y => y >= rect.top && y <= rect.bottom);
      if (!moved && !touched) continue;

      this.placed.set(id, key);
      // Kitty：先按 image id 删掉旧 placement，避免同一位置叠出多张
      if (graphic.protocol === "kitty") out += kittyDelete(graphic.id32);
      out += moveTo(rect.top, rect.left) + graphic.sequence;
    }

    return out;
  }
}
