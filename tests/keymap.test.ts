import { describe, expect, test } from "bun:test";
import {
  CommandRegistry,
  createKeymap,
  defineCommand,
  formatKeyStroke,
  matchesKeyStroke,
  parseKeyStroke,
} from "@butui/keymap";
import {
  type KeyEvent,
  createModifiers,
  eventTarget,
} from "@butui/core";

const key = (
  name: string,
  modifiers: Partial<KeyEvent["modifiers"]> = {}
): KeyEvent =>
  eventTarget({
    type: "key" as const,
    name,
    modifiers: createModifiers(
      modifiers.ctrl,
      modifiers.alt,
      modifiers.shift,
      modifiers.meta
    ),
  }) as KeyEvent;

describe("key parsing", () => {
  test("别名、修饰键和格式化", () => {
    expect(formatKeyStroke(parseKeyStroke("ctrl+shift+k"))).toBe(
      "ctrl+shift+k"
    );
    expect(formatKeyStroke(parseKeyStroke("esc"))).toBe("escape");
    expect(formatKeyStroke(parseKeyStroke("space"))).toBe("space");
    expect(formatKeyStroke(parseKeyStroke("ctrl++"))).toBe("ctrl++");
  });

  test("匹配事件时推断大写字母的 shift", () => {
    expect(matchesKeyStroke(key("k", { ctrl: true }), parseKeyStroke("ctrl+k"))).toBe(
      true
    );
    expect(matchesKeyStroke(key("K"), parseKeyStroke("shift+k"))).toBe(true);
    expect(matchesKeyStroke(key("k"), parseKeyStroke("ctrl+k"))).toBe(false);
  });

  test("多键 chord 明确报错，不静默误解", () => {
    expect(() => parseKeyStroke("ctrl+k ctrl+s")).toThrow(
      "Multi-stroke key sequence is not supported yet"
    );
  });
});

describe("CommandRegistry", () => {
  test("注册、执行、when 与错误隔离", () => {
    const errors: string[] = [];
    const registry = new CommandRegistry({
      onError: event => errors.push(event.error.message),
    });
    const calls: string[] = [];
    registry.register(
      defineCommand({
        id: "enabled",
        title: "Enabled",
        run: () => { calls.push("enabled"); },
      })
    );
    registry.register({
      id: "disabled",
      when: () => false,
      run: () => { calls.push("disabled"); },
    });
    registry.register({
      id: "boom",
      run: () => {
        throw new Error("boom");
      },
    });

    expect(registry.execute("enabled")).toBe(true);
    expect(registry.execute("disabled")).toBe(false);
    expect(registry.execute("missing")).toBe(false);
    expect(registry.execute("boom")).toBe(false);
    expect(calls).toEqual(["enabled"]);
    expect(errors).toEqual(["boom"]);
    expect(registry.list().map(command => command.id)).toEqual([
      "boom",
      "disabled",
      "enabled",
    ]);
  });

  test("重复 id 抛错，disposer 只删除本次注册", () => {
    const registry = new CommandRegistry();
    const remove = registry.register({ id: "x", run: () => {} });
    expect(() => registry.register({ id: "x", run: () => {} })).toThrow(
      'Command "x" is already registered'
    );
    remove();
    expect(registry.has("x")).toBe(false);
  });
});

describe("Keymap", () => {
  test("scope 深度优先于 priority，pop 后回退到全局", () => {
    const calls: string[] = [];
    const keymap = createKeymap();
    keymap.bindCommand(
      { id: "global", run: () => { calls.push("global"); } },
      "ctrl+k"
    );
    keymap.bindCommand(
      { id: "dialog", run: () => { calls.push("dialog"); } },
      "ctrl+k",
      { scope: "dialog", priority: -100 }
    );

    expect(keymap.handle(key("k", { ctrl: true }))).toBe(true);
    expect(calls).toEqual(["global"]);

    const pop = keymap.pushScope("dialog");
    expect(keymap.handle(key("k", { ctrl: true }))).toBe(true);
    expect(calls).toEqual(["global", "dialog"]);

    pop();
    expect(keymap.handle(key("k", { ctrl: true }))).toBe(true);
    expect(calls).toEqual(["global", "dialog", "global"]);
  });

  test("when 为 false 时继续尝试下一条绑定", () => {
    const calls: string[] = [];
    const keymap = createKeymap();
    keymap.bindCommand({ id: "a", run: () => { calls.push("a"); } }, "x", {
      when: () => false,
      priority: 10,
    });
    keymap.bindCommand({ id: "b", run: () => { calls.push("b"); } }, "x");

    const event = key("x");
    expect(keymap.handle(event)).toBe(true);
    expect(calls).toEqual(["b"]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("冲突检测忽略有 when 的动态分派", () => {
    const keymap = createKeymap();
    keymap.bind("x", "a");
    keymap.bind("x", "b");
    expect(keymap.conflicts()).toHaveLength(1);
    expect(keymap.conflicts()[0]?.sequence).toBe("x");

    keymap.unbind("x", { command: "b" });
    keymap.bind("x", "b", { when: () => true });
    expect(keymap.conflicts()).toEqual([]);
  });

  test("help 带上命令标题并按按键排序", () => {
    const keymap = createKeymap();
    keymap.bindCommand(
      {
        id: "save",
        title: "Save",
        description: "Write file",
        run: () => {},
      },
      ["ctrl+s", "ctrl+shift+s"]
    );

    expect(keymap.help()).toEqual([
      {
        sequence: "ctrl+s",
        command: "save",
        priority: 0,
        title: "Save",
        description: "Write file",
      },
      {
        sequence: "ctrl+shift+s",
        command: "save",
        priority: 0,
        title: "Save",
        description: "Write file",
      },
    ]);
  });

  test("bindCommand 的 disposer 同时移除命令与绑定", () => {
    const keymap = createKeymap();
    const remove = keymap.bindCommand({ id: "x", run: () => {} }, "x");
    expect(keymap.commands.has("x")).toBe(true);
    expect(keymap.help()).toHaveLength(1);
    remove();
    expect(keymap.commands.has("x")).toBe(false);
    expect(keymap.help()).toEqual([]);
  });

  test("bindCommand 中途失败时回滚命令与已注册绑定", () => {
    const keymap = createKeymap();
    expect(() =>
      keymap.bindCommand({ id: "bad", run: () => {} }, ["x", "ctrl+k ctrl+s"])
    ).toThrow("Multi-stroke key sequence is not supported yet");
    expect(keymap.commands.has("bad")).toBe(false);
    expect(keymap.help()).toEqual([]);
  });
});
