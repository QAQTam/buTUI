import { describe, expect, test } from "bun:test";
import {
  AdaptiveQuality,
  FrameClock,
  type FrameClockOptions,
  type FrameRequest,
} from "@butui/core";

interface Scheduled {
  at: number;
  callback: () => void;
}

function clockHarness(options: FrameClockOptions = {}) {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, Scheduled>();
  const microtasks: Array<() => void> = [];

  const clock = new FrameClock(options, {
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
    runNextTimer(): number {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) throw new Error("no timer scheduled");
      const [handle, timer] = next;
      timers.delete(handle);
      now = timer.at;
      timer.callback();
      return timer.at;
    },
  };
}

function request(
  lane: FrameRequest["lane"],
  work: FrameRequest["work"],
  overrides: Partial<FrameRequest> = {}
): FrameRequest {
  return {
    lane,
    reason: `${lane}:test`,
    sessionRevision: 1,
    work,
    ...overrides,
  };
}

describe("FrameClock P0-A", () => {
  test("同一 coalesceKey 只执行最新 revision，cancel 可取消未执行请求", () => {
    const h = clockHarness();
    const ran: number[] = [];

    h.clock.request(
      request(
        "critical",
        () => {
          ran.push(1);
        },
        { coalesceKey: "runtime-frame", sessionRevision: 1 }
      )
    );
    h.clock.request(
      request(
        "critical",
        () => {
          ran.push(2);
        },
        { coalesceKey: "runtime-frame", sessionRevision: 2 }
      )
    );

    expect(h.microtasks).toHaveLength(1);
    h.runMicrotasks();
    expect(ran).toEqual([2]);

    h.now = 20;
    const cancelled = h.clock.request(
      request(
        "critical",
        () => {
          ran.push(3);
        },
        {
          coalesceKey: "cancelled",
          sessionRevision: 3,
        }
      )
    );
    cancelled.cancel();
    h.clock.request(
      request(
        "critical",
        () => {
          ran.push(4);
        },
        {
          coalesceKey: "cancelled",
          sessionRevision: 4,
        }
      )
    );
    h.runMicrotasks();
    expect(ran).toEqual([2, 4]);
    h.clock.dispose();
  });

  test("timer 早于 deadline 触发时会重新调度，不会永久停帧", () => {
    const h = clockHarness({ fps: 120 });
    const frames: number[] = [];

    h.now = 100;
    h.clock.request(
      request("critical", () => {
        frames.push(1);
      })
    );
    h.runMicrotasks();
    expect(frames).toEqual([1]);

    h.now = 102;
    h.clock.request(
      request(
        "critical",
        () => {
          frames.push(2);
        },
        { coalesceKey: "next" }
      )
    );
    const [handle, timer] = [...h.timers.entries()][0]!;
    h.timers.delete(handle);
    h.now = timer.at - 0.5;
    timer.callback();

    expect(h.timers.size).toBe(1);
    h.runNextTimer();
    expect(frames).toEqual([1, 2]);
    h.clock.dispose();
  });

  test("空闲后的第一次 request 走 microtask，后续请求按帧预算排队", () => {
    const h = clockHarness({ fps: 20 });
    const frames: number[] = [];

    h.clock.request(
      request(
        "critical",
        () => {
          frames.push(1);
        },
        { coalesceKey: "runtime-frame" }
      )
    );
    expect(h.microtasks).toHaveLength(1);
    expect(h.timers.size).toBe(0);
    h.runMicrotasks();
    expect(frames).toEqual([1]);

    h.now = 5;
    h.clock.request(
      request(
        "critical",
        () => {
          frames.push(2);
        },
        { coalesceKey: "runtime-frame", sessionRevision: 2 }
      )
    );
    h.now = 10;
    h.clock.request(
      request(
        "critical",
        () => {
          frames.push(3);
        },
        { coalesceKey: "runtime-frame", sessionRevision: 3 }
      )
    );
    expect(h.timers.size).toBe(1);
    expect([...h.timers.values()][0]?.at).toBe(50);

    h.runNextTimer();
    expect(frames).toEqual([1, 3]);
    h.clock.dispose();
  });

  test("critical 优先执行，超预算时 reveal 延后到下一帧", () => {
    const h = clockHarness({ fps: 20, budgetMs: 1 });
    const ran: string[] = [];

    h.clock.request(
      request("reveal", () => {
        ran.push("reveal");
      })
    );
    h.clock.request(
      request("critical", () => {
        ran.push("critical");
        h.now += 1;
      })
    );

    h.runMicrotasks();
    expect(ran).toEqual(["critical"]);
    expect(h.clock.stats().lastDispatch?.ran).toEqual(["critical"]);
    expect(h.clock.stats().lastDispatch?.skipped).toEqual(["reveal"]);
    expect(h.clock.stats().skipped).toBe(1);

    h.runNextTimer();
    expect(ran).toEqual(["critical", "reveal"]);
    h.clock.dispose();
  });

  test("blocked 时不 dispatch，drain 后只执行最新 revision", () => {
    const h = clockHarness({ fps: 20 });
    const ran: number[] = [];

    h.clock.request(
      request(
        "critical",
        () => {
          ran.push(1);
        },
        { coalesceKey: "runtime-frame", sessionRevision: 1 }
      )
    );
    h.clock.settle({ status: "blocked", frameId: 1, at: 0 });
    h.runMicrotasks();
    expect(ran).toEqual([]);

    h.clock.request(
      request(
        "critical",
        () => {
          ran.push(2);
        },
        { coalesceKey: "runtime-frame", sessionRevision: 2 }
      )
    );
    h.clock.settle({ status: "drained", frameId: 1, at: 10 });
    h.runMicrotasks();

    expect(ran).toEqual([2]);
    expect(h.clock.isBlocked).toBe(false);
    h.clock.dispose();
  });

  test("work 返回更高 revision 时会保留尾帧", () => {
    const h = clockHarness({ fps: 20 });
    const revisions: number[] = [];

    h.clock.request(
      request(
        "critical",
        tick => {
          revisions.push(tick.sessionRevision);
          if (tick.sessionRevision === 1) {
            return { status: "dirty", revision: 2 };
          }
        },
        { coalesceKey: "runtime-frame", sessionRevision: 1 }
      )
    );

    h.runMicrotasks();
    expect(revisions).toEqual([1]);
    h.runNextTimer();
    expect(revisions).toEqual([1, 2]);
    h.clock.dispose();
  });

  test("advanceTo 在 fake clock 下可重复得到相同 frame 序列", () => {
    const run = (): number[] => {
      const h = clockHarness({ fps: 10 });
      const ids: number[] = [];
      h.clock.request(
        request(
          "critical",
          tick => {
            ids.push(tick.frameId);
          },
          { coalesceKey: "runtime-frame" }
        )
      );
      h.now = 100;
      h.clock.advanceTo(100);
      h.now = 200;
      h.clock.request(
        request(
          "critical",
          tick => {
            ids.push(tick.frameId);
          },
          { coalesceKey: "runtime-frame", sessionRevision: 2 }
        )
      );
      h.clock.advanceTo(200);
      h.clock.dispose();
      return ids;
    };

    expect(run()).toEqual([1, 2]);
    expect(run()).toEqual([1, 2]);
  });

  test("dispose 清空队列并拒绝新工作", () => {
    const h = clockHarness();
    let ran = 0;
    h.clock.request(
      request("critical", () => {
        ran++;
      })
    );
    h.clock.dispose();
    h.runMicrotasks();

    h.clock.request(
      request("critical", () => {
        ran++;
      })
    );
    h.runMicrotasks();
    expect(ran).toBe(0);
    expect(h.clock.active).toBe(false);
  });

  test("AdaptiveQuality 可在 dispatch 后自动降级", () => {
    const controller = new AdaptiveQuality({
      initial: "full",
      downgradeAfter: 3,
      targetIntervalMs: 50,
    });
    const h = clockHarness({ fps: 20, qualityController: controller });

    for (let i = 0; i < 3; i++) {
      h.now += 50;
      h.clock.request(
        request(
          "critical",
          () => {
            h.now += 8;
          },
          { coalesceKey: `frame-${i}`, sessionRevision: i + 1, deadline: h.now }
        )
      );
      h.clock.advanceTo(h.now);
    }

    expect(h.clock.stats().quality).toBe("balanced");
    expect(h.clock.stats().qualitySignals?.computeP95Ms).toBeGreaterThan(6);
    h.clock.dispose();
  });
});
