import { describe, expect, test } from "bun:test";
import { FrameClock } from "@butui/core";
import { AnimationScheduler, prefersReducedMotion, useAnimationFrame } from "@butui/solid";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

function manualFrameClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const microtasks: Array<() => void> = [];
  const clock = new FrameClock({ fps: 120 }, {
    now: () => now,
    queueMicrotask: callback => {
      microtasks.push(callback);
    },
    setTimeout: (callback, delay) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + delay, callback });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: handle => {
      timers.delete(handle as unknown as number);
    },
  });

  return {
    clock,
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    timers,
    microtasks,
    runMicrotasks() {
      for (const callback of microtasks.splice(0)) callback();
    },
    runNextTimer() {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) throw new Error("no timer scheduled");
      const [handle, timer] = next;
      timers.delete(handle);
      now = timer.at;
      timer.callback();
    },
  };
}

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

  test("可注入共享 FrameClock，并按自己的 fps 排队", () => {
    const h = manualFrameClock();
    const scheduler = new AnimationScheduler({
      fps: 30,
      clock: h.clock,
      now: () => h.now,
    });
    const seen: number[] = [];
    const off = scheduler.subscribe(time => seen.push(time));

    h.runMicrotasks();
    expect(seen).toEqual([0]);

    h.now = 10;
    expect(h.timers.size).toBe(1);
    expect([...h.timers.values()][0]?.at).toBe(33);
    h.runNextTimer();
    expect(seen).toEqual([0, 33]);

    off();
    expect(scheduler.active).toBe(false);
    h.clock.dispose();
  });

  test("reduced-motion 环境降级", () => {
    expect(prefersReducedMotion({ BUTUI_REDUCED_MOTION: "1" })).toBe(true);
    expect(prefersReducedMotion({ BUTUI_REDUCED_MOTION: "true" })).toBe(true);
    expect(prefersReducedMotion({ TERM: "dumb" })).toBe(true);
    expect(prefersReducedMotion({ TERM: "xterm-256color" })).toBe(false);
  });
});
