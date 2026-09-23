import { describe, expect, test } from "bun:test";
import { type Node, focusNode, walk } from "@butui/core";
import { Textarea, createTextEditor, locateCursor, wrapText } from "@butui/components";
import { mount } from "@butui/test";

function findTextarea(root: Node): Node | undefined {
  for (const node of walk(root)) {
    if (node.kind === "element" && node.props.semantic === "textarea") return node;
  }
  return undefined;
}

describe("wrapText：软换行", () => {
  test("短行不折", () => {
    const lines = wrapText("hello", 10);
    expect(lines.map(l => l.text)).toEqual(["hello"]);
    expect(lines[0]).toMatchObject({ start: 0, end: 5 });
  });

  test("超宽硬折，并记录源偏移", () => {
    const lines = wrapText("abcdefghij", 4);
    expect(lines.map(l => l.text)).toEqual(["abcd", "efgh", "ij"]);
    expect(lines[1]).toMatchObject({ start: 4, end: 8 });
  });

  test("换行符切成新的一行（空行也保留）", () => {
    const lines = wrapText("a\n\nb", 10);
    expect(lines.map(l => l.text)).toEqual(["a", "", "b"]);
    expect(lines[2]).toMatchObject({ start: 3, end: 4 });
  });

  test("CJK 按显示宽度折，不会劈开字符", () => {
    const lines = wrapText("中文中文", 4);
    expect(lines.map(l => l.text)).toEqual(["中文", "中文"]);
  });

  test("空文本也有一行（光标要有地方落）", () => {
    expect(wrapText("", 10)).toEqual([{ text: "", start: 0, end: 0, lineNumber: 1 }]);
  });

  test("光标定位：行内列 + 行号", () => {
    const lines = wrapText("abcd\nef", 4);
    expect(locateCursor(lines, 0)).toEqual({ row: 0, column: 0 });
    expect(locateCursor(lines, 3)).toEqual({ row: 0, column: 3 });
    expect(locateCursor(lines, 5)).toEqual({ row: 1, column: 0 });
    expect(locateCursor(lines, 7)).toEqual({ row: 1, column: 2 });
  });
});

describe("<Textarea>", () => {
  test("渲染多行文本与光标", () => {
    const editor = createTextEditor({ value: "第一行\n第二行", multiline: true });
    const app = mount(() => <Textarea editor={editor} width={20} height={4} />, {
      width: 24,
      height: 5,
    });
    const text = app.text();
    expect(text).toContain("第一行");
    expect(text).toContain("第二行");
    expect(text).toContain("▏");
    app.unmount();
  });

  test("Enter 插入换行（不是提交）", () => {
    const editor = createTextEditor({ multiline: true });
    const app = mount(() => <Textarea editor={editor} width={20} height={4} />, {
      width: 24,
      height: 5,
    });
    focusNode(app.root, findTextarea(app.root));
    app.key("a", "a");
    app.key("enter");
    app.key("b", "b");
    app.flush();
    expect(editor.value()).toBe("a\nb");
    app.unmount();
  });

  test("↑↓ 在多行之间移动光标（不再翻历史）", () => {
    const editor = createTextEditor({ value: "abc\ndef", multiline: true });
    editor.setCursor(1); // 第一行第 1 列
    const app = mount(() => <Textarea editor={editor} width={20} height={4} />, {
      width: 24,
      height: 5,
    });
    focusNode(app.root, findTextarea(app.root));
    app.key("down");
    app.flush();
    expect(editor.cursor()).toBe(5); // 第二行第 1 列
    app.key("up");
    app.flush();
    expect(editor.cursor()).toBe(1);
    app.unmount();
  });

  test("软换行：超宽内容折成多行显示", () => {
    const editor = createTextEditor({ value: "abcdefghij", multiline: true });
    const app = mount(() => <Textarea editor={editor} width={4} height={3} />, {
      width: 8,
      height: 4,
    });
    const text = app.text();
    expect(text).toContain("abcd");
    expect(text).toContain("efgh");
    expect(text).toContain("ij");
    app.unmount();
  });

  test("光标跑出视口时窗口跟随（长文本只显示尾部）", () => {
    const editor = createTextEditor({ value: "1\n2\n3\n4\n5\n6", multiline: true });
    editor.setCursor(editor.value().length);
    const app = mount(() => <Textarea editor={editor} width={10} height={3} />, {
      width: 12,
      height: 4,
    });
    const text = app.text();
    expect(text).toContain("6");
    expect(text).not.toContain("1");
    app.unmount();
  });

  test("行号模式", () => {
    const editor = createTextEditor({ value: "a\nb\nc", multiline: true });
    const app = mount(() => <Textarea editor={editor} width={10} height={3} lineNumbers />, {
      width: 12,
      height: 4,
    });
    const text = app.text();
    expect(text).toContain("1 a");
    expect(text).toContain("3 c");
    app.unmount();
  });

  test("空值显示占位符", () => {
    const editor = createTextEditor({ multiline: true });
    const app = mount(
      () => <Textarea editor={editor} width={20} height={3} placeholder="写点什么…" />,
      { width: 24, height: 4 }
    );
    expect(app.text()).toContain("写点什么…");
    app.unmount();
  });
});
