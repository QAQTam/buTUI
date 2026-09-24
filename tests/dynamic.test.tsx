import { describe, expect, test } from "bun:test";
import { Dynamic, type DynamicComponent } from "@butui/components";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

describe("<Dynamic>", () => {
  test("函数组件切换并保持 props 响应式", () => {
    const [name, setName] = createSignal("A");
    const one = (props: any) => <text>one:{String(props.name)}</text>;
    const two = (props: any) => <text>two:{String(props.name)}</text>;
    const [component, setComponent] = createSignal<DynamicComponent>(
      () => one
    );
    const app = mount(
      () => <Dynamic component={component()} name={name()} />,
      { width: 30, height: 2 }
    );
    expect(app.text()).toContain("one:A");

    setName("B");
    app.flush();
    expect(app.text()).toContain("one:B");

    setComponent(() => two);
    app.flush();
    expect(app.text()).toContain("two:B");
    expect(app.text()).not.toContain("one:B");
    app.unmount();
  });

  test("intrinsic tag 与 undefined 都安全", () => {
    const [component, setComponent] = createSignal<DynamicComponent>("text");
    const app = mount(
      () => (
        <>
          <Dynamic component={component()} color="accent">
            intrinsic
          </Dynamic>
        </>
      ),
      { width: 30, height: 2 }
    );
    expect(app.text()).toContain("intrinsic");

    setComponent(undefined);
    app.flush();
    expect(app.text()).not.toContain("intrinsic");
    app.unmount();
  });
});
