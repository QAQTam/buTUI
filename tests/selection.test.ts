import { describe, expect, test } from "bun:test";
import { type KeyEvent, createModifiers } from "@butui/core";
import { clampIndex, createSelection, followScroll } from "@butui/components";

const key = (name: string, mods?: Partial<KeyEvent["modifiers"]>): KeyEvent =>
  ({
    type: "key",
    name,
    modifiers: createModifiers(
      mods?.ctrl ?? false,
      mods?.alt ?? false,
      mods?.shift ?? false,
      mods?.meta ?? false
    ),
  }) as KeyEvent;

describe("clampIndex", () => {
  test("空列表恒为 0", () => {
    expect(clampIndex(5, 0)).toBe(0);
    expect(clampIndex(-3, 0)).toBe(0);
  });

  test("夹进 [0, count-1]", () => {
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(2.7, 5)).toBe(2);
  });
});

describe("followScroll：窗口只跟着选中项走", () => {
  test("选中项已经在窗口里 → 窗口不动", () => {
    expect(followScroll(3, 20, 5, 2)).toBe(2);
    expect(followScroll(6, 20, 5, 2)).toBe(2);
  });

  test("选中项在窗口上方 → 窗口顶贴到它", () => {
    expect(followScroll(1, 20, 5, 4)).toBe(1);
  });

  test("选中项在窗口下方 → 窗口底贴到它", () => {
    expect(followScroll(9, 20, 5, 2)).toBe(5);
  });

  test("窗口不会越过末尾（末尾留不满也贴底）", () => {
    expect(followScroll(19, 20, 5, 0)).toBe(15);
  });

  test("条目比窗口少 → 恒为 0", () => {
    expect(followScroll(2, 3, 10, 5)).toBe(0);
  });

  test("空列表 / 零高度 → 0", () => {
    expect(followScroll(0, 0, 5, 3)).toBe(0);
    expect(followScroll(3, 20, 0, 3)).toBe(0);
  });

  test("用户手动滚开之后不被弹回去（选中项仍可见）", () => {
    // 选中 10，窗口 [5,10)；用户滚到 8 仍能看见 10，就不该动
    expect(followScroll(10, 100, 5, 8)).toBe(8);
  });
});

describe("createSelection", () => {
  test("默认选第一项", () => {
    const sel = createSelection({ count: 5 });
    expect(sel.index()).toBe(0);
    expect(sel.count()).toBe(5);
  });

  test("初始 index 越界会被夹取", () => {
    expect(createSelection({ count: 3, index: 99 }).index()).toBe(2);
    expect(createSelection({ count: 0, index: 4 }).index()).toBe(0);
  });

  test("上下移动，到两端停住（默认不回绕）", () => {
    const sel = createSelection({ count: 3 });
    sel.move(1);
    sel.move(1);
    expect(sel.index()).toBe(2);
    sel.move(1);
    expect(sel.index()).toBe(2);
    sel.move(-1);
    sel.move(-1);
    sel.move(-1);
    expect(sel.index()).toBe(0);
  });

  test("wrap: true 时首尾相接", () => {
    const sel = createSelection({ count: 3, wrap: true });
    sel.move(-1);
    expect(sel.index()).toBe(2);
    sel.move(1);
    expect(sel.index()).toBe(0);
  });

  test("home / end", () => {
    const sel = createSelection({ count: 8, index: 3 });
    sel.end();
    expect(sel.index()).toBe(7);
    sel.home();
    expect(sel.index()).toBe(0);
  });

  test("翻页按 pageSize 走（默认 10）", () => {
    const sel = createSelection({ count: 100 });
    sel.page(1);
    expect(sel.index()).toBe(10);
    sel.page(1);
    expect(sel.index()).toBe(20);
    sel.page(-1);
    expect(sel.index()).toBe(10);
  });

  test("onChange 带上前后下标，值没变就不通知", () => {
    const seen: Array<[number, number]> = [];
    const sel = createSelection({ count: 3, onChange: (i, prev) => seen.push([i, prev]) });
    sel.move(1);
    sel.move(1);
    sel.move(1); // 已经在末尾，值没变
    expect(seen).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  test("同一 tick 内连续移动不丢步（Solid 2 延迟写 signal 的坑）", () => {
    const sel = createSelection({ count: 10 });
    sel.move(1);
    sel.move(1);
    sel.move(1);
    expect(sel.index()).toBe(3);
  });

  test("count 是访问器：过滤结果变短时下标跟着夹取", () => {
    let size = 10;
    const sel = createSelection({ count: () => size, index: 7 });
    expect(sel.index()).toBe(7);
    size = 3;
    expect(sel.index()).toBe(2);
    size = 0;
    expect(sel.index()).toBe(0);
  });

  test("count 变短后 move 从夹取后的位置继续", () => {
    let size = 10;
    const sel = createSelection({ count: () => size, index: 9 });
    size = 4;
    sel.move(-1);
    expect(sel.index()).toBe(2);
  });
});

describe("Selection.handleKey", () => {
  test("方向键 / Home / End / PageUp / PageDown 都消费掉", () => {
    const sel = createSelection({ count: 50 });
    expect(sel.handleKey(key("down"))).toBe(true);
    expect(sel.index()).toBe(1);
    expect(sel.handleKey(key("end"))).toBe(true);
    expect(sel.index()).toBe(49);
    expect(sel.handleKey(key("pageup"))).toBe(true);
    expect(sel.index()).toBe(39);
    expect(sel.handleKey(key("home"))).toBe(true);
    expect(sel.index()).toBe(0);
    expect(sel.handleKey(key("pagedown"))).toBe(true);
    expect(sel.index()).toBe(10);
  });

  test("Ctrl+P / Ctrl+N（emacs 风格）", () => {
    const sel = createSelection({ count: 10 });
    expect(sel.handleKey(key("n", { ctrl: true }))).toBe(true);
    expect(sel.index()).toBe(1);
    expect(sel.handleKey(key("p", { ctrl: true }))).toBe(true);
    expect(sel.index()).toBe(0);
  });

  test("vim: true 才认 j / k", () => {
    const plain = createSelection({ count: 10 });
    expect(plain.handleKey(key("j"))).toBe(false);
    expect(plain.index()).toBe(0);

    const vim = createSelection({ count: 10, vim: true });
    expect(vim.handleKey(key("j"))).toBe(true);
    expect(vim.index()).toBe(1);
    expect(vim.handleKey(key("k"))).toBe(true);
    expect(vim.index()).toBe(0);
  });

  test("Enter 不归选择模型管（那是激活）", () => {
    const sel = createSelection({ count: 10 });
    expect(sel.handleKey(key("enter"))).toBe(false);
    expect(sel.handleKey(key("escape"))).toBe(false);
    expect(sel.handleKey(key("x"))).toBe(false);
  });

  test("Alt / Meta 组合不抢键", () => {
    const sel = createSelection({ count: 10 });
    expect(sel.handleKey(key("down", { alt: true }))).toBe(false);
    expect(sel.handleKey(key("down", { meta: true }))).toBe(false);
    expect(sel.index()).toBe(0);
  });
});
