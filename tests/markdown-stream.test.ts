import { describe, expect, test } from "bun:test";
import { MarkdownStream, stripAnsi } from "@butui/stream";

const render = (chunks: string[], width = 40): string[] => {
  const stream = new MarkdownStream({ width });
  for (const chunk of chunks) stream.push(chunk);
  stream.flush();
  return stream.lines.map(line => stripAnsi(line.text).replace(/\s+$/, ""));
};

describe("MarkdownStream：增量 ≡ 一次性", () => {
  const documents = [
    "# 标题\n\n第一段文字。\n\n第二段文字。\n",
    "普通段落，包含 **加粗** 和 *斜体* 以及 `代码`。\n",
    "- 列表项一\n- 列表项二\n- 列表项三\n",
    "1. 第一\n2. 第二\n",
    "> 引用第一行\n> 引用第二行\n",
    "```ts\nconst a = 1;\nconst b = 2;\n```\n",
    "# 标题\n\n段落一\n\n```js\ncode();\n```\n\n- 列表\n\n> 引用\n",
    "跨行强调 **bold\nacross lines** 结束。\n",
    "很长的段落内容需要折行处理，宽度限制会让它变成多行输出，这是流式渲染必须支持的场景。\n",
    "中文 **粗体** 混排 emoji 🎯 和 `code`。\n",
  ];

  test("按字符切块与整段推送结果一致", () => {
    for (const doc of documents) {
      const oneShot = render([doc]);
      const perChar = render([...doc]);
      expect(perChar, JSON.stringify(doc)).toEqual(oneShot);
    }
  });

  test("随机分块与整段推送结果一致", () => {
    for (const doc of documents) {
      const oneShot = render([doc]);
      const chunks: string[] = [];
      const points = [...doc];
      let i = 0;
      while (i < points.length) {
        const size = 1 + ((i * 7) % 5);
        chunks.push(points.slice(i, i + size).join(""));
        i += size;
      }
      expect(render(chunks), JSON.stringify(doc)).toEqual(oneShot);
    }
  });

  test("识别块级构造", () => {
    expect(render(["# 标题\n"])[0]).toBe("标题");
    expect(render(["- a\n- b\n"])).toEqual(["• a", "• b"]);
    expect(render(["1. a\n2. b\n"])).toEqual(["1. a", "2. b"]);
    expect(render(["> quote\n"])).toEqual(["│ quote"]);
    expect(render(["```ts\nconst a = 1;\n```\n"])).toEqual(["const a = 1;"]);
    expect(render(["---\n"])[0]!.startsWith("─")).toBe(true);
  });

  test("逐 3 字符吐字时不会把 `**结` 当成已闭合", () => {
    // 回归：曾经用「星号个数是偶数」判断闭合，于是 `**结`（2 个星号）
    // 被当成闭合行永久定稿，后面补齐 `论**` 也救不回来。
    const stream = new MarkdownStream({ width: 40 });
    const text = "**结论**：host ops 只有 13 个。\n";
    for (let i = 0; i < text.length; i += 3) stream.push(text.slice(i, i + 3));
    stream.flush();

    const joined = stream.lines.map(l => l.text).join("\n");
    expect(stripAnsi(joined)).toBe("结论：host ops 只有 13 个。");
    expect(joined).toContain("\x1b[1m");
    expect(joined).not.toContain("**");
  });

  test("孤立星号（两侧空白）不算未闭合", () => {
    const stream = new MarkdownStream({ width: 40 });
    stream.push("a * b 是字面量\n");
    stream.flush();
    expect(stripAnsi(stream.lines.map(l => l.text).join(""))).toContain("a * b");
  });

  test("跨行强调闭合后整段重渲染", () => {
    const stream = new MarkdownStream({ width: 40 });
    stream.push("**bo");
    const held = stream.lines.map(l => l.text);
    expect(held.some(t => t.includes("**bo"))).toBe(true);

    stream.push("ld** 结束\n");
    stream.flush();
    const final = stream.lines.map(l => l.text);
    // 闭合后变成真正的粗体：ANSI 里应当出现 SGR 1
    expect(final.join("")).toContain("\x1b[1m");
    expect(stripAnsi(final.join("\n"))).toContain("bold");
    expect(stripAnsi(final.join("\n"))).not.toContain("**");
  });
});

describe("MarkdownStream：复杂度", () => {
  const measureWorstPush = (paragraphs: number): number => {
    const stream = new MarkdownStream({ width: 60 });
    let before = stream.stats.styledChars;
    let worst = 0;
    for (let i = 0; i < paragraphs; i++) {
      const text = `第 ${i} 段有一些 **内容** 和更多文字用来触发折行。\n\n`;
      for (let j = 0; j < text.length; j += 6) stream.push(text.slice(j, j + 6));
      worst = Math.max(worst, stream.stats.styledChars - before);
      before = stream.stats.styledChars;
    }
    return worst;
  };

  test("单次 push 的处理量与已渲染段落数无关", () => {
    const small = measureWorstPush(20);
    const large = measureWorstPush(400);
    expect(large).toBeLessThanOrEqual(small + 32);
  });

  test("总处理量随输入线性增长而非平方", () => {
    const total = (paragraphs: number): number => {
      const stream = new MarkdownStream({ width: 60 });
      for (let i = 0; i < paragraphs; i++) {
        stream.push(`第 ${i} 段内容，用于测量总处理量。\n\n`);
      }
      return stream.stats.styledChars + stream.stats.wrappedChars;
    };
    const n1 = total(100);
    const n2 = total(1000);
    expect(n2 / n1).toBeLessThan(15);
  });

  test("冻结行数单调增长，已冻结的行不会变", () => {
    const stream = new MarkdownStream({ width: 30 });
    let previous: string[] = [];
    for (let i = 0; i < 30; i++) {
      stream.push(`第 ${i} 段。\n\n`);
      const frozen = stream.frozenCount;
      const lines = stream.lines.map(l => l.text);
      for (let k = 0; k < previous.length && k < frozen; k++) {
        expect(lines[k]).toBe(previous[k]);
      }
      previous = lines;
    }
  });
});
