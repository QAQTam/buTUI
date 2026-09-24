import { describe, expect, test } from "bun:test";
import { FrameClock } from "@butui/core";
import { AnimationScheduler } from "@butui/solid";
import { mount } from "@butui/test";
import {
  DEFAULT_SMOOTH_FPS,
  StreamText,
  createMarkdownStream,
  createSmoothStream,
  createTextStream,
  stripAnsi,
} from "@butui/stream";

function manualScheduler() {
  const scheduler = new AnimationScheduler({ fps: 60, now: () => 0 });
  scheduler.stop();
  return scheduler;
}

function manualFrameClock() {
  let now = 0;
  const microtasks: Array<() => void> = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextHandle = 1;
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
    timers,
    microtasks,
    runMicrotasks() {
      for (const callback of microtasks.splice(0)) callback();
    },
  };
}

describe("createSmoothStream —— reveal cursor", () => {
  test("默认 120fps", () => {
    expect(DEFAULT_SMOOTH_FPS).toBe(120);
  });

  test("可注入共享 FrameClock 的 reveal lane", () => {
    const h = manualFrameClock();
    const source = createTextStream({ width: 20 });
    const smooth = createSmoothStream(source, {
      clock: h.clock,
      speed: 10,
      catchUpMs: 100_000,
      reducedMotion: false,
    });

    source.push("hello");
    expect(h.microtasks).toHaveLength(1);
    h.runMicrotasks();
    expect(h.clock.stats().lastDispatch?.ran).toEqual(["reveal"]);
    expect(h.timers.size).toBe(1);

    smooth.dispose();
    h.clock.dispose();
  });

  test("已有历史立即显示，挂载后的新内容才做 reveal", () => {
    const source = createTextStream({ width: 20 });
    source.push("history\n");

    const smooth = createSmoothStream(source, {
      speed: 10,
      reducedMotion: false,
    });

    expect(smooth.lines.map(line => stripAnsi(line.text))).toEqual(["history"]);
    expect(smooth.tail()).toBe("");
    expect(smooth.lag()).toBe(0);
    smooth.dispose();
  });

  test("已有尾部继续增长时，从原 cursor 位置接着流动", () => {
    const scheduler = manualScheduler();
    const source = createTextStream({ width: 20 });
    source.push("hello");
    const smooth = createSmoothStream(source, {
      speed: 10,
      catchUpMs: 100_000,
      reducedMotion: false,
      scheduler,
    });
    scheduler.stop();

    source.push(" world");
    expect(smooth.tail()).toBe("hello");
    scheduler.tick(0);
    scheduler.tick(100);
    expect(smooth.tail()).toBe("hello ");
    scheduler.tick(200);
    expect(smooth.tail()).toBe("hello w");
    smooth.dispose();
  });

  test("按列推进，不会因为 chunk 到达就整段跳出", () => {
    const scheduler = manualScheduler();
    const source = createTextStream({ width: 20 });
    const smooth = createSmoothStream(source, {
      speed: 10,
      catchUpMs: 100_000,
      reducedMotion: false,
      scheduler,
    });
    scheduler.stop();

    source.push("hello");
    expect(smooth.tail()).toBe("");
    expect(smooth.lag()).toBe(5);

    scheduler.tick(0);
    expect(smooth.tail()).toBe("");
    scheduler.tick(100);
    expect(smooth.tail()).toBe("h");
    scheduler.tick(200);
    expect(smooth.tail()).toBe("he");
    scheduler.tick(300);
    expect(smooth.tail()).toBe("hel");
    smooth.dispose();
  });

  test("CJK / emoji 按 grapheme 边界切片", () => {
    const scheduler = manualScheduler();
    const source = createTextStream({ width: 20 });
    const smooth = createSmoothStream(source, {
      speed: 10,
      catchUpMs: 100_000,
      reducedMotion: false,
      scheduler,
    });
    scheduler.stop();

    source.push("你a");
    scheduler.tick(0);
    scheduler.tick(100);
    expect(smooth.tail()).toBe("你");
    scheduler.tick(200);
    expect(smooth.tail()).toBe("你");
    scheduler.tick(300);
    expect(smooth.tail()).toBe("你a");
    smooth.dispose();
  });

  test("Markdown ANSI 在 reveal 过程中保持样式", () => {
    const scheduler = manualScheduler();
    const source = createMarkdownStream({ width: 20 });
    const smooth = createSmoothStream(source, {
      speed: 10,
      catchUpMs: 100_000,
      reducedMotion: false,
      scheduler,
    });
    scheduler.stop();

    source.push("**hi**");
    scheduler.tick(0);
    scheduler.tick(100);
    expect(smooth.tail()).toContain("\x1b[1m");
    expect(stripAnsi(smooth.tail())).toBe("h");
    scheduler.tick(200);
    expect(stripAnsi(smooth.tail())).toBe("hi");
    smooth.dispose();
  });

  test("积压时加速追赶，但单帧不会一次喷完", () => {
    const scheduler = manualScheduler();
    const source = createTextStream({ width: 20 });
    const smooth = createSmoothStream(source, {
      speed: 10,
      catchUpMs: 180,
      maxColumnsPerFrame: 64,
      reducedMotion: false,
      scheduler,
    });
    scheduler.stop();

    source.push("x".repeat(1000));
    scheduler.tick(0);
    scheduler.tick(16);

    const shown =
      smooth.lines.reduce((sum, line) => sum + Bun.stringWidth(line.text), 0) +
      Bun.stringWidth(smooth.tail());
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(100);
    expect(smooth.lag()).toBeGreaterThan(0);

    smooth.finish();
    expect(smooth.lag()).toBe(0);
    smooth.dispose();
  });

  test("cursor 没跨过可见列时不触发版本 / Solid 更新", () => {
    const scheduler = manualScheduler();
    const source = createTextStream({ width: 20 });
    const smooth = createSmoothStream(source, {
      speed: 1,
      catchUpMs: 100_000,
      reducedMotion: false,
      scheduler,
    });
    scheduler.stop();
    source.push("abcdef");

    scheduler.tick(0); // flush 初始版本并建立时钟基线
    const initialVersion = smooth.version();
    for (let time = 8; time <= 400; time += 8) scheduler.tick(time);
    expect(smooth.version()).toBe(initialVersion);
    expect(smooth.tail()).toBe("");
    expect(smooth.stats.smoothSkippedTicks).toBeGreaterThan(0);
    smooth.dispose();
  });

  test("revealed lines 复用 source 行对象，不复制文本", () => {
    const source = createTextStream({ width: 20 });
    for (let i = 0; i < 500; i++) source.push(`line ${i}\n`);

    const smooth = createSmoothStream(source, {
      speed: 10,
      reducedMotion: false,
    });

    expect(smooth.lines.length).toBe(500);
    expect(smooth.lines[0]).toBe(source.lines[0]);
    expect(smooth.lines[499]).toBe(source.lines[499]);
    expect(smooth.stats.revealLines).toBe(500);
    expect(smooth.stats.revealPendingWidths).toBe(0);
    smooth.dispose();
  });
});

describe("<StreamText smooth>", () => {
  test("组件接入 reveal，卸载时退订时钟", () => {
    const scheduler = manualScheduler();
    const source = createTextStream({ width: 20 });
    const app = mount(
      () => (
        <StreamText
          source={source}
          smooth={{
            speed: 10,
            catchUpMs: 100_000,
            reducedMotion: false,
            scheduler,
          }}
        />
      ),
      { width: 20, height: 4 }
    );

    source.push("hello");
    scheduler.stop();
    expect(app.text()).toBe("");

    scheduler.tick(0);
    scheduler.tick(100);
    expect(app.text()).toBe("h");

    app.unmount();
    expect(scheduler.size).toBe(0);
  });
});
