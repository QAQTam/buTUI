import { describe, expect, test } from "bun:test";
import type { Cell, Frame, Line } from "@butui/layout";
import {
  PresentedFrameStore,
  createFrameIndex,
} from "../packages/runtime/src/presented-frame.ts";

function cell(
  ch: string,
  node: number,
  semantic?: string,
  width = 1
): Cell {
  return { ch, width, node, sgr: "", ...(semantic ? { semantic } : {}) };
}

function line(...cells: Cell[]): Line {
  return cells;
}

function frame(lines: Line[]): Frame {
  const width = Math.max(...lines.map(value => value.reduce((sum, c) => sum + c.width, 0)));
  return {
    lines,
    width,
    height: lines.length,
    top: 0,
    total: lines.length,
    nodeAt(x, y) {
      return lines[y]?.[x]?.node;
    },
    semanticAt(x, y) {
      return lines[y]?.[x]?.semantic;
    },
    text() {
      return lines.map(value => value.map(c => c.ch).join("")).join("\n");
    },
  };
}

describe("PresentedFrameStore", () => {
  test("hit test 返回 node / semantic / bounds / local 坐标", () => {
    const layout = frame([
      line(cell("a", 1, "message:m1"), cell("b", 1, "message:m1"), cell("c", 2, "tool:t1"), cell("d", 2, "tool:t1")),
      line(cell("e", 3, "status:s1"), cell("f", 3, "status:s1")),
    ]);
    const store = new PresentedFrameStore();
    const presented = store.present(layout, 7, 100);

    expect(presented.frameId).toBe(1);
    expect(presented.sessionRevision).toBe(7);
    expect(store.hit(1, 0)).toEqual({
      nodeId: 1,
      semantic: "message:m1",
      bounds: { x: 0, y: 0, width: 2, height: 1 },
      localX: 1,
      localY: 0,
    });
    expect(store.hit(2, 0)).toEqual({
      nodeId: 2,
      semantic: "tool:t1",
      bounds: { x: 2, y: 0, width: 2, height: 1 },
      localX: 0,
      localY: 0,
    });
  });

  test("bounds 索引跨行合并，semantic 独立索引", () => {
    const layout = frame([
      line(cell("a", 1, "card:c1")),
      line(cell("b", 1, "card:c1"), cell("c", 2, "other")),
    ]);
    const index = createFrameIndex(layout);

    expect(index.boundsOf(1)).toEqual({ x: 0, y: 0, width: 1, height: 2 });
    expect(index.semanticBounds("card:c1")).toEqual({ x: 0, y: 0, width: 1, height: 2 });
    expect(index.boundsOf(99)).toBeUndefined();
  });

  test("present 会替换 current，invalidate 清空视觉真相", () => {
    const store = new PresentedFrameStore();
    const first = store.present(
      frame([line(cell("a", 1, "old"))]),
      1,
      10
    );
    const second = store.present(
      frame([line(cell("b", 2, "new"))]),
      2,
      20
    );

    expect(second.frameId).toBe(first.frameId + 1);
    expect(store.current()?.frameId).toBe(second.frameId);
    expect(store.hit(0, 0)?.semantic).toBe("new");

    store.invalidate();
    expect(store.current()).toBeUndefined();
    expect(store.hit(0, 0)).toBeUndefined();
  });

  test("越界坐标不伪造 hit", () => {
    const store = new PresentedFrameStore();
    store.present(frame([line(cell("a", 1))]), 1, 0);

    expect(store.hit(-1, 0)).toBeUndefined();
    expect(store.hit(0, 2)).toBeUndefined();
  });
});
