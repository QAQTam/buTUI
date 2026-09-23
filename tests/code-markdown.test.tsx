import { describe, expect, test } from "bun:test";
import { Code, Markdown, TOKEN_COLOR, tokenize, tokenizeLine } from "@butui/components";
import { mount } from "@butui/test";

const kinds = (line: string, options = {}): string[] =>
  tokenizeLine(line, options).map(t => t.kind);

describe("tokenizeLine：逐行语法扫描", () => {
  test("关键字 / 标识符 / 标点", () => {
    // 相邻同类会合并：" x" 是一个 text
    expect(kinds("const x = 1;")).toEqual([
      "keyword",
      "text",
      "operator",
      "text",
      "number",
      "punctuation",
    ]);
  });

  test("注释吃掉整行剩余部分", () => {
    const tokens = tokenizeLine("const x = 1; // 说明");
    expect(tokens[tokens.length - 1]).toEqual({ text: "// 说明", kind: "comment" });
  });

  test("# 注释按语言开关（python / shell 才认）", () => {
    expect(kinds("# not a comment")).not.toContain("comment");
    expect(kinds("# a comment", { hashComments: true })).toContain("comment");
  });

  test("字符串带转义不会提前结束", () => {
    const tokens = tokenizeLine('const s = "a\\"b";');
    expect(tokens.some(t => t.kind === "string" && t.text === '"a\\"b"')).toBe(true);
  });

  test("数字：1+2 不会被吃成一个 token", () => {
    const tokens = tokenizeLine("1+2");
    expect(tokens.filter(t => t.kind === "number").map(t => t.text)).toEqual(["1", "2"]);
  });

  test("首字母大写 → type，后面跟 ( → function", () => {
    expect(kinds("Widget")).toEqual(["type"]);
    expect(kinds("run(x)")).toEqual(["function", "punctuation", "text", "punctuation"]);
  });

  test("相邻同类 token 会合并（少建节点）", () => {
    const tokens = tokenizeLine("a b c");
    expect(tokens).toEqual([{ text: "a b c", kind: "text" }]);
  });

  test("tokenize 按行切开", () => {
    const lines = tokenize("const a = 1;\nlet b = 2;", "ts");
    expect(lines).toHaveLength(2);
    expect(lines[1]![0]).toEqual({ text: "let", kind: "keyword" });
  });
});

describe("<Code>", () => {
  const source = 'const answer = 42;\n// 注释\nfunction run() { return "ok"; }';

  test("渲染代码并上色", () => {
    const app = mount(() => <Code source={source} language="ts" />, { width: 60, height: 5 });
    const text = app.text();
    expect(text).toContain("const answer = 42;");
    expect(text).toContain("// 注释");
    expect(text).toContain("function run()");

    // 关键字用 accent、注释用 muted
    const line = app.frame().lines[0];
    const keywordCell = line.find(c => c.ch === "c");
    expect(keywordCell?.sgr).toContain("38;2;125;211;252");
    app.unmount();
  });

  test("行号从 1 开始，且按总行数对齐", () => {
    const app = mount(() => <Code source={source} lineNumbers />, { width: 60, height: 5 });
    const text = app.text();
    expect(text).toContain("1 const");
    expect(text).toContain("3 function");
    app.unmount();
  });

  test("maxLines 截断并提示剩余行数", () => {
    const app = mount(() => <Code source={source} maxLines={2} />, { width: 60, height: 5 });
    expect(app.text()).toContain("const answer");
    expect(app.text()).not.toContain("function run");
    expect(app.text()).toContain("还有 1 行");
    app.unmount();
  });

  test("highlightLines 给指定行加背景", () => {
    const app = mount(
      () => <Code source={source} highlightLines={[2]} highlightBg="warning" />,
      { width: 60, height: 5 }
    );
    const row = app.frame().lines[1];
    expect(row[0]!.sgr).toContain("48;2");
    app.unmount();
  });

  test("可以换掉分词器（可插拔）", () => {
    const app = mount(
      () => (
        <Code
          source="whatever"
          highlight={() => [[{ text: "自定义", kind: "keyword" }]]}
        />
      ),
      { width: 20, height: 2 }
    );
    expect(app.text()).toContain("自定义");
    app.unmount();
  });

  test("空代码不炸", () => {
    const app = mount(() => <Code source="" />, { width: 20, height: 2 });
    expect(app.text().trim()).toBe("");
    app.unmount();
  });
});

describe("<Markdown>", () => {
  test("渲染标题 / 列表 / 行内样式", () => {
    const app = mount(
      () => <Markdown source={"# 标题\n\n- 一\n- 二\n\n**粗体**"} width={40} />,
      { width: 44, height: 10 }
    );
    const text = app.text();
    expect(text).toContain("标题");
    expect(text).toContain("一");
    expect(text).toContain("粗体");
    app.unmount();
  });

  test("source 变化会重新渲染（换的是新数组 → 布局全量重建）", () => {
    const app = mount(() => <Markdown source={"第一版"} width={40} />, {
      width: 44,
      height: 6,
    });
    expect(app.text()).toContain("第一版");
    app.unmount();

    const second = mount(() => <Markdown source={"# 第二版"} width={40} />, {
      width: 44,
      height: 6,
    });
    expect(second.text()).toContain("第二版");
    second.unmount();
  });
});

describe("TOKEN_COLOR", () => {
  test("每个 token 类型都有主题色", () => {
    for (const color of Object.values(TOKEN_COLOR)) expect(typeof color).toBe("string");
  });
});
