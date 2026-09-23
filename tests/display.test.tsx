import { describe, expect, test } from "bun:test";
import { mount } from "@butui/test";
import { Badge, Divider, KeyHint, ProgressBar, Spinner } from "@butui/components";

describe("ProgressBar", () => {
  test("value/max 折算成条长", () => {
    const app = mount(() => <ProgressBar value={3} max={10} width={10} showPercent />, {
      width: 20,
      height: 1,
    });
    const text = app.text();
    expect(text).toContain("███");
    expect(text).toContain("░░░░░░░");
    expect(text).toContain("30%");
    app.unmount();
  });

  test("value 直接给 0..1", () => {
    const app = mount(() => <ProgressBar value={0.5} width={10} />, { width: 20, height: 1 });
    expect(app.text()).toContain("█████");
    app.unmount();
  });

  test("超过 90% 转 danger 色", () => {
    const app = mount(() => <ProgressBar value={0.95} width={10} />, { width: 20, height: 1 });
    expect(app.frame().lines[0][0].sgr).toContain("38;2;248;113;113");
    app.unmount();
  });

  test("不确定进度：给 phase 就是一段滑块", () => {
    const app = mount(() => <ProgressBar value={0} width={10} indeterminate phase={0} />, {
      width: 20,
      height: 1,
    });
    expect(app.text().trim()).toBe("███░░░░░░░");
    app.unmount();
  });

  test("label 放在条前面", () => {
    const app = mount(() => <ProgressBar value={1} width={4} label="安装" />, {
      width: 20,
      height: 1,
    });
    expect(app.text().trim()).toBe("安装 ████");
    app.unmount();
  });
});

describe("Spinner", () => {
  test("受控 frame 决定字形", () => {
    const app = mount(() => <Spinner frame={1} label="思考中" />, { width: 20, height: 1 });
    expect(app.text()).toContain("⠙");
    expect(app.text()).toContain("思考中");
    app.unmount();
  });

  test("active=false 时停在第一帧", () => {
    const app = mount(() => <Spinner active={false} />, { width: 10, height: 1 });
    expect(app.text()).toContain("⠋");
    app.unmount();
  });

  test("自走：定时器推进帧号（挂载后自动重绘）", async () => {
    const app = mount(() => <Spinner interval={16} />, { width: 10, height: 1 });
    const first = app.text();
    await Bun.sleep(60);
    expect(app.text()).not.toBe(first);
    app.unmount();
  });

  test("卸载后定时器真的停掉（不是「看起来没事」）", () => {
    const cleared: unknown[] = [];
    const original = globalThis.clearInterval;
    globalThis.clearInterval = ((id: unknown) => {
      cleared.push(id);
      return (original as (id: unknown) => void)(id);
    }) as typeof clearInterval;

    try {
      const app = mount(() => <Spinner interval={16} />, { width: 10, height: 1 });
      app.unmount();
      // 清理必须真的发生：Solid 2 的 effect 只能靠**返回**清理函数
      expect(cleared).toHaveLength(1);
    } finally {
      globalThis.clearInterval = original;
    }
  });
});

describe("Badge / Divider / KeyHint", () => {
  test("Badge 默认方括号 + 主题色", () => {
    const app = mount(() => <Badge color="success">ok</Badge>, { width: 10, height: 1 });
    expect(app.text()).toContain("[ok]");
    expect(app.frame().lines[0][0].sgr).toContain("38;2;74;222;128");
    app.unmount();
  });

  test("Divider 铺满父容器宽度，且不带省略号", () => {
    const app = mount(() => <Divider />, { width: 12, height: 1 });
    expect(app.text()).toBe("─".repeat(12));
    app.unmount();
  });

  test("Divider 带标签", () => {
    const app = mount(() => <Divider label="工具输出" />, { width: 16, height: 1 });
    expect(app.text().startsWith("── 工具输出 ")).toBe(true);
    expect(app.text().endsWith("─")).toBe(true);
    app.unmount();
  });

  test("KeyHint 渲染快捷键提示", () => {
    const app = mount(
      () => <KeyHint hints={[["ctrl+c", "退出"], ["tab", "切换"]]} />,
      { width: 40, height: 1 }
    );
    expect(app.text()).toContain("ctrl+c 退出");
    expect(app.text()).toContain("tab 切换");
    app.unmount();
  });
});
