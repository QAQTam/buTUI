import { describe, expect, test } from "bun:test";
import { mount } from "@butui/test";

describe("布局引擎（SPEC §9.1 P0）", () => {
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
    expect(lines.every(l => Bun.stringWidth(l) === 12)).toBe(true);
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
