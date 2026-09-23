import { describe, expect, test } from "bun:test";
import { createModifiers, type KeyEvent } from "@butui/core";
import {
  type TextEditor,
  createTextEditor,
  nextGrapheme,
  prevGrapheme,
  wordBoundaryLeft,
  wordBoundaryRight,
} from "@butui/components";

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

const type = (editor: TextEditor, input: string): void => {
  for (const ch of input) editor.handleKey(key(ch, ch));
};

describe("文本编辑模型（SPEC §10.1 Input 的地基）", () => {
  test("输入 / 退格 / 删除", () => {
    const editor = createTextEditor();
    type(editor, "hello");
    expect(editor.value()).toBe("hello");
    expect(editor.cursor()).toBe(5);

    editor.handleKey(key("backspace"));
    expect(editor.value()).toBe("hell");
    expect(editor.cursor()).toBe(4);

    editor.handleKey(key("home"));
    editor.handleKey(key("delete"));
    expect(editor.value()).toBe("ell");
    expect(editor.cursor()).toBe(0);
  });

  test("光标移动：左右 / home / end", () => {
    const editor = createTextEditor({ value: "abc" });
    expect(editor.cursor()).toBe(3);
    editor.handleKey(key("left"));
    expect(editor.cursor()).toBe(2);
    editor.handleKey(key("home"));
    expect(editor.cursor()).toBe(0);
    editor.handleKey(key("right"));
    expect(editor.cursor()).toBe(1);
    editor.handleKey(key("end"));
    expect(editor.cursor()).toBe(3);
    // 越界不炸
    editor.handleKey(key("right"));
    expect(editor.cursor()).toBe(3);
    editor.handleKey(key("home"));
    editor.handleKey(key("left"));
    expect(editor.cursor()).toBe(0);
  });

  test("在中间插入", () => {
    const editor = createTextEditor({ value: "ac" });
    editor.setCursor(1);
    type(editor, "b");
    expect(editor.value()).toBe("abc");
    expect(editor.cursor()).toBe(2);
  });

  test("词跳转：ctrl+左右按词移动", () => {
    const editor = createTextEditor({ value: "hello world" });
    editor.handleKey(key("left", undefined, { ctrl: true }));
    expect(editor.cursor()).toBe(6);
    editor.handleKey(key("left", undefined, { ctrl: true }));
    expect(editor.cursor()).toBe(0);
    editor.handleKey(key("right", undefined, { ctrl: true }));
    expect(editor.cursor()).toBe(5);
  });

  test("ctrl+backspace / ctrl+w：删到上一个词边界（readline 语义）", () => {
    // 光标在末尾：删掉 "world"
    const a = createTextEditor({ value: "hello world" });
    a.handleKey(key("backspace", undefined, { ctrl: true }));
    expect(a.value()).toBe("hello ");

    // 光标在词首（空格之后）：删掉 "hello "（连同空白）
    const b = createTextEditor({ value: "hello world" });
    b.setCursor(6);
    b.handleKey(key("backspace", undefined, { ctrl: true }));
    expect(b.value()).toBe("world");

    // ctrl+w 与 ctrl+backspace 同一个边界
    const c = createTextEditor({ value: "foo bar" });
    c.handleKey(key("w", undefined, { ctrl: true }));
    expect(c.value()).toBe("foo ");
  });

  test("ctrl+u / ctrl+k 删到行首行尾", () => {
    const editor = createTextEditor({ value: "hello world" });
    editor.setCursor(5);
    editor.handleKey(key("u", undefined, { ctrl: true }));
    expect(editor.value()).toBe(" world");
    editor.handleKey(key("k", undefined, { ctrl: true }));
    expect(editor.value()).toBe("");
  });

  test("ctrl+a / ctrl+e", () => {
    const editor = createTextEditor({ value: "abcdef" });
    editor.handleKey(key("a", undefined, { ctrl: true }));
    expect(editor.cursor()).toBe(0);
    editor.handleKey(key("e", undefined, { ctrl: true }));
    expect(editor.cursor()).toBe(6);
  });

  test("grapheme：emoji / CJK 不会被劈成两半", () => {
    const editor = createTextEditor({ value: "中👨‍👩‍👧a" });
    editor.handleKey(key("left"));
    expect(editor.value().slice(editor.cursor())).toBe("a");
    editor.handleKey(key("left"));
    // 一次左移跨过整个 ZWJ 家庭 emoji，落在 emoji 之前
    expect(editor.value().slice(editor.cursor())).toBe("👨‍👩‍👧a");
    editor.handleKey(key("backspace"));
    // 删掉的是「前一个字素」= 中
    expect(editor.value()).toBe("👨‍👩‍👧a");

    // 光标放在 emoji 之后：一次退格删掉整个 emoji（而不是半个代理对）
    const b = createTextEditor({ value: "中👨‍👩‍👧a" });
    b.setCursor(9);
    b.handleKey(key("backspace"));
    expect(b.value()).toBe("中a");
  });

  test("grapheme 辅助函数本身", () => {
    expect(prevGrapheme("abc", 2)).toBe(1);
    expect(nextGrapheme("abc", 1)).toBe(2);
    // 中文每个字一个 code unit：位置 1 是「文」的开始
    expect(prevGrapheme("中文", 3)).toBe(1);
    expect(prevGrapheme("中文", 1)).toBe(0);
    expect(nextGrapheme("中文", 0)).toBe(1);
    expect(nextGrapheme("中文", 1)).toBe(2);
    // 代理对 / ZWJ 一次跨完
    expect(prevGrapheme("a😀", 3)).toBe(1);
    expect(nextGrapheme("a😀", 1)).toBe(3);
    expect(wordBoundaryLeft("foo bar", 7)).toBe(4);
    expect(wordBoundaryRight("foo bar", 0)).toBe(3);
  });

  test("Enter 提交：onSubmit 收到值并清空", () => {
    const submitted: string[] = [];
    const editor = createTextEditor({ onSubmit: v => submitted.push(v) });
    type(editor, "hi");
    editor.handleKey(key("enter"));
    expect(submitted).toEqual(["hi"]);
    expect(editor.value()).toBe("");
    expect(editor.cursor()).toBe(0);
  });

  test("空输入不提交、不进历史", () => {
    const submitted: string[] = [];
    const editor = createTextEditor({ onSubmit: v => submitted.push(v) });
    type(editor, "   ");
    editor.handleKey(key("enter"));
    expect(submitted).toEqual(["   "]);
    expect(editor.history()).toEqual([]);
  });

  test("多行模式：Enter 换行而不是提交", () => {
    const submitted: string[] = [];
    const editor = createTextEditor({ multiline: true, onSubmit: v => submitted.push(v) });
    type(editor, "a");
    editor.handleKey(key("enter"));
    type(editor, "b");
    expect(editor.value()).toBe("a\nb");
    expect(submitted).toEqual([]);
  });

  test("单行模式：粘贴里的换行被压成空格", () => {
    const editor = createTextEditor();
    editor.insert("a\nb\r\nc");
    expect(editor.value()).toBe("a b c");
  });

  test("历史：上下键翻阅，回到草稿", () => {
    const editor = createTextEditor();
    type(editor, "one");
    editor.handleKey(key("enter"));
    type(editor, "two");
    editor.handleKey(key("enter"));
    type(editor, "dra");

    editor.handleKey(key("up"));
    expect(editor.value()).toBe("two");
    editor.handleKey(key("up"));
    expect(editor.value()).toBe("one");
    editor.handleKey(key("down"));
    expect(editor.value()).toBe("two");
    editor.handleKey(key("down"));
    expect(editor.value()).toBe("dra"); // 回到未提交的草稿
  });

  test("历史有上限", () => {
    const editor = createTextEditor({ historyLimit: 2 });
    for (const value of ["a", "b", "c"]) {
      type(editor, value);
      editor.handleKey(key("enter"));
    }
    expect(editor.history()).toEqual(["b", "c"]);
  });

  test("onChange 每次值变化都触发", () => {
    const changes: string[] = [];
    const editor = createTextEditor({ onChange: v => changes.push(v) });
    type(editor, "ab");
    editor.handleKey(key("backspace"));
    expect(changes).toEqual(["a", "ab", "a"]);
  });

  test("ctrl+组合键不认识就交回应用（返回 false）", () => {
    const editor = createTextEditor({ value: "x" });
    expect(editor.handleKey(key("p", undefined, { ctrl: true }))).toBe(false);
    expect(editor.value()).toBe("x");
    // 控制字符不插入
    expect(editor.handleKey(key("tab", "\t"))).toBe(false);
    expect(editor.value()).toBe("x");
  });
});
