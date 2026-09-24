import { describe, expect, test } from "bun:test";
import {
  ERASE_TO_END,
  RESET,
  Renderer,
  computeDamage,
  diffFrames,
  moveTo,
  paintLine,
} from "@butui/renderer";
import type { Cell, Line } from "@butui/layout";

const cell = (ch: string, sgr = ""): Cell => ({ ch, width: 1, node: 1, sgr });
const line = (text: string, sgr = ""): Line => [...text].map(ch => cell(ch, sgr));

describe("渲染器（SPEC §6 / §17）", () => {
  test("paintLine 只在样式变化时发 SGR", () => {
    const red = "\x1b[31m";
    const out = paintLine([...line("ab", red), ...line("cd")]);
    // 一次开启 + 一次 reset，而不是逐 cell 重复
    expect(out).toBe(`${red}ab\x1b[0mcd`);
  });

  test("宽字符的后继占位 cell 不重复输出", () => {
    const cells: Line = [
      { ch: "中", width: 2, node: 1, sgr: "" },
      { ch: "", width: 0, node: 1, sgr: "" },
      { ch: "a", width: 1, node: 1, sgr: "" },
    ];
    expect(paintLine(cells)).toBe("中a");
  });

  test("选区用反显包住文本，并在 run 边界正确关闭", () => {
    const cells = line("abcd");
    cells[1].selected = true;
    cells[2].selected = true;
    expect(paintLine(cells)).toBe("a\x1b[7mbc\x1b[27md");
  });

  test("只有选区变化也算差分", () => {
    const before = line("abc");
    const after = line("abc");
    after[1].selected = true;
    expect(diffFrames([before], [after])).toEqual([0]);
  });

  test("首帧整屏绘制，后续只重绘变化行", () => {
    let output = "";
    const renderer = new Renderer(chunk => {
      output += chunk;
    });

    const first = renderer.draw({
      lines: [line("aaa"), line("bbb")],
      width: 3,
      height: 2,
    } as never);
    expect(first.full).toBe(true);
    expect(output).toContain("aaa");

    output = "";
    const second = renderer.draw({
      lines: [line("aaa"), line("bXb")],
      width: 3,
      height: 2,
    } as never);
    expect(second.full).toBe(false);
    expect(second.changedLines).toBe(1);
    // 只定位到第 2 行发生变化的 cell，不再重画整行
    expect(output).toBe(`${moveTo(1, 2)}${RESET}X`);
  });

  test("行缩短时从正确的 1-based 列清到行尾", () => {
    let output = "";
    const renderer = new Renderer(chunk => {
      output += chunk;
    });
    renderer.draw({ lines: [line("abcd")], width: 4, height: 1 } as never);
    output = "";
    renderer.draw({ lines: [line("ab")], width: 4, height: 1 } as never);
    expect(output).toBe(`${moveTo(0, 3)}${RESET}${ERASE_TO_END}`);
  });

  test("尺寸变化触发整屏重绘", () => {
    const renderer = new Renderer(() => {});
    renderer.draw({ lines: [line("aa")], width: 2, height: 1 } as never);
    const resized = renderer.draw({ lines: [line("aa"), line("bb")], width: 2, height: 2 } as never);
    expect(resized.full).toBe(true);
  });

  test("writer 返回 false 时标记 backpressure", () => {
    let blocked = true;
    const renderer = new Renderer(() => !blocked);
    const first = renderer.draw({ lines: [line("aa")], width: 2, height: 1 } as never);
    expect(first.blocked).toBe(true);

    blocked = false;
    const second = renderer.draw({ lines: [line("bb")], width: 2, height: 1 } as never);
    expect(second.blocked).toBe(false);
  });

  test("computeDamage 返回最小 cell span，并扩展宽字符边界", () => {
    const damage = computeDamage([line("abc")], [line("aXc")]);
    expect(damage.full).toBe(false);
    expect(damage.lines).toEqual([{ y: 0, spans: [{ from: 1, to: 2 }] }]);

    const before: Line = [
      { ch: "中", width: 2, node: 1, sgr: "" },
      { ch: "", width: 0, node: 1, sgr: "" },
      { ch: "a", width: 1, node: 1, sgr: "" },
    ];
    const after: Line = [
      { ch: "中", width: 2, node: 1, sgr: "" },
      { ch: "", width: 0, node: 1, sgr: "" },
      { ch: "b", width: 1, node: 1, sgr: "" },
    ];
    expect(computeDamage([before], [after]).lines[0]?.spans).toEqual([
      { from: 2, to: 3 },
    ]);
  });

  test("尺寸变化或 span 过碎时回退 full / 整行", () => {
    const resized = computeDamage([line("a")], [line("b")], {
      previousSize: { width: 1, height: 1 },
      nextSize: { width: 2, height: 1 },
    });
    expect(resized.full).toBe(true);

    const noisy = computeDamage(
      [line("abcdefghij")],
      [line("AbCdEfGhIj")],
      { maxSpansPerLine: 2 }
    );
    expect(noisy.lines).toEqual([{ y: 0, spans: [{ from: 0, to: 10 }] }]);
  });

  test("diffFrames 报告变化行号", () => {
    expect(diffFrames([line("a"), line("b")], [line("a"), line("c"), line("d")])).toEqual([1, 2]);
  });
});
