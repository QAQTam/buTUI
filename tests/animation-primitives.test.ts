import { describe, expect, test } from "bun:test";
import {
  AnimationScheduler,
  createSpring,
  createTimeline,
  createTween,
  interpolateTween,
  linear,
  sequenceSteps,
  staggerSteps,
} from "@butui/solid";

const scheduler = (): AnimationScheduler => {
  const value = new AnimationScheduler({ now: () => 0 });
  value.stop();
  return value;
};

describe("createTween", () => {
  test("按 duration / delay / easing 更新并完成", () => {
    const clock = scheduler();
    const updates: Array<[number, number]> = [];
    let completed = 0;
    const tween = createTween({
      from: 0,
      to: 100,
      duration: 100,
      delay: 20,
      easing: linear,
      autoplay: false,
      reducedMotion: false,
      scheduler: clock,
      onUpdate: (value, progress) => updates.push([value, progress]),
      onComplete: () => completed++,
    });

    tween.start();
    clock.stop();
    clock.tick(0);
    clock.tick(20);
    clock.tick(70);
    clock.tick(120);

    expect(tween.value()).toBe(100);
    expect(tween.progress()).toBe(1);
    expect(tween.active()).toBe(false);
    expect(completed).toBe(1);
    expect(updates).toContainEqual([50, 0.5]);
    expect(clock.size).toBe(0);
  });

  test("数值与颜色插值", () => {
    expect(interpolateTween(0, 10, 0.25)).toBe(2.5);
    expect(interpolateTween("#000000", "#ffffff", 0.5)).toBe(
      "rgba(128, 128, 128, 1)"
    );
  });

  test("reduced-motion 直接到终点", () => {
    const tween = createTween({
      from: 0,
      to: 1,
      duration: 100,
      reducedMotion: true,
    });
    expect(tween.value()).toBe(1);
    expect(tween.progress()).toBe(1);
    expect(tween.active()).toBe(false);
  });
});

describe("createSpring", () => {
  test("阻尼积分收敛到目标并自动退订", () => {
    const clock = scheduler();
    const spring = createSpring({
      from: 0,
      to: 10,
      reducedMotion: false,
      scheduler: clock,
    });

    clock.stop();
    for (let time = 0; time <= 2000 && spring.active(); time += 16) {
      clock.tick(time);
    }

    expect(spring.value()).toBeCloseTo(10, 1);
    expect(spring.velocity()).toBe(0);
    expect(spring.progress()).toBe(1);
    expect(clock.size).toBe(0);
  });
});

describe("createTimeline", () => {
  test("sequenceSteps 串行推进", () => {
    const clock = scheduler();
    const events: string[] = [];
    const timeline = createTimeline({
      reducedMotion: false,
      scheduler: clock,
      steps: sequenceSteps([
        {
          duration: 10,
          onUpdate: progress => events.push(`a:${progress}`),
          onComplete: () => events.push("a:done"),
        },
        {
          duration: 10,
          onUpdate: progress => events.push(`b:${progress}`),
          onComplete: () => events.push("b:done"),
        },
      ]),
      onComplete: () => events.push("timeline:done"),
    });

    clock.stop();
    clock.tick(0);
    clock.tick(10);
    clock.tick(20);

    expect(events).toContain("a:done");
    expect(events).toContain("b:1");
    expect(events).toContain("b:done");
    expect(events).toContain("timeline:done");
    expect(timeline.active()).toBe(false);
    expect(clock.size).toBe(0);
  });

  test("staggerSteps 按间隔启动", () => {
    const clock = scheduler();
    const started: number[] = [];
    const timeline = createTimeline({
      reducedMotion: false,
      scheduler: clock,
      steps: staggerSteps(3, {
        interval: 10,
        duration: 10,
        onStart: index => started.push(index),
        onUpdate: () => {},
      }),
    });

    clock.stop();
    clock.tick(0);
    clock.tick(1);
    expect(started).toEqual([0]);
    clock.tick(11);
    expect(started).toEqual([0, 1]);
    clock.tick(21);
    expect(started).toEqual([0, 1, 2]);
    clock.tick(31);
    expect(timeline.active()).toBe(false);
  });
});
