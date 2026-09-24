import { describe, expect, test } from "bun:test";
import { RenderScheduler, type RenderOptions } from "../packages/runtime/src/render-scheduler.ts";

interface Scheduled {
  at: number;
  callback: () => void;
}

function schedulerHarness(options: RenderOptions) {
  let now = 0;
  let frames = 0;
  let nextHandle = 1;
  const timers = new Map<number, Scheduled>();
  const microtasks: Array<() => void> = [];
  let scheduler!: RenderScheduler;

  scheduler = new RenderScheduler(
    () => {
      frames++;
      scheduler.markPainted();
    },
    options,
    {
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
    }
  );

  const runNextTimer = (): number => {
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) throw new Error("no timer scheduled");
    const [handle, timer] = next;
    timers.delete(handle);
    now = timer.at;
    timer.callback();
    return timer.at;
  };

  return {
    scheduler,
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    get frames() {
      return frames;
    },
    timers,
    microtasks,
    runNextTimer,
  };
}

describe("RenderScheduler —— 高频 chunk 合帧", () => {
  test("frame 模式在帧预算内合并且不重置尾帧", () => {
    const h = schedulerHarness({ mode: "frame", fps: 20 });
    h.scheduler.markPainted(); // frame 0，下一次最早在 50ms

    h.now = 5;
    h.scheduler.request();
    h.now = 10;
    h.scheduler.request();

    expect(h.timers.size).toBe(1);
    expect([...h.timers.values()][0]?.at).toBe(50);
    expect(h.frames).toBe(0);

    h.runNextTimer();
    expect(h.frames).toBe(1);

    h.now = 55;
    h.scheduler.request();
    h.now = 80;
    h.scheduler.request();
    expect([...h.timers.values()][0]?.at).toBe(100);

    h.runNextTimer();
    expect(h.frames).toBe(2);
  });

  test("空闲后的第一个 request 走微任务，不额外等一整帧", () => {
    const h = schedulerHarness({ mode: "frame", fps: 20 });
    h.scheduler.markPainted();

    h.now = 50;
    h.scheduler.request();
    h.scheduler.request();

    expect(h.timers.size).toBe(0);
    expect(h.microtasks).toHaveLength(1);
    h.microtasks.shift()?.();
    expect(h.frames).toBe(1);
  });

  test("dispose 后取消 timer，并拒绝后续 request", () => {
    const h = schedulerHarness({ mode: "frame", fps: 20 });
    h.scheduler.markPainted();
    h.now = 1;
    h.scheduler.request();
    h.scheduler.dispose();

    expect(h.timers.size).toBe(0);
    h.now = 100;
    h.scheduler.request();
    expect(h.timers.size).toBe(0);
    expect(h.microtasks).toHaveLength(0);
  });
});
