import { describe, expect, test } from "bun:test";
import { type KeyEvent, type MouseEvent, createModifiers } from "@butui/core";
import { createScrollView } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
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

const wheel = (dir: "up" | "down" | "left"): MouseEvent =>
  ({
    type: "mouse",
    action: "wheel",
    button: "none",
    wheel: dir,
    x: 0,
    y: 0,
    modifiers: createModifiers(),
  }) as MouseEvent;

describe("createScrollView：贴底 + 往回翻", () => {
  test("初始贴底：scroll() 返回 \"bottom\"，不需要知道内容有多长", () => {
    const view = createScrollView();
    expect(view.following()).toBe(true);
    expect(view()).toBe("bottom");
  });

  test("measure 收回真实位置：贴底时 top = maxTop", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    expect(view.top()).toBe(90);
    expect(view.total()).toBe(100);
    expect(view.height()).toBe(10);
    expect(view.maxTop()).toBe(90);
    expect(view.atBottom()).toBe(true);
    expect(view()).toBe("bottom");
  });

  test("往上滚：脱离跟随，scroll() 变成具体偏移", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    view.scrollBy(-3);
    expect(view.top()).toBe(87);
    expect(view.following()).toBe(false);
    expect(view()).toBe(87);
  });

  test("滚回底部：自动恢复跟随", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    view.scrollBy(-3);
    view.scrollBy(3);
    expect(view.following()).toBe(true);
    expect(view()).toBe("bottom");
  });

  test("往下滚过头会被夹住，且停在底部", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    view.scrollBy(50);
    expect(view.top()).toBe(90);
    expect(view.following()).toBe(true);
  });

  test("往上滚过头夹到 0", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    view.scrollBy(-500);
    expect(view.top()).toBe(0);
    expect(view.following()).toBe(false);
  });

  test("内容比视口短：maxTop = 0，恒贴底", () => {
    const view = createScrollView();
    view.measure({ top: 0, total: 3, height: 10 });
    expect(view.maxTop()).toBe(0);
    expect(view.atBottom()).toBe(true);
    view.scrollBy(5);
    expect(view.top()).toBe(0);
    expect(view.following()).toBe(true);
  });

  test("滚过头之后布局回报真值 → 自愈（不用再补一帧）", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    view.scrollTo(9999);
    expect(view.top()).toBe(90); // 模型自己先夹一次
    // 就算模型不知道内容有多长（没 measure 过），布局也会夹，然后回报真值
    const fresh = createScrollView();
    fresh.scrollTo(9999);
    fresh.measure({ top: 0, total: 100, height: 10 });
    expect(fresh.top()).toBe(0);
  });

  test("翻页步长 = 视口高度 - 重叠", () => {
    const view = createScrollView();
    view.measure({ top: 190, total: 200, height: 10 });
    expect(view.following()).toBe(true);
    view.pageUp();
    expect(view.top()).toBe(181);
    expect(view.following()).toBe(false);
    view.pageDown();
    expect(view.top()).toBe(190);
    // 翻回底部 = 重新跟随
    expect(view.following()).toBe(true);
  });

  test("home / end", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    view.home();
    expect(view.top()).toBe(0);
    expect(view.following()).toBe(false);
    view.end();
    expect(view.top()).toBe(90);
    expect(view.following()).toBe(true);
  });

  test("跟随中内容变长：仍然贴底（靠 \"bottom\"，不需要通知）", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    view.measure({ top: 95, total: 105, height: 10 });
    expect(view()).toBe("bottom");
    expect(view.atBottom()).toBe(true);
  });

  test("翻上去之后内容变长：停在原来的位置，不被拽到底", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    view.scrollBy(-10);
    expect(view.top()).toBe(80);
    // 布局这次会用 80 作为 scrollTop，真值回来还是 80
    view.measure({ top: 80, total: 105, height: 10 });
    expect(view.top()).toBe(80);
    expect(view.following()).toBe(false);
    expect(view()).toBe(80);
  });

  test("内容缩短到视口以下：布局夹到 0，模型跟着回到跟随态", () => {
    const view = createScrollView();
    view.measure({ top: 90, total: 100, height: 10 });
    view.scrollBy(-10);
    view.measure({ top: 0, total: 4, height: 10 });
    expect(view.top()).toBe(0);
    expect(view.following()).toBe(true);
  });
});

