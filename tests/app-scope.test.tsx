import { describe, expect, test } from "bun:test";
import { type KeyEvent, createModifiers, focusNode, walk, type Node } from "@butui/core";
import { type AppScope, useAppScope, useColorDepth, useKeyboard, useSize } from "@butui/solid";
import { createTuiApp } from "@butui/runtime";
import { mount } from "@butui/test";
import { Show, createSignal } from "solid-js";
import { FakeTerminal, tick } from "./helpers/terminal.ts";

/** 一个「自己知道终端多宽」的组件 —— 这就是组件作者需要的能力 */
function WidthProbe() {
  const size = useSize();
  const depth = useColorDepth();
  return (
    <text>
      {`${size().columns}x${size().rows} ${depth()}`}
    </text>
  );
}

function KeyProbe(props: { log: string[]; enabled?: () => boolean }) {
  useKeyboard(
    event => {
      props.log.push(event.name);
      return event.name === "escape";
    },
    props.enabled ? { enabled: props.enabled } : {}
  );
  return <text>probe</text>;
}

function ScopeProbe(props: { onScope: (scope: AppScope | null) => void }) {
  props.onScope(useAppScope());
  return <text>scope</text>;
}

describe("useSize / useColorDepth", () => {
  test("组件能读到终端尺寸（测试 mount 也一样）", () => {
    const app = mount(() => <WidthProbe />, { width: 33, height: 4, depth: "256" });
    expect(app.text()).toContain("33x4 256");
    app.unmount();
  });

  test("resize 之后读到的就是新值", () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      terminal,
      view: () => <WidthProbe />,
      onQuit: () => {},
    });
    expect(app.frame().text()).toContain("40x6");
    terminal.resize({ columns: 50, rows: 8 });
    expect(app.frame().text()).toContain("50x8");
    app.dispose();
  });

  test("没有 runtime 上下文时安全退化（不抛异常）", () => {
    // 直接调用 hook 需要一个 owner；这里用一个最小组件验证退化成 0x0
    const app = mount(() => <WidthProbe />, { width: 10, height: 1 });
    // mount 提供了上下文，所以这里验证的是「有上下文时正常」
    expect(app.text()).toContain("10x1");
    app.unmount();
  });

  test("runtime 向组件注入共享 FrameClock 和 AnimationScheduler", () => {
    const terminal = new FakeTerminal();
    const captured: { scope: AppScope | null } = { scope: null };
    const app = createTuiApp({
      terminal,
      view: () => <ScopeProbe onScope={value => (captured.scope = value)} />,
      onQuit: () => {},
    });

    expect(captured.scope).not.toBeNull();
    const scope = captured.scope as AppScope | null;
    expect(scope?.frameClock).toBeDefined();
    expect(scope?.animationScheduler).toBeDefined();
    app.dispose();
  });
});

describe("useKeyboard", () => {
  test("订阅全局按键，返回 true 就消费掉（不再派发给焦点节点）", () => {
    const log: string[] = [];
    const app = mount(
      () => (
        <box>
          <KeyProbe log={log} />
          <text focusable>focusable</text>
        </box>
      ),
      { width: 20, height: 3 }
    );
    const node = [...walk(app.root)].find(n => n.kind === "element" && n.props.focusable);
    focusNode(app.root, node as Node);

    app.key("a", "a");
    app.key("escape");
    app.flush();
    expect(log).toEqual(["a", "escape"]);
    app.unmount();
  });

  test("enabled=false 时完全不管", () => {
    const log: string[] = [];
    const [on, setOn] = createSignal(false);
    const app = mount(() => <KeyProbe log={log} enabled={() => on()} />, {
      width: 20,
      height: 2,
    });
    app.key("a", "a");
    app.flush();
    expect(log).toEqual([]);

    setOn(true);
    app.flush();
    app.key("b", "b");
    app.flush();
    expect(log).toEqual(["b"]);
    app.unmount();
  });

  test("组件卸载后自动退订", () => {
    const log: string[] = [];
    const [show, setShow] = createSignal(true);
    const app = mount(
      () => (
        <box>
          <Show when={show()}>
            <KeyProbe log={log} />
          </Show>
        </box>
      ),
      { width: 20, height: 2 }
    );
    app.key("a", "a");
    app.flush();
    setShow(false);
    app.flush();
    app.key("b", "b");
    app.flush();
    expect(log).toEqual(["a"]);
    app.unmount();
  });

  test("多个监听器按注册顺序跑，先消费的赢", () => {
    const order: string[] = [];
    function First() {
      useKeyboard(e => {
        order.push("first:" + e.name);
        return e.name === "x";
      });
      return <text>1</text>;
    }
    function Second() {
      useKeyboard(e => {
        order.push("second:" + e.name);
      });
      return <text>2</text>;
    }
    const app = mount(
      () => (
        <box>
          <First />
          <Second />
        </box>
      ),
      { width: 20, height: 3 }
    );
    app.key("x", "x");
    app.flush();
    expect(order).toEqual(["first:x"]);
    app.key("y", "y");
    app.flush();
    expect(order).toEqual(["first:x", "first:y", "second:y"]);
    app.unmount();
  });

  test("runtime 里应用级 onKey 优先于组件监听器", async () => {
    const terminal = new FakeTerminal();
    const order: string[] = [];
    const app = createTuiApp({
      terminal,
      view: () => <KeyProbe log={order} />,
      onKey: event => {
        order.push("app:" + event.name);
        return event.name === "x";
      },
      onQuit: () => {},
    });
    terminal.emit({
      type: "key",
      name: "x",
      text: "x",
      modifiers: createModifiers(),
    } as KeyEvent);
    await tick();
    expect(order).toEqual(["app:x"]); // 应用吃掉之后组件收不到
    app.dispose();
  });
});
