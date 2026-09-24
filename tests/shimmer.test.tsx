import { describe, expect, test } from "bun:test";
import { Shimmer, shimmerSegments } from "@butui/components";
import { AnimationScheduler } from "@butui/solid";
import { mount } from "@butui/test";

describe("shimmerSegments", () => {
  test("word / cell 分段保持原文且不拆 CJK grapheme", () => {
    const word = shimmerSegments("hello 世界", {
      granularity: "word",
      phase: 0.5,
      highlightWidth: 4,
    });
    const cell = shimmerSegments("👨‍👩‍👧a", {
      granularity: "cell",
      phase: 0.5,
      highlightWidth: 2,
    });

    expect(word.map(segment => segment.text).join("")).toBe("hello 世界");
    expect(cell.map(segment => segment.text).join("")).toBe("👨‍👩‍👧a");
    expect(cell.some(segment => segment.width === 2)).toBe(true);
  });

  test("line 只返回一段，inactive 全部回到基础色", () => {
    expect(shimmerSegments("thinking", { granularity: "line" })).toHaveLength(1);
    expect(
      shimmerSegments("thinking", { active: false }).every(segment => segment.intensity === 0)
    ).toBe(true);
  });
});

describe("<Shimmer>", () => {
  test("渲染原文并保持单行", () => {
    const app = mount(() => <Shimmer text="thinking..." />, {
      width: 20,
      height: 1,
    });

    expect(app.text()).toBe("thinking...");
    app.unmount();
  });

  test("inactive / reduced-motion 不订阅动画", () => {
    const scheduler = new AnimationScheduler({ now: () => 0 });
    scheduler.stop();
    const app = mount(
      () => (
        <Shimmer
          text="thinking"
          active
          reducedMotion
          scheduler={scheduler}
        />
      ),
      { width: 20, height: 1 }
    );

    expect(app.text()).toBe("thinking");
    expect(scheduler.size).toBe(0);
    app.unmount();
  });

  test("受控 phase 只改变颜色，不改变文本", () => {
    const app = mount(
      () => (
        <Shimmer
          text="thinking"
          granularity="cell"
          phase={0.5}
          baseColor="#000000"
          highlightColor="#ffffff"
        />
      ),
      { width: 20, height: 1 }
    );

    expect(app.text()).toBe("thinking");
    expect(app.frame().lines[0]?.some(cell => cell.sgr.includes("38;2"))).toBe(true);
    app.unmount();
  });
});