describe("ScrollView 输入", () => {
  test("方向键 / 翻页 / Home / End 都消费掉", () => {
    const view = createScrollView();
    view.measure({ top: 50, total: 100, height: 10 });
    expect(view.handleKey(key("up"))).toBe(true);
    expect(view.top()).toBe(49);
    expect(view.handleKey(key("down"))).toBe(true);
    expect(view.top()).toBe(50);
    expect(view.handleKey(key("pageup"))).toBe(true);
    expect(view.top()).toBe(41);
    expect(view.handleKey(key("pagedown"))).toBe(true);
    expect(view.top()).toBe(50);
    expect(view.handleKey(key("home"))).toBe(true);
    expect(view.top()).toBe(0);
    expect(view.handleKey(key("end"))).toBe(true);
    expect(view.top()).toBe(90);
  });

  test("别的键不消费（交给应用 / 编辑器）", () => {
    const view = createScrollView();
    view.measure({ top: 50, total: 100, height: 10 });
    expect(view.handleKey(key("enter"))).toBe(false);
    expect(view.handleKey(key("x", { ctrl: true }))).toBe(false);
    expect(view.handleKey(key("up", { ctrl: true }))).toBe(false);
    expect(view.handleKey(key("up", { alt: true }))).toBe(false);
    expect(view.top()).toBe(50);
  });

  test("滚轮上下消费，左右和别的鼠标动作不消费", () => {
    const view = createScrollView({ wheelStep: 3 });
    view.measure({ top: 50, total: 100, height: 10 });
    expect(view.handleWheel(wheel("up"))).toBe(true);
    expect(view.top()).toBe(47);
    expect(view.handleWheel(wheel("down"))).toBe(true);
    expect(view.top()).toBe(50);
    expect(view.handleWheel(wheel("left"))).toBe(false);
    expect(view.handleWheel({ ...wheel("down"), action: "press" } as MouseEvent)).toBe(false);
  });
});

/** 40×6 的假终端 + 100 行转录，验证整条链路 */
function setup(): { terminal: FakeTerminal; app: ReturnType<typeof createTuiApp>; lines: string[] } {
  const terminal = new FakeTerminal();
  const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
  const view = createScrollView();
  const app = createTuiApp({
    terminal,
    scroll: view,
    view: () => (
      <box>
        {lines.map(line => (
          <text>{line}</text>
        ))}
      </box>
    ),
    afterDraw: frame => view.measure(frame),
    onKey: event => view.handleKey(event),
    onMouse: event => view.handleWheel(event),
    onQuit: () => {},
  });
  return { terminal, app, lines };
}

