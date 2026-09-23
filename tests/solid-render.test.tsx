import { describe, expect, test } from "bun:test";
import { For, Show, createSignal } from "solid-js";
import { mount } from "@butui/test";

describe("Solid 2 RC universal → buTUI host ops", () => {
  test("渲染静态树", () => {
    const app = mount(
      () => (
        <box border padding={1}>
          <text>hello butui</text>
        </box>
      ),
      { width: 24, height: 5 }
    );
    expect(app.text()).toContain("hello butui");
    expect(app.text()).toContain("╭");
    app.unmount();
  });

  test("signal 更新会触发重渲染", () => {
    const [count, setCount] = createSignal(0);
    const app = mount(() => <text>count={count()}</text>, { width: 20, height: 1 });

    expect(app.text()).toContain("count=0");
    setCount(3);
    app.flush();
    expect(app.text()).toContain("count=3");
    app.unmount();
  });

  test("For / Show 结构变化", () => {
    const [items, setItems] = createSignal<string[]>(["a", "b"]);
    const [visible, setVisible] = createSignal(true);
    const app = mount(
      () => (
        <box>
          <Show when={visible()}>
            <text>header</text>
          </Show>
          <For each={items()}>{item => <text>{item}</text>}</For>
        </box>
      ),
      { width: 20, height: 6 }
    );

    expect(app.text()).toContain("header");
    expect(app.text()).toContain("a");

    setItems(["a", "b", "c"]);
    setVisible(false);
    app.flush();

    expect(app.text()).toContain("c");
    expect(app.text()).not.toContain("header");
    app.unmount();
  });

  test("流式文本只重绘受影响的行", () => {
    const [body, setBody] = createSignal("第一行\n第二行\n第三行");
    const app = mount(
      () => (
        <box>
          <text>title</text>
          <text>{body()}</text>
        </box>
      ),
      { width: 30, height: 8 }
    );

    const first = app.paint();
    expect(first.full).toBe(true);

    // 只改中间那一行
    setBody("第一行\n第二行改了\n第三行");
    app.flush();
    const second = app.paint();
    expect(second.full).toBe(false);
    expect(second.changedLines).toBeLessThanOrEqual(2);
    app.unmount();
  });
});
