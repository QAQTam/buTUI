import { describe, expect, test } from "bun:test";
import {
  type KeyEvent,
  type Node,
  createModifiers,
  dispatchEvent,
  focusNode,
  nodeById,
} from "@butui/core";
import { Input, createTextEditor, sliceInputWindow } from "@butui/components";
import { mount } from "@butui/test";

const key = (name: string, text?: string, mods?: Partial<KeyEvent["modifiers"]>): KeyEvent =>
  ({
    type: "key",
    name,
    ...(text !== undefined ? { text } : {}),
    modifiers: createModifiers(
      mods?.ctrl ?? false,
      mods?.alt ?? false,
      mods?.shift ?? false,
      mods?.meta ?? false
    ),
  }) as KeyEvent;

/** 从帧里找出 Input 的行节点（它带 semantic="input"） */
function inputNode(app: ReturnType<typeof mount>): Node | undefined {
  const frame = app.frame();
  for (const line of frame.lines) {
    for (const cell of line) {
      if (cell.semantic === "input") return nodeById(app.root, cell.node);
    }
  }
  return undefined;
}

describe("sliceInputWindow：光标永远可见", () => {
  test("短文本不滚动", () => {
    expect(sliceInputWindow("abc", 3, 10)).toEqual({ before: "abc", at: "", after: "", scrolled: 0 });
  });

  test("长文本：光标在末尾时窗口贴右（并给光标留一格）", () => {
    const win = sliceInputWindow("abcdefghij", 10, 4);
    // 可见文字占 3 列，第 4 列留给光标 —— 光标永远在窗口里
    expect(win.before + win.at + win.after).toBe("hij");
    expect(win.at).toBe("");
    expect(win.scrolled).toBe(7);
  });

  test("长文本：光标在中间时窗口跟着走", () => {
    const win = sliceInputWindow("abcdefghij", 5, 4);
    const visible = win.before + win.at + win.after;
    expect(visible).toContain("f"); // 光标处可见
    expect(win.scrolled).toBeGreaterThan(0);
  });

  test("CJK 按显示宽度算窗口", () => {
    const win = sliceInputWindow("中文中文中文", 6, 4);
    expect(Bun.stringWidth(win.before + win.at + win.after)).toBeLessThanOrEqual(4);
  });

  test("行尾时 at 为空（block 光标要知道没有字可反显）", () => {
    const win = sliceInputWindow("abc", 3, 10);
    expect(win.at).toBe("");
  });
});

describe("<Input>（SPEC §10.1）", () => {
  test("渲染值与光标", () => {
    const editor = createTextEditor({ value: "hello" });
    const app = mount(() => <Input editor={editor} width={20} />, { width: 24, height: 2 });
    expect(app.text()).toContain("hello");
    expect(app.text()).toContain("▏");
    app.unmount();
  });

  test("空值显示占位符", () => {
    const editor = createTextEditor();
    const app = mount(() => <Input editor={editor} placeholder="说点什么…" width={20} />, {
      width: 24,
      height: 2,
    });
    expect(app.text()).toContain("说点什么…");
    app.unmount();
  });

  test("聚焦后按键交给编辑器（应用不需要写 backspace）", () => {
    const editor = createTextEditor();
    const app = mount(() => <Input editor={editor} width={20} />, { width: 24, height: 2 });
    const node = inputNode(app);
    expect(node).toBeDefined();
    focusNode(app.root, node);

    app.key("h", "h");
    app.key("i", "i");
    app.flush();
    expect(editor.value()).toBe("hi");
    expect(app.text()).toContain("hi");

    app.key("backspace");
    app.flush();
    expect(editor.value()).toBe("h");
    app.unmount();
  });

  test("粘贴插入（换行被压平）", () => {
    const editor = createTextEditor();
    const app = mount(() => <Input editor={editor} width={30} />, { width: 34, height: 2 });
    const node = inputNode(app)!;
    focusNode(app.root, node);

    // 终端层解码后就是一个 PasteEvent，直接派发给焦点节点
    dispatchEvent(node, { type: "paste", text: "a\nb" });
    app.flush();
    expect(editor.value()).toBe("a b");
    app.unmount();
  });

  test("超长输入：光标始终可见", () => {
    const editor = createTextEditor({ value: "0123456789abcdef" });
    const app = mount(() => <Input editor={editor} width={6} />, { width: 10, height: 2 });
    focusNode(app.root, inputNode(app));

    // 光标在末尾 → 尾部可见
    expect(app.text()).toContain("bcdef");
    expect(app.text()).toContain("…"); // 左侧还有内容

    app.key("home");
    app.flush();
    expect(app.text()).toContain("01234");
    app.unmount();
  });

  test("block 光标：反显光标处字符", () => {
    const editor = createTextEditor({ value: "ab" });
    editor.setCursor(0);
    const app = mount(() => <Input editor={editor} width={10} cursorStyle="block" />, {
      width: 14,
      height: 2,
    });
    const text = app.text();
    expect(text).toContain("ab");
    // 反显：光标处的 "a" 用 bg=focus 画出来
    const cell = app
      .frame()
      .lines[0]
      .find(c => c.ch === "a");
    expect(cell?.sgr).toContain("48;2");
    app.unmount();
  });

  test("onKey 先行：应用可以拦截特定键", () => {
    const editor = createTextEditor();
    const seen: string[] = [];
    const app = mount(
      () => (
        <Input
          editor={editor}
          width={20}
          onKey={event => {
            seen.push(event.name);
            return event.name === "escape";
          }}
        />
      ),
      { width: 24, height: 2 }
    );
    focusNode(app.root, inputNode(app));

    app.key("escape");
    app.flush();
    expect(seen).toEqual(["escape"]);

    app.key("x", "x");
    app.flush();
    expect(seen).toEqual(["escape", "x"]);
    expect(editor.value()).toBe("x");
    app.unmount();
  });

  test("autoFocus：挂载后自动聚焦，光标高亮", () => {
    const editor = createTextEditor();
    const app = mount(() => <Input editor={editor} width={20} autoFocus />, {
      width: 24,
      height: 2,
    });
    app.flush();
    // 聚焦后光标用 focus 色；未聚焦是 muted
    const cursorCell = app
      .frame()
      .lines[0]
      .find(c => c.ch === "▏");
    expect(cursorCell?.sgr).toContain("38;2");
    app.unmount();
  });
});
