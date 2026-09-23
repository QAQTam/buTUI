import { describe, expect, test } from "bun:test";
import {
  type ButuiEvent,
  type KeyEvent,
  type MouseEvent,
  createModifiers,
  focusNode,
  getFocusState,
} from "@butui/core";
import { type TuiSize, type TuiTerminal, createTuiApp } from "@butui/runtime";
import { For, createSignal } from "solid-js";

/** 假终端：不碰 TTY，只记录写出的字节，事件手动注入 */
class FakeTerminal implements TuiTerminal {
  output = "";
  started = false;
  stopped = false;
  size: TuiSize = { columns: 40, rows: 6 };
  colorDepth = "truecolor" as const;
  private events: Array<(event: ButuiEvent) => void> = [];
  private resizes: Array<(size: TuiSize) => void> = [];

  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  write(chunk: string): void {
    this.output += chunk;
  }
  onEvent(listener: (event: ButuiEvent) => void): () => void {
    this.events.push(listener);
    return () => {
      this.events = this.events.filter(l => l !== listener);
    };
  }
  onResize(listener: (size: TuiSize) => void): () => void {
    this.resizes.push(listener);
    return () => {
      this.resizes = this.resizes.filter(l => l !== listener);
    };
  }
  emit(event: ButuiEvent): void {
    for (const listener of [...this.events]) listener(event);
  }
  resize(size: TuiSize): void {
    this.size = size;
    for (const listener of [...this.resizes]) listener(size);
  }
}

/** 等一帧：runtime 用 queueMicrotask 合帧，sleep(0) 必然在它之后 */
const tick = (): Promise<void> => Bun.sleep(0);

const key = (name: string, text?: string, modifiers?: Partial<KeyEvent["modifiers"]>): KeyEvent =>
  ({
    type: "key",
    name,
    ...(text !== undefined ? { text } : {}),
    modifiers: createModifiers(
      modifiers?.ctrl ?? false,
      modifiers?.alt ?? false,
      modifiers?.shift ?? false,
      modifiers?.meta ?? false
    ),
  }) as KeyEvent;

const mouse = (x: number, y: number): MouseEvent =>
  ({
    type: "mouse",
    action: "press",
    button: "left",
    x,
    y,
    modifiers: createModifiers(),
  }) as MouseEvent;

