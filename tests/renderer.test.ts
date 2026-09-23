import { describe, expect, test } from "bun:test";
import { Renderer, diffFrames, moveTo, paintLine } from "@butui/renderer";
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
    // 只出现第 2 行的光标定位，第 1 行完全没写
    expect(output).toBe(`${moveTo(1, 0)}bXb\x1b[K`);
  });

  test("尺寸变化触发整屏重绘", () => {
    const renderer = new Renderer(() => {});
    renderer.draw({ lines: [line("aa")], width: 2, height: 1 } as never);
    const resized = renderer.draw({ lines: [line("aa"), line("bb")], width: 2, height: 2 } as never);
    expect(resized.full).toBe(true);
  });

  test("diffFrames 报告变化行号", () => {
    expect(diffFrames([line("a"), line("b")], [line("a"), line("c"), line("d")])).toEqual([1, 2]);
  });
});
