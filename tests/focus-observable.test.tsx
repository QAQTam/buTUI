import { describe, expect, test } from "bun:test";
import { type Node, createModifiers, type KeyEvent } from "@butui/core";
import { useFocus } from "@butui/solid";
import { type TuiApp, createTuiApp } from "@butui/runtime";
import { Show, createSignal } from "solid-js";
import { FakeTerminal, tick } from "./helpers/terminal.ts";

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

const ACCENT = "38;2;125;211;252"; // theme.accent = #7dd3fc
const MUTED = "38;2;148;163;184"; // theme.muted = #94a3b8

/**
 * 一个「自己知道有没有焦点」的列表项 —— 这就是组件作者需要的能力。
 *
 * 三行：ref 拿自己的节点 → useFocus() 得到 O(1) 判断 → 用它决定颜色。
 * 不需要把 runtime 一路传下来，也不需要应用维护「当前焦点是谁」。
 */
function Item(props: { label: string }) {
  const [node, setNode] = createSignal<Node>();
  const isFocused = useFocus();
  return (
    <text ref={setNode} focusable color={isFocused(node()) ? "accent" : "muted"}>
      {props.label}
    </text>
  );
}

function setup(): { app: TuiApp; terminal: FakeTerminal } {
  const terminal = new FakeTerminal();
  const app = createTuiApp({
    terminal,
    view: () => (
      <box>
        <Item label="one" />
        <Item label="two" />
      </box>
    ),
    onQuit: () => {},
  });
  return { app, terminal };
}

const sgrAt = (app: TuiApp, y: number, x = 0): string => app.frame().lines[y][x].sgr;

describe("焦点可观察（组件知道自己是不是焦点）", () => {
  test("初始没有焦点：两项都是 muted", () => {
    const { app } = setup();
    expect(sgrAt(app, 0)).toContain(MUTED);
    expect(sgrAt(app, 1)).toContain(MUTED);
    app.dispose();
  });

  test("Tab 之后第一项自己变 accent —— 不需要应用告诉它", () => {
    const { app } = setup();
    app.send(key("tab"));
    expect(sgrAt(app, 0)).toContain(ACCENT);
    expect(sgrAt(app, 1)).toContain(MUTED);

    app.send(key("tab"));
    expect(sgrAt(app, 0)).toContain(MUTED);
    expect(sgrAt(app, 1)).toContain(ACCENT);

    // 循环回第一项
    app.send(key("tab"));
    expect(sgrAt(app, 0)).toContain(ACCENT);
    app.dispose();
  });

  test("焦点变化会自动触发重绘（不用手动 requestPaint）", async () => {
    const { app, terminal } = setup();
    terminal.output = "";
    app.send(key("tab"));
    await tick();
    // 重绘出来的字节里带 accent 色
    expect(terminal.output).toContain(ACCENT);
    app.dispose();
  });

  test("app.isFocused(node) 与组件内看到的一致", () => {
    const { app } = setup();
    const first = app.root.children[0]!.children[0]!;
    expect(app.isFocused(first)).toBe(false);
    app.focus(first);
    expect(app.isFocused(first)).toBe(true);
    expect(app.focusedId()).toBe(first.id);
    app.dispose();
  });

  test("组件被卸载后焦点自动失效（不会把按键发给幽灵节点）", async () => {
    const terminal = new FakeTerminal();
    const [show, setShow] = createSignal(true);
    const app = createTuiApp({
      terminal,
      view: () => (
        <box>
          <Show when={show()}>
            <Item label="one" />
          </Show>
          <Item label="two" />
        </box>
      ),
      onQuit: () => {},
    });

    app.send(key("tab"));
    expect(app.focusedId()).not.toBeNull();

    setShow(false);
    await tick();
    app.send(key("tab"));
    await tick();

    // 焦点落在仍然存在的那一项上（被移除的节点不会继续吃按键）
    // 注意：cell 的 node 是 <text> 内部的文本节点，焦点在 <text> 元素上，
    // 所以这里断言「剩下的那一项自己亮起来」而不是比 id。
    expect(app.focusedId()).not.toBeNull();
    expect(sgrAt(app, 0)).toContain(ACCENT);
    app.dispose();
  });
});
