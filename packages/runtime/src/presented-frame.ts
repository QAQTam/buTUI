/**
 * PresentedFrameStore —— v0.2 鼠标路由的视觉真相。
 *
 * 鼠标坐标只对用户已经看到的帧有意义。这里缓存最新 presented frame，并懒构建
 * node / semantic 的 hit test 与 bounds 索引；它不拥有节点树，也不决定事件如何
 * 冒泡，只回答“屏幕上的这个坐标在那一帧属于谁”。
 */
import type { Frame, Line } from "@butui/layout";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HitResult {
  nodeId?: number;
  semantic?: string;
  bounds?: Rect;
  localX?: number;
  localY?: number;
}

export interface PresentedFrame {
  frameId: number;
  sessionRevision: number;
  presentedAt: number;
  layout: Frame;
  index: PresentedFrameIndex;
}

export interface PresentedFrameIndex {
  hit(x: number, y: number): HitResult | undefined;
  boundsOf(nodeId: number): Rect | undefined;
  semanticBounds(semantic: string): Rect | undefined;
}

export class PresentedFrameStore {
  private nextFrameId = 1;
  private currentFrame: PresentedFrame | undefined;

  present(
    layout: Frame,
    sessionRevision: number,
    presentedAt = performance.now()
  ): PresentedFrame {
    const frame: PresentedFrame = {
      frameId: this.nextFrameId++,
      sessionRevision,
      presentedAt,
      layout,
      index: createFrameIndex(layout),
    };
    this.currentFrame = frame;
    return frame;
  }

  current(): PresentedFrame | undefined {
    return this.currentFrame;
  }

  invalidate(): void {
    this.currentFrame = undefined;
  }

  hit(x: number, y: number): HitResult | undefined {
    return this.currentFrame?.index.hit(x, y);
  }
}

export function createFrameIndex(frame: Frame): PresentedFrameIndex {
  let nodeBoundsCache: Map<number, Rect> | undefined;
  let semanticBoundsCache: Map<string, Rect> | undefined;

  return {
    hit(x, y) {
      const line = frame.lines[y];
      if (!line) return undefined;
      const cell = cellAt(line, x);
      if (!cell) return undefined;

      const bounds =
        cell.node === undefined
          ? undefined
          : (nodeBoundsCache ??= collectNodeBounds(frame)).get(cell.node);
      return {
        ...(cell.node !== undefined ? { nodeId: cell.node } : {}),
        ...(cell.semantic !== undefined ? { semantic: cell.semantic } : {}),
        ...(bounds ? { bounds, localX: x - bounds.x, localY: y - bounds.y } : {}),
      };
    },
    boundsOf(nodeId) {
      return (nodeBoundsCache ??= collectNodeBounds(frame)).get(nodeId);
    },
    semanticBounds(semantic) {
      return (semanticBoundsCache ??= collectSemanticBounds(frame)).get(semantic);
    },
  };
}

function cellAt(line: Line, x: number) {
  if (x < 0) return undefined;
  let used = 0;
  for (const cell of line) {
    if (used === x || (cell.width > 0 && used + cell.width > x)) return cell;
    used += cell.width;
  }
  return line[line.length - 1];
}

function collectNodeBounds(frame: Frame): Map<number, Rect> {
  const bounds = new Map<number, Rect>();
  forEachVisibleCell(frame, (cell, x, y, width) => {
    expand(bounds, cell.node, x, y, width);
  });
  return bounds;
}

function collectSemanticBounds(frame: Frame): Map<string, Rect> {
  const bounds = new Map<string, Rect>();
  forEachVisibleCell(frame, (cell, x, y, width) => {
    if (cell.semantic !== undefined) expand(bounds, cell.semantic, x, y, width);
  });
  return bounds;
}

function forEachVisibleCell(
  frame: Frame,
  visit: (
    cell: Line[number],
    x: number,
    y: number,
    width: number
  ) => void
): void {
  for (let y = 0; y < frame.lines.length; y++) {
    const line = frame.lines[y];
    if (!line) continue;
    let x = 0;
    for (const cell of line) {
      if (cell.width > 0) visit(cell, x, y, cell.width);
      x += cell.width;
    }
  }
}

function expand<T>(
  bounds: Map<T, Rect>,
  key: T,
  x: number,
  y: number,
  width: number
): void {
  const previous = bounds.get(key);
  if (!previous) {
    bounds.set(key, { x, y, width, height: 1 });
    return;
  }
  const minX = Math.min(previous.x, x);
  const minY = Math.min(previous.y, y);
  const maxX = Math.max(previous.x + previous.width, x + width);
  const maxY = Math.max(previous.y + previous.height, y + 1);
  previous.x = minX;
  previous.y = minY;
  previous.width = maxX - minX;
  previous.height = maxY - minY;
}
