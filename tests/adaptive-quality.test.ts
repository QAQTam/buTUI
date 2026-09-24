import { describe, expect, test } from "bun:test";
import { AdaptiveQuality } from "@butui/core";

describe("AdaptiveQuality", () => {
  test("连续 compute 超预算后降一级，不直接跳到最低档", () => {
    const quality = new AdaptiveQuality({
      initial: "full",
      downgradeAfter: 3,
      targetIntervalMs: 10,
      sampleWindow: 10,
    });

    for (let i = 0; i < 3; i++) {
      quality.recordDispatch({
        at: i * 10,
        computeMs: 10,
        budgetMs: 6,
        skipped: 0,
      });
    }

    expect(quality.current()).toBe("balanced");
  });

  test("blocked ratio 超阈值会触发降级", () => {
    const quality = new AdaptiveQuality({
      initial: "full",
      downgradeAfter: 1,
      blockedWindowMs: 1000,
    });

    quality.recordBlocked(0);
    quality.recordDrained(200);

    expect(quality.signals(200).blockedRatio).toBeCloseTo(0.2);
    expect(quality.current()).toBe("balanced");
  });

  test("连续好样本达到升档时长后才恢复", () => {
    const quality = new AdaptiveQuality({
      initial: "balanced",
      upgradeAfterMs: 1000,
      targetIntervalMs: 10,
      sampleWindow: 10,
    });

    quality.setQuality("responsive");
    quality.recordDispatch({ at: 0, computeMs: 1, budgetMs: 8, skipped: 0 });
    quality.recordDispatch({ at: 500, computeMs: 1, budgetMs: 8, skipped: 0 });
    expect(quality.current()).toBe("responsive");

    quality.recordDispatch({ at: 1001, computeMs: 1, budgetMs: 8, skipped: 0 });
    expect(quality.current()).toBe("balanced");
  });

  test("skipped frame 达到阈值后降级", () => {
    const quality = new AdaptiveQuality({
      initial: "full",
      downgradeAfter: 3,
      targetIntervalMs: 10,
    });

    for (let i = 0; i < 3; i++) {
      quality.recordDispatch({
        at: i,
        computeMs: 1,
        budgetMs: 6,
        skipped: 3,
      });
    }

    expect(quality.current()).toBe("balanced");
  });

  test("setQuality 受 min / max 约束", () => {
    const quality = new AdaptiveQuality({
      initial: "balanced",
      min: "responsive",
      max: "balanced",
    });

    expect(quality.setQuality("minimal")).toBe("responsive");
    expect(quality.setQuality("full")).toBe("balanced");
  });
});
