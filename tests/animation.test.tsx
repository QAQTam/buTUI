import { describe, expect, test } from "bun:test";
import { AnimationScheduler, prefersReducedMotion, useAnimationFrame } from "@butui/solid";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

describe("AnimationScheduler", () => {
  test("手动 tick 广播时间，最后一个订阅者退出后停表", () => {
    const scheduler = new AnimationScheduler({ now: () => 100 });
    const seen: number[] = [];
    const off = scheduler.subscribe(time => seen.push(time));
    scheduler.stop(); // 测试不用真实定时器

    scheduler.tick(120);
    expect(seen).toEqual([120]);
    expect(scheduler.size).toBe(1);

    off();
    expect(scheduler.size).toBe(0);
    expect(scheduler.active).toBe(false);
  });

  test("useAnimationFrame 响应 enabled，组件卸载自动退订", () => {
    const scheduler = new AnimationScheduler({ now: () => 0 });
    const [enabled, setEnabled] = createSignal(true);
    const app = mount(
      () => {
        const time = useAnimationFrame({ scheduler, enabled });
        return <text>{`t=${time()}`}</text>;
      },
      { width: 12, height: 1 }
    );
    scheduler.stop();
    expect(scheduler.size).toBe(1);

    scheduler.tick(180);
    app.flush();
    expect(app.text()).toBe("t=180");

    setEnabled(false);
    app.flush();
    expect(scheduler.size).toBe(0);

    app.unmount();
    expect(scheduler.size).toBe(0);
  });

  test("reduced-motion 环境降级", () => {
    expect(prefersReducedMotion({ BUTUI_REDUCED_MOTION: "1" })).toBe(true);
    expect(prefersReducedMotion({ BUTUI_REDUCED_MOTION: "true" })).toBe(true);
    expect(prefersReducedMotion({ TERM: "dumb" })).toBe(true);
    expect(prefersReducedMotion({ TERM: "xterm-256color" })).toBe(false);
  });
});