describe("接进 createTuiApp：整条链路", () => {
  test("默认贴底，能看到最后一行", () => {
    const { app } = setup();
    expect(app.frame().text()).toContain("line-99");
    expect(app.frame().text()).not.toContain("line-90");
    app.dispose();
  });

  test("PageUp 往回翻，End 回到最新", () => {
    const { app, terminal } = setup();
    const top = app.frame().top;
    expect(top).toBe(94); // 100 行 - 6 行视口

    terminal.emit(key("pageup"));
    expect(app.frame().top).toBe(89);
    expect(app.frame().text()).toContain("line-89");

    terminal.emit(key("end"));
    expect(app.frame().top).toBe(94);
    expect(app.frame().text()).toContain("line-99");
    app.dispose();
  });

  test("滚轮往上滚之后，新内容不会把视口拽回去", async () => {
    const terminal = new FakeTerminal();
    const { createSignal } = await import("solid-js");
    const [items, setItems] = createSignal(Array.from({ length: 100 }, (_, i) => `line-${i}`));
    const view = createScrollView();

    const app = createTuiApp({
      terminal,
      scroll: view,
      view: () => (
        <box>
          {items().map(line => (
            <text>{line}</text>
          ))}
        </box>
      ),
      afterDraw: frame => view.measure(frame),
      onKey: event => view.handleKey(event),
      onMouse: event => view.handleWheel(event),
      onQuit: () => {},
    });

    terminal.emit(wheel("up"));
    expect(view.following()).toBe(false);
    const parked = app.frame().top;
    expect(parked).toBe(93);

    setItems([...items(), "line-100", "line-101"]);
    await tick();
    // 停在同一行号，而不是被拽到新的底部
    expect(app.frame().top).toBe(parked);
    expect(app.frame().text()).toContain("line-93");

    terminal.emit(key("end"));
    expect(app.frame().top).toBe(96); // 102 - 6
    expect(app.frame().text()).toContain("line-101");
    app.dispose();
  });

  test("贴底时新内容自动跟着走", async () => {
    const terminal = new FakeTerminal();
    const { createSignal } = await import("solid-js");
    const [items, setItems] = createSignal(Array.from({ length: 100 }, (_, i) => `line-${i}`));
    const view = createScrollView();

    const app = createTuiApp({
      terminal,
      scroll: view,
      view: () => (
        <box>
          {items().map(line => (
            <text>{line}</text>
          ))}
        </box>
      ),
      afterDraw: frame => view.measure(frame),
      onQuit: () => {},
    });

    expect(app.frame().top).toBe(94);
    setItems([...items(), "line-100"]);
    await tick();
    expect(app.frame().top).toBe(95);
    expect(app.frame().text()).toContain("line-100");
    app.dispose();
  });

  test("stickyBottom：固定状态栏不跟着滚", () => {
    const terminal = new FakeTerminal();
    const items = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const view = createScrollView();
    const app = createTuiApp({
      terminal,
      scroll: view,
      stickyBottom: 1,
      view: () => (
        <box>
          {items.map(line => (
            <text>{line}</text>
          ))}
          <text>STATUS</text>
        </box>
      ),
      afterDraw: frame => view.measure(frame),
      onKey: event => view.handleKey(event),
      onQuit: () => {},
    });

    // 视口 6 行 = 5 行转录 + 1 行状态栏；贴底时看到最后 5 条
    expect(app.frame().text()).toContain("STATUS");
    expect(app.frame().text()).toContain("line-19");
    expect(app.frame().text()).not.toContain("line-14");
    expect(app.frame().top).toBe(15);
    expect(app.frame().total).toBe(21);

    terminal.emit(key("pageup"));
    // 转录往回翻了 5 行，状态栏还在原地
    expect(app.frame().top).toBe(10);
    expect(app.frame().text()).toContain("line-10");
    expect(app.frame().text()).toContain("STATUS");
    expect(app.frame().text()).not.toContain("line-9");

    terminal.emit(key("end"));
    expect(app.frame().top).toBe(15);
    expect(view.following()).toBe(true);
    app.dispose();
  });

  test("stickyTop + stickyBottom：页眉 / 页脚都固定", () => {
    const terminal = new FakeTerminal();
    const items = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    const view = createScrollView();
    const app = createTuiApp({
      terminal,
      scroll: view,
      stickyTop: 1,
      stickyBottom: 1,
      view: () => (
        <box>
          <text>HEADER</text>
          {items.map(line => (
            <text>{line}</text>
          ))}
          <text>STATUS</text>
        </box>
      ),
      afterDraw: frame => view.measure(frame),
      onKey: event => view.handleKey(event),
      onQuit: () => {},
    });

    // 视口 6 = 1 页眉 + 4 转录 + 1 页脚
    const text = app.frame().text();
    expect(text).toContain("HEADER");
    expect(text).toContain("STATUS");
    expect(text).toContain("line-19");
    expect(text).not.toContain("line-15");
    expect(app.frame().top).toBe(16);
    expect(app.frame().total).toBe(22);

    terminal.emit(key("pageup"));
    const scrolled = app.frame().text();
    expect(scrolled).toContain("HEADER");
    expect(scrolled).toContain("STATUS");
    // 翻页按整屏高度算（滚动区比整屏小，会多滚两行 —— 见 STABILITY 已知缺口）
    expect(app.frame().top).toBe(11);
    app.dispose();
  });
});

describe("重绘链路：往回翻必须真的写终端", () => {
  test("按 ↑ 之后 terminal 输出里出现「已滚回」", async () => {
    const terminal = new FakeTerminal();
    const items = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const view = createScrollView();
    const app = createTuiApp({
      terminal,
      scroll: view,
      stickyBottom: 1,
      view: () => (
        <box>
          {items.map(line => (
            <text>{line}</text>
          ))}
          <text>{view.following() ? "FOLLOWING" : `SCROLLED-${view.top()}`}</text>
        </box>
      ),
      afterDraw: frame => view.measure(frame),
      onKey: event => view.handleKey(event),
      onQuit: () => {},
    });

    expect(terminal.output).toContain("FOLLOWING");
    terminal.output = "";
    terminal.emit(key("up"));
    await tick();
    expect(terminal.output).toContain("SCROLLED-");
    app.dispose();
  });
});
