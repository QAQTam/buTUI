import { describe, expect, test } from "bun:test";
import {
  SlotRegistry,
  createSlotRegistry,
  type Plugin,
  type PluginErrorEvent,
} from "@butui/plugins";

interface Slots {
  header: { title: string };
  footer: { text: string };
}

type Node = { id: string };

function plugin(
  id: string,
  order: number,
  slots: Plugin<Node, Slots>["slots"] = {}
): Plugin<Node, Slots> {
  return { id, order, slots };
}

describe("SlotRegistry", () => {
  test("按 order、注册顺序、id 稳定解析", () => {
    const registry = new SlotRegistry<Node, Slots>({}, {});
    registry.register(plugin("b", 0, { header: () => ({ id: "b" }) }));
    registry.register(plugin("a", 0, { header: () => ({ id: "a" }) }));
    registry.register(plugin("first", -10, { header: () => ({ id: "first" }) }));
    registry.register(plugin("only-footer", 0, { footer: () => ({ id: "f" }) }));

    expect(registry.resolveEntries("header").map(entry => entry.id)).toEqual([
      "first",
      "b",
      "a",
    ]);
    expect(registry.resolve("footer").map(renderer => renderer({}, { text: "x" }))).toEqual([
      { id: "f" },
    ]);

    expect(registry.updateOrder("a", -20)).toBe(true);
    expect(registry.resolveEntries("header").map(entry => entry.id)).toEqual([
      "a",
      "first",
      "b",
    ]);
  });

  test("重复 id 抛错；setup 失败不会留下半注册状态", () => {
    const errors: PluginErrorEvent[] = [];
    const registry = new SlotRegistry<Node, Slots>(
      {},
      {},
      { onPluginError: event => errors.push(event) }
    );

    registry.register(plugin("same", 0));
    expect(() => registry.register(plugin("same", 0))).toThrow(
      'Plugin with id "same" is already registered'
    );

    const remove = registry.register({
      id: "broken",
      setup() {
        throw new Error("setup failed");
      },
      slots: { header: () => ({ id: "broken" }) },
    });

    expect(registry.resolveEntries("header").map(entry => entry.id)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.phase).toBe("setup");
    expect(errors[0]?.error.message).toBe("setup failed");
    remove();
    expect(registry.resolveEntries("header").map(entry => entry.id)).toEqual([]);
  });

  test("卸载会依次跑 setup cleanup 与 dispose，且旧 disposer 不会误删重注册项", () => {
    const calls: string[] = [];
    const registry = new SlotRegistry<Node, Slots>({}, {});
    const remove = registry.register({
      id: "lifecycle",
      setup() {
        calls.push("setup");
        return () => calls.push("cleanup");
      },
      dispose() {
        calls.push("dispose");
      },
      slots: { header: () => ({ id: "one" }) },
    });

    expect(remove()).toBeUndefined();
    expect(calls).toEqual(["setup", "cleanup", "dispose"]);
    expect(registry.resolveEntries("header")).toEqual([]);

    registry.register({
      id: "lifecycle",
      slots: { header: () => ({ id: "two" }) },
    });
    remove();
    expect(registry.resolveEntries("header").map(entry => entry.id)).toEqual([
      "lifecycle",
    ]);
  });

  test("batch 合并通知，unsubscribe 后不再回调", () => {
    const registry = new SlotRegistry<Node, Slots>({}, {});
    let notifications = 0;
    const off = registry.subscribe(() => notifications++);

    registry.batch(() => {
      registry.register(plugin("a", 0, { header: () => ({ id: "a" }) }));
      registry.register(plugin("b", 0, { header: () => ({ id: "b" }) }));
    });
    expect(notifications).toBe(1);

    off();
    registry.unregister("a");
    expect(notifications).toBe(1);
  });

  test("错误缓存按 maxPluginErrors 截断", () => {
    const registry = new SlotRegistry<Node, Slots>(
      {},
      {},
      { maxPluginErrors: 2 }
    );
    registry.reportPluginError({ pluginId: "a", phase: "render", error: "a" });
    registry.reportPluginError({ pluginId: "b", phase: "render", error: "b" });
    registry.reportPluginError({ pluginId: "c", phase: "render", error: "c" });

    expect(registry.getPluginErrors().map(event => event.pluginId)).toEqual([
      "b",
      "c",
    ]);
    registry.clearPluginErrors();
    expect(registry.getPluginErrors()).toEqual([]);
  });
});

describe("createSlotRegistry", () => {
  test("同一个 host + key 复用实例，并要求同一个 context 对象", () => {
    const host = {};
    const context = { mode: "dark" };
    const first = createSlotRegistry<Node, Slots>(host, "app", context);
    const second = createSlotRegistry<Node, Slots>(host, "app", context);

    expect(second).toBe(first);
    expect(second.context).toBe(context);
    expect(second.host).toBe(host);
    expect(() =>
      createSlotRegistry<Node, Slots>(host, "app", { mode: "light" })
    ).toThrow("different context");
  });

  test("dispose 后再取同一个 key 会得到新实例", () => {
    const host = {};
    const context = {};
    const first = createSlotRegistry<Node, Slots>(host, "app", context);
    first.dispose();
    const second = createSlotRegistry<Node, Slots>(host, "app", context);
    expect(second).not.toBe(first);
    expect(second.disposed).toBe(false);
    expect(() =>
      second.register(plugin("late", 0, { header: () => ({ id: "late" }) }))
    ).not.toThrow();
  });
});
