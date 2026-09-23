import { describe, expect, test } from "bun:test";
import { type Node, focusNode, walk } from "@butui/core";
import { Select, Tabs } from "@butui/components";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

function findBySemantic(root: Node, semantic: string): Node | undefined {
  for (const node of walk(root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

describe("<Select>", () => {
  const options = [
    { value: "main", label: "main", description: "主分支" },
    { value: "feature", label: "feature" },
    { value: "old", label: "old", disabled: true },
  ];

  test("渲染选项与说明，高亮当前值", () => {
    const app = mount(() => <Select options={options} value="feature" />, {
      width: 30,
      height: 4,
    });
    const text = app.text();
    expect(text).toContain("main");
    expect(text).toContain("主分支");
    expect(text).toContain("feature");
    // 高亮在 feature 上（第二行）
    expect(app.frame().lines[1].map(c => c.ch).join("").trimStart().startsWith(">")).toBe(true);
    app.unmount();
  });

  test("Enter 提交当前项", () => {
    const picked: string[] = [];
    const app = mount(
      () => <Select options={options} value="main" onChange={value => picked.push(value)} />,
      { width: 30, height: 4 }
    );
    focusNode(app.root, findBySemantic(app.root, "select"));
    app.key("down");
    app.key("enter");
    app.flush();
    expect(picked).toEqual(["feature"]);
    app.unmount();
  });

  test("disabled 项会被跳过", () => {
    const picked: string[] = [];
    const app = mount(
      () => <Select options={options} value="feature" onChange={v => picked.push(v)} />,
      { width: 30, height: 4 }
    );
    focusNode(app.root, findBySemantic(app.root, "select"));
    app.key("down"); // feature → 跳过 old（disabled），停在原地
    app.key("enter");
    app.flush();
    expect(picked).toEqual(["feature"]); // 仍然是 feature，没被 disabled 项带走
    app.unmount();
  });

  test("外部改 value → 高亮跟过去", () => {
    const [value, setValue] = createSignal("main");
    const app = mount(() => <Select options={options} value={value()} />, {
      width: 30,
      height: 4,
    });
    expect(app.frame().lines[0].map(c => c.ch).join("").trimStart().startsWith(">")).toBe(true);
    setValue("feature");
    app.flush();
    expect(app.frame().lines[1].map(c => c.ch).join("").trimStart().startsWith(">")).toBe(true);
    app.unmount();
  });

  test("heading 选项不可选但照常显示", () => {
    const withHeading = [
      { value: "__g1", label: "最近", heading: true },
      { value: "a", label: "会话 A" },
    ];
    const picked: string[] = [];
    const app = mount(
      () => <Select options={withHeading} onChange={v => picked.push(v)} />,
      { width: 30, height: 4 }
    );
    expect(app.text()).toContain("最近");
    // 初始高亮应该吸附到第一个可选（会话 A），不是 heading
    focusNode(app.root, findBySemantic(app.root, "select"));
    app.key("enter");
    app.flush();
    expect(picked).toEqual(["a"]);
    app.unmount();
  });

  test("点击某行即选中", () => {
    const picked: string[] = [];
    const app = mount(
      () => <Select options={options} onChange={v => picked.push(v)} />,
      { width: 30, height: 4 }
    );
    app.click(2, 1);
    app.flush();
    expect(picked).toEqual(["feature"]);
    app.unmount();
  });
});

describe("<Tabs>", () => {
  const items = [
    { value: "chat", label: "对话" },
    { value: "diff", label: "改动" },
    { value: "todo", label: "待办", badge: "3" },
  ];

  test("渲染所有标签，当前项加粗", () => {
    const app = mount(() => <Tabs items={items} value="diff" />, { width: 30, height: 1 });
    const text = app.text();
    expect(text).toContain("对话");
    expect(text).toContain("改动");
    expect(text).toContain("待办 3");
    const boldCells = app.frame().lines[0].filter(c => c.sgr.includes("\x1b[1m"));
    expect(boldCells.length).toBeGreaterThan(0);
    app.unmount();
  });

  test("←→ 立即切换（不用按 Enter）", () => {
    const [value, setValue] = createSignal("chat");
    const seen: string[] = [];
    const app = mount(
      () => (
        <Tabs
          items={items}
          value={value()}
          onChange={v => {
            seen.push(v);
            setValue(v);
          }}
        />
      ),
      { width: 30, height: 1 }
    );
    focusNode(app.root, findBySemantic(app.root, "tabs"));
    app.key("right");
    app.flush();
    expect(seen).toEqual(["diff"]);
    app.key("right");
    app.flush();
    expect(seen).toEqual(["diff", "todo"]);
    app.key("home");
    app.flush();
    expect(seen).toEqual(["diff", "todo", "chat"]);
    app.unmount();
  });

  test("点击标签切换", () => {
    const seen: string[] = [];
    const app = mount(
      () => <Tabs items={items} value="chat" onChange={v => seen.push(v)} />,
      { width: 30, height: 1 }
    );
    // 「待办」在 12 列之后
    app.click(12, 0);
    app.flush();
    expect(seen).toEqual(["todo"]);
    app.unmount();
  });

  test("disabled 标签被跳过", () => {
    const withDisabled = [
      { value: "a", label: "A" },
      { value: "b", label: "B", disabled: true },
      { value: "c", label: "C" },
    ];
    const seen: string[] = [];
    const app = mount(
      () => <Tabs items={withDisabled} value="a" onChange={v => seen.push(v)} />,
      { width: 20, height: 1 }
    );
    focusNode(app.root, findBySemantic(app.root, "tabs"));
    app.key("right");
    app.flush();
    expect(seen).toEqual(["c"]);
    app.unmount();
  });
});