describe("@butui/runtime —— 应用作者的唯一入口（SPEC §6 / §17）", () => {
  test("视图拿到 app：可以直接读 size()", () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      view: runtime => <text>{`${runtime.size().columns}x${runtime.size().rows}`}</text>,
      onQuit: () => {},
    });
    expect(app.frame().text()).toContain("40x6");
    app.dispose();
  });

  test("变更自动重绘：改一个 signal，不需要调任何 paint API", async () => {
    const terminal = new FakeTerminal();
    const [value, setValue] = createSignal("before");

    const app = createTuiApp({
      terminal,
      view: () => <text>{value()}</text>,
      onQuit: () => {},
    });
    expect(terminal.output).toContain("before");

    terminal.output = "";
    setValue("after");
    await tick();

    // 没有 requestPaint / paint / flush —— 全靠 core 的变更通知
    expect(terminal.output).toContain("after");
    app.dispose();
  });

  test("同一 tick 内多次变更只画一帧（合帧）", async () => {
    const terminal = new FakeTerminal();
    const [a, setA] = createSignal(0);
    const [b, setB] = createSignal(0);

    const app = createTuiApp({
      terminal,
      view: () => (
        <box>
          <text>{`a=${a()}`}</text>
          <text>{`b=${b()}`}</text>
        </box>
      ),
      onQuit: () => {},
    });

    terminal.output = "";
    setA(1);
    setB(2);
    setA(3);
    await tick();

    // 一帧 = 一次 cursor home + 一次清屏（首帧之后不再清屏）
    expect(terminal.output).toContain("a=3");
    expect(terminal.output).toContain("b=2");
    expect(terminal.output.split("\x1b[").length).toBeLessThan(12);
    app.dispose();
  });

  test("键位顺序：应用级 onKey 先，返回 true 就不再派发给焦点节点", () => {
    const terminal = new FakeTerminal();
    const seen: string[] = [];

    const app = createTuiApp({
      terminal,
      view: () => (
        <box focusable onKey={() => seen.push("node")}>
          <text>focused</text>
        </box>
      ),
      onKey: event => {
        seen.push(`app:${event.name}`);
        return event.name === "x";
      },
      onQuit: () => {},
    });
    focusNode(app.root, app.root.children[0]);

    app.send(key("x"));
    expect(seen).toEqual(["app:x"]); // 被应用层吃掉

    app.send(key("y"));
    expect(seen).toEqual(["app:x", "app:y", "node"]); // 落到焦点节点
    app.dispose();
  });

  test("内建：tab / shift+tab 循环焦点，ctrl+c 退出", () => {
    const terminal = new FakeTerminal();
    let quit = 0;
    const app = createTuiApp({
      terminal,
      view: () => (
        <box>
          <text focusable>one</text>
          <text focusable>two</text>
        </box>
      ),
      onQuit: () => {
        quit++;
      },
    });

    const focusIds = () => getFocusState(app.root).current;
    expect(focusIds()).toBeNull();

    app.send(key("tab"));
    const first = focusIds();
    expect(first).not.toBeNull();
    app.send(key("tab"));
    expect(focusIds()).not.toBe(first);
    app.send(key("tab", undefined, { shift: true }));
    expect(focusIds()).toBe(first);

    app.send(key("c", undefined, { ctrl: true }));
    expect(quit).toBe(1);
    expect(terminal.stopped).toBe(true);
    app.dispose();
  });

  test("鼠标：命中节点 → 节点 handler；没命中 → 应用级 onMouse", () => {
    const terminal = new FakeTerminal();
    const hits: string[] = [];

    const app = createTuiApp({
      terminal,
      view: () => (
        <box>
          <box semantic="card:1" onClick={() => hits.push("card")}>
            <text>clickable</text>
          </box>
        </box>
      ),
      onMouse: event => {
        hits.push(`app:${event.semantic ?? "?"}`);
      },
      onQuit: () => {},
    });

    app.send(mouse(2, 0)); // 点在卡片上
    expect(hits).toEqual(["card"]);

    app.send(mouse(2, 5)); // 点在空白处（root 没 handler）
    expect(hits).toEqual(["card", "app:?"]);
    app.dispose();
  });

  test("resize：尺寸信号更新 + 整屏重画", async () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      view: runtime => <text>{`${runtime.size().columns}`}</text>,
      onQuit: () => {},
    });
    expect(app.size().columns).toBe(40);

    terminal.output = "";
    terminal.resize({ columns: 20, rows: 4 });
    await tick();

    expect(app.size().columns).toBe(20);
    expect(terminal.output).toContain("20");
    expect(terminal.output).toContain("\x1b[2J"); // 尺寸变化必须整屏重画
    app.dispose();
  });

  test("afterDraw 钩子：帧内容之后追加（原生图片图层走这里）", async () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      view: () => <text>body</text>,
      afterDraw: (frame, stats) => `<g:${frame.width}x${frame.height}:${stats.full}>`,
      onQuit: () => {},
    });
    expect(terminal.output).toContain("<g:40x6:true>");
    app.dispose();
  });

  test("dispose 之后：终端还原、不再写、不再响应事件", async () => {
    const terminal = new FakeTerminal();
    const [value, setValue] = createSignal("a");
    const app = createTuiApp({
      terminal,
      view: () => <text>{value()}</text>,
      onQuit: () => {},
    });

    app.dispose();
    expect(terminal.stopped).toBe(true);

    terminal.output = "";
    setValue("b");
    await tick();
    expect(terminal.output).toBe("");
  });

  test("scroll 默认贴底，可切成顶部", () => {
    const terminal = new FakeTerminal();
    terminal.size = { columns: 10, rows: 2 };
    const lines = Array.from({ length: 6 }, (_, i) => `L${i}`);

    const bottom = createTuiApp({
      terminal: new FakeTerminal(),
      size: { columns: 10, rows: 2 },
      view: () => (
        <box>
          <For each={lines}>{line => <text>{line}</text>}</For>
        </box>
      ),
      onQuit: () => {},
    });
    expect(bottom.frame().text()).toContain("L5");
    expect(bottom.frame().top).toBe(4);
    bottom.dispose();

    const top = createTuiApp({
      terminal: new FakeTerminal(),
      size: { columns: 10, rows: 2 },
      view: () => (
        <box>
          <For each={lines}>{line => <text>{line}</text>}</For>
        </box>
      ),
      scroll: () => "top",
      onQuit: () => {},
    });
    expect(top.frame().text()).toContain("L0");
    expect(top.frame().top).toBe(0);
    top.dispose();
  });

  test("autoStart: false —— 构造不碰终端，start() 才启动", () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      autoStart: false,
      view: () => <text>later</text>,
      onQuit: () => {},
    });
    expect(terminal.started).toBe(false);
    expect(terminal.output).toBe("");

    app.start();
    expect(terminal.started).toBe(true);
    expect(terminal.output).toContain("later");
    app.dispose();
  });

  test("事件经终端进来也能跑通全链路（emit → 视图变化 → 重绘）", async () => {
    const terminal = new FakeTerminal();
    const [count, setCount] = createSignal(0);

    const app = createTuiApp({
      terminal,
      view: () => <text>{`count=${count()}`}</text>,
      onKey: event => {
        if (event.name === "space") {
          setCount(prev => prev + 1);
          return true;
        }
        return false;
      },
      onQuit: () => {},
    });

    terminal.output = "";
    terminal.emit(key("space", " "));
    terminal.emit(key("space", " "));
    await tick();

    expect(app.frame().text()).toContain("count=2");
    expect(terminal.output).toContain("count=2");
    app.dispose();
  });
});
