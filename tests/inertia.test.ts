import { describe, expect, test } from "bun:test";
import { AnimationScheduler, startDragInertia } from "@butui/solid";

describe("startDragInertia", () => {
  test("按指数衰减累计整数 cell，并在低速时自动停止", () => {
    const scheduler = new AnimationScheduler({ now: () => 0 });
    scheduler.stop();
    const steps: Array<[number, number]> = [];
    let ended = 0;
    const inertia = startDragInertia({
      velocityX: 0.1,
      decay: 0.01,
      minVelocity: 0.01,
      maxDuration: 1000,
      scheduler,
      onStep: (x, y) => steps.push([x, y]),
      onEnd: () => ended++,
    });

    expect(inertia.active()).toBe(true);
    scheduler.tick(0);
    scheduler.tick(100);
    scheduler.tick(200);
    scheduler.tick(300);
    scheduler.tick(400);

    expect(steps).toEqual([
      [4, 0],
      [3, 0],
      [1, 0],
      [1, 0],
    ]);
    expect(inertia.active()).toBe(false);
    expect(ended).toBe(1);
    expect(scheduler.size).toBe(0);
  });

  test("cancel 退订并只回调一次", () => {
    const scheduler = new AnimationScheduler({ now: () => 0 });
    scheduler.stop();
    let ended = 0;
    const inertia = startDragInertia({
      velocityY: 0.1,
      scheduler,
      onStep: () => {},
      onEnd: () => ended++,
    });

    inertia.cancel();
    inertia.cancel();
    expect(inertia.active()).toBe(false);
    expect(ended).toBe(1);
    expect(scheduler.size).toBe(0);
  });

  test("速度不足或 enabled=false 时不订阅", () => {
    const scheduler = new AnimationScheduler({ now: () => 0 });
    scheduler.stop();
    const slow = startDragInertia({
      velocityX: 0.001,
      scheduler,
      onStep: () => {},
    });
    const disabled = startDragInertia({
      velocityX: 1,
      enabled: false,
      scheduler,
      onStep: () => {},
    });

    expect(slow.active()).toBe(false);
    expect(disabled.active()).toBe(false);
    expect(scheduler.size).toBe(0);
  });
});
