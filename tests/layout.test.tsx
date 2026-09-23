import { describe, expect, test } from "bun:test";
import { mount } from "@butui/test";
import { Show, createSignal } from "solid-js";

describe("布局引擎（SPEC §9.1 P0）", () => {
  test("bg 用背景序列（48;…），不是把前景色当背景用", () => {
    const app = mount(() => <text bg="accent">hi</text>, { width: 4, height: 1 });
    const sgr = app.frame().lines[0][0].sgr;
    // accent = #7dd3fc
    expect(sgr).toContain("48;2;125;211;252");
    expect(sgr).not.toContain("38;2;125;211;252");
    app.unmount();
  });

  test("fg 与 bg 同时设置时两条序列都在", () => {
    const app = mount(() => <text fg="accent" bg="bg">x</text>, { width: 4, height: 1 });
    const sgr = app.frame().lines[0][0].sgr;
    expect(sgr).toContain("38;2;125;211;252");
    expect(sgr).toContain("48;2;15;23;42");
    app.unmount();
  });

  test("容器自己撑出来的空白带自己的背景（整行铺满）", () => {
    const app = mount(
      () => (
        <box width={10} bg="accent" height={1}>
          <text>hi</text>
        </box>
      ),
      { width: 10, height: 1 }
    );
    const line = app.frame().lines[0];
    // 文字之后的填充 cell 也得是 accent 背景，否则高亮只到文字为止
    expect(line[0].sgr).toContain("48;2;125;211;252");
    expect(line[9].sgr).toContain("48;2;125;211;252");
    app.unmount();
  });

  test("row 里没有背景的空白仍然是默认样式", () => {
    const app = mount(
      () => (
        <row width={8}>
          <text>ab</text>
        </row>
      ),
      { width: 8, height: 1 }
    );
    expect(app.frame().lines[0][7].sgr).toBe("");
    app.unmount();
  });

  test("自身样式变了 + 只有最后一个子节点变 → 不复用旧行（装饰不串味）", () => {
    const [on, setOn] = createSignal(false);
    const [tail, setTail] = createSignal("a");
    const app = mount(
      () => (
        <box width={6} bg={on() ? "accent" : undefined}>
          <text>head</text>
          <text>{tail()}</text>
        </box>
      ),
      { width: 6, height: 2 }
    );
    // 先铺一次缓存，再同时改「自己的样式」和「最后一个子节点」
    expect(app.frame().lines[1][5].sgr).toBe("");
    setOn(true);
    setTail("b");
    app.flush();
    expect(app.frame().lines[1][5].sgr).toContain("48;2;125;211;252");
    app.unmount();
  });

  test("truncate：不折行，截断并补省略号（状态栏一行到底）", () => {
    const app = mount(() => <text truncate>abcdefghijklmnop</text>, { width: 8, height: 3 });
    const text = app.frame().lines[0].map(c => c.ch).join("").replace(/\s+$/, "");
    expect(text).toBe("abcdefg…");
    // 只有一行 —— 不会因为超宽而折行
    expect(app.frame().lines[1].map(c => c.ch).join("").trim()).toBe("");
    app.unmount();
  });

  test("wrap={false}：不折行，直接截断（不加省略号）", () => {
    const app = mount(() => <text wrap={false}>abcdefghijklmnop</text>, { width: 8, height: 3 });
    const text = app.frame().lines[0].map(c => c.ch).join("").replace(/\s+$/, "");
    expect(text).toBe("abcdefgh");
    app.unmount();
  });

  test("truncate 在 row 里只占剩余宽度（不把兄弟节点挤走）", () => {
    const app = mount(
      () => (
        <row gap={1}>
          <text truncate>一段很长的说明文字要在这里被截断</text>
          <text>END</text>
        </row>
      ),
      { width: 12, height: 2 }
    );
    const text = app.frame().lines[0].map(c => c.ch).join("");
    expect(text.endsWith("END")).toBe(true);
    app.unmount();
  });


  test("条件渲染关掉时不留空行（gap 只算真正有内容的子节点）", () => {
    const [show, setShow] = createSignal(false);
    const app = mount(
      () => (
        <box gap={1}>
          <text>a</text>
          <Show when={show()}>
            <text>b</text>
          </Show>
          <Show when={false}>
            <text>c</text>
          </Show>
          <text>d</text>
        </box>
      ),
      { width: 10, height: 6 }
    );
    expect(app.text()).toBe("a\n\nd");
    setShow(true);
    app.flush();
    expect(app.text()).toBe("a\n\nb\n\nd");
    app.unmount();
  });

  test("row 横向排列 + spacer 吃掉剩余空间", () => {
    const app = mount(
      () => (
        <row width={20}>
          <text>left</text>
          <spacer />
          <text>right</text>
        </row>
      ),
      { width: 20, height: 1 }
    );
    expect(app.text()).toBe("left           right");
    app.unmount();
  });

  test("column + gap + padding + border", () => {
    const app = mount(
      () => (
        <box border padding={1} gap={1} width={12}>
          <text>a</text>
          <text>b</text>
        </box>
      ),
      { width: 12, height: 8 }
    );
    const lines = app.text().split("\n");
    expect(lines[0]).toBe("╭──────────╮");
    expect(lines.at(-1)).toBe("╰──────────╯");
    // 宽度要看帧本身：text() 会裁掉行尾空白
    expect(app.frame().lines.every(l => l.length === 12)).toBe(true);
    expect(lines.some(l => l.includes("a"))).toBe(true);
    expect(lines.some(l => l.includes("b"))).toBe(true);
    app.unmount();
  });

  test("CJK / emoji 宽度不错位", () => {
    const app = mount(
      () => (
        <row width={16}>
          <text>中文</text>
          <text>ab</text>
          <text>👨‍👩‍👧</text>
        </row>
      ),
      { width: 16, height: 1 }
    );
    const line = app.frame().lines[0];
    // 2 个 CJK（各 2 列）+ 2 个 ASCII + 1 个 emoji（2 列）= 8 列
    expect(line.length).toBe(16);
    expect(Bun.stringWidth(app.text().replace(/\s+$/, ""))).toBe(8);
    app.unmount();
  });

  test("justify=center 居中", () => {
    const app = mount(
      () => (
        <row width={11} justify="center">
          <text>mid</text>
        </row>
      ),
      { width: 11, height: 1 }
    );
    expect(app.text()).toBe("    mid");
    app.unmount();
  });

  test("overflow=hidden + scrollOffset 只显示窗口内的行", () => {
    const app = mount(
      () => (
        <box width={10} height={2} overflow="hidden" scrollOffset={1}>
          <text>one</text>
          <text>two</text>
          <text>three</text>
        </box>
      ),
      { width: 10, height: 2 }
    );
    expect(app.text()).toBe("two\nthree");
    app.unmount();
  });

  test("80×24 与 200×50 都能布局且不越界", () => {
    for (const [width, height] of [
      [80, 24],
      [200, 50],
    ] as const) {
      const app = mount(
        () => (
          <box border padding={1} width={width - 2} height={height - 2}>
            <text>长会话标题</text>
            <text>
              {"这是一段很长的中文说明文字，用来验证折行是否会溢出容器边界，同时检查 emoji 🎯 和 ANSI 宽度是否一致。"}
            </text>
          </box>
        ),
        { width, height }
      );
      const frame = app.frame();
      expect(frame.lines.length).toBe(height);
      for (const line of frame.lines) expect(line.length).toBe(width);
      app.unmount();
    }
  });

  test("flexGrow 子节点被约束在剩余空间内，不会把兄弟节点挤出屏幕", () => {
    const app = mount(
      () => (
        <box height={6}>
          <box border flexGrow={1} overflow="hidden">
            <text>1</text>
            <text>2</text>
            <text>3</text>
            <text>4</text>
            <text>5</text>
            <text>6</text>
          </box>
          <text>FOOTER</text>
        </box>
      ),
      { width: 20, height: 6 }
    );
    // 内容比容器高时，flexGrow 只吃剩余空间，footer 必须还在
    expect(app.text()).toContain("FOOTER");
    expect(app.frame().lines.length).toBe(6);
    app.unmount();
  });

  test("折行后每行宽度不超过容器", () => {
    const app = mount(() => <text>{"abcdefghij klmnopqrst uvwxyz"}</text>, { width: 10, height: 4 });
    const lines = app.frame().lines;
    expect(lines.every(l => l.length === 10)).toBe(true);
    expect(app.text().split("\n").length).toBeGreaterThan(1);
    app.unmount();
  });
});
