import { describe, expect, test } from "bun:test";
import {
  createSlot,
  createSolidSlotRegistry,
  type SolidPlugin,
} from "@butui/plugins/solid";
import { mount } from "@butui/test";
import { createMemo, createSignal } from "solid-js";

interface Slots {
  header: { title: string };
  actions: { label: string };
}

interface Context {
  theme: string;
}

const context: Context = { theme: "dark" };

function solidPlugin(
  id: string,
  order: number,
  slots: SolidPlugin<Slots, Context>["slots"]
): SolidPlugin<Slots, Context> {
  return { id, order, slots };
}

describe("Solid <Slot>", () => {
  test("append：先渲染 fallback，再按插件顺序追加", () => {
    const registry = createSolidSlotRegistry<Slots, Context>({}, context);
    registry.register(
      solidPlugin("late", 10, {
        header: (_ctx, props) => <text>{`late:${props.title}`}</text>,
      })
    );
    registry.register(
      solidPlugin("early", -10, {
        header: (ctx, props) => <text>{`early:${ctx.theme}:${props.title}`}</text>,
      })
    );
    const Header = createSlot(registry);

    const app = mount(
      () => (
        <Header name="header" title="Hi">
          <text>fallback</text>
        </Header>
      ),
      { width: 40, height: 4 }
    );

    const text = app.text();
    expect(text).toContain("fallback");
    expect(text).toContain("early:dark:Hi");
    expect(text).toContain("late:Hi");
    expect(text.indexOf("fallback")).toBeLessThan(text.indexOf("early:dark:Hi"));
    app.unmount();
  });

  test("注册、卸载和 props 更新都会响应式重渲染", () => {
    const registry = createSolidSlotRegistry<Slots, Context>({}, context);
    const Header = createSlot(registry);
    const [title, setTitle] = createSignal("one");
    const app = mount(
      () => <Header name="header" title={title()} />,
      { width: 30, height: 3 }
    );

    expect(app.text()).toBe("");
    const remove = registry.register(
      solidPlugin("p", 0, {
        header: (_ctx, props) => <text>{`title=${props.title}`}</text>,
      })
    );
    app.flush();
    expect(app.text()).toContain("title=one");

    setTitle("two");
    app.flush();
    expect(app.text()).toContain("title=two");

    remove();
    app.flush();
    expect(app.text()).toBe("");
    app.unmount();
  });

  test("replace 有插件时隐藏 fallback；single_winner 只取第一个", () => {
    const registry = createSolidSlotRegistry<Slots, Context>({}, context);
    registry.register(
      solidPlugin("a", 0, {
        header: () => <text>A</text>,
      })
    );
    registry.register(
      solidPlugin("b", 0, {
        header: () => <text>B</text>,
      })
    );
    const Header = createSlot(registry);

    const replace = mount(
      () => (
        <Header name="header" title="x" mode="replace">
          <text>fallback</text>
        </Header>
      ),
      { width: 20, height: 3 }
    );
    expect(replace.text()).not.toContain("fallback");
    expect(replace.text()).toContain("A");
    expect(replace.text()).toContain("B");
    replace.unmount();

    const single = mount(
      () => (
        <Header name="header" title="x" mode="single_winner">
          <text>fallback</text>
        </Header>
      ),
      { width: 20, height: 3 }
    );
    expect(single.text()).toContain("A");
    expect(single.text()).not.toContain("B");
    expect(single.text()).not.toContain("fallback");
    single.unmount();

    registry.clear();
    const fallback = mount(
      () => (
        <Header name="header" title="x" mode="replace">
          <text>fallback</text>
        </Header>
      ),
      { width: 20, height: 3 }
    );
    expect(fallback.text()).toContain("fallback");
    fallback.unmount();
  });

  test("单个插件 render 抛错不会拖垮其它插件，并支持 placeholder", () => {
    const registry = createSolidSlotRegistry<Slots, Context>({}, context);
    registry.register(
      solidPlugin("bad", -10, {
        header: () => {
          throw new Error("render bad");
        },
      })
    );
    registry.register(
      solidPlugin("good", 10, {
        header: () => <text>good</text>,
      })
    );
    const Header = createSlot(registry, {
      pluginFailurePlaceholder: failure => (
        <text>{`ERR:${failure.error.message}`}</text>
      ),
    });

    const app = mount(
      () => (
        <Header name="header" title="x">
          <text>fallback</text>
        </Header>
      ),
      { width: 30, height: 4 }
    );

    expect(app.text()).toContain("ERR:render bad");
    expect(app.text()).toContain("good");
    expect(app.text()).toContain("fallback");
    expect(registry.getPluginErrors()).toHaveLength(1);
    expect(registry.getPluginErrors()[0]?.phase).toBe("render");
    app.unmount();
  });

  test("响应式抛错由 Errored 边界接管", () => {
    const registry = createSolidSlotRegistry<Slots, Context>({}, context);
    const [explode, setExplode] = createSignal(false);

    function Bomb() {
      const message = createMemo(() => {
        if (explode()) throw new Error("late boom");
        return "safe";
      });
      return <text>{message()}</text>;
    }

    registry.register(
      solidPlugin("bomb", 0, {
        header: () => <Bomb />,
      })
    );
    const Header = createSlot(registry, {
      pluginFailurePlaceholder: failure => (
        <text>{`ERR:${failure.error.message}`}</text>
      ),
    });

    const app = mount(
      () => <Header name="header" title="x" />,
      { width: 30, height: 3 }
    );
    expect(app.text()).toContain("safe");

    setExplode(true);
    app.flush();
    expect(app.text()).toContain("ERR:late boom");
    expect(registry.getPluginErrors().at(-1)?.error.message).toBe("late boom");
    app.unmount();
  });
});
