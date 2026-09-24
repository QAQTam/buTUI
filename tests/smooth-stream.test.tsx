import { describe, expect, test } from "bun:test";
import { AnimationScheduler } from "@butui/solid";
import { mount } from "@butui/test";
import {
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

describe("createSmoothStream —— reveal cursor", () => {
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
