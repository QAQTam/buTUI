import { describe, expect, test } from "bun:test";
import {
  type KeyEvent,
  createModifiers,
  eventTarget,
  isElement,
  walk,
} from "@butui/core";
import { createKeymap } from "@butui/keymap";
import { createTuiApp } from "@butui/runtime";
import { useKeyboard } from "@butui/solid";
import { FakeTerminal } from "./helpers/terminal.ts";

function key(
  name: string,
  modifiers: Partial<KeyEvent["modifiers"]> = {}
): KeyEvent {
  return eventTarget({
    type: "key" as const,
    name,
    modifiers: createModifiers(
      modifiers.ctrl,
      modifiers.alt,
      modifiers.shift,
      modifiers.meta
    ),
  }) as KeyEvent;
}

describe("runtime keymap integration", () => {
  test("顺序为 onKey → keymap → useKeyboard → 焦点节点", () => {
    const terminal = new FakeTerminal();
    const calls: string[] = [];
    const keymap = createKeymap();
    keymap.bindCommand(
      { id: "app", run: () => { calls.push("keymap"); } },
      "ctrl+k"
    );

    function View() {
      useKeyboard(event => {
        if (event.name === "u") {
          calls.push("useKeyboard");
          return true;
        }
      });
      return (
        <text focusable onKey={() => calls.push("node")}>
          x
        </text>
      );
    }

    const app = createTuiApp({
      terminal,
      keymap,
      onQuit: () => {},
      onKey: event => {
        if (event.name === "j" && event.modifiers.ctrl) {
          calls.push("onKey");
          return true;
        }
      },
      view: () => <View />,
    });

    const node = [...walk(app.root)].find(
      item => isElement(item) && item.tag === "text"
    );
    app.focus(node);

    expect(app.send(key("k", { ctrl: true }))).toBe(1);
    expect(calls).toEqual(["keymap"]);

    expect(app.send(key("j", { ctrl: true }))).toBe(1);
    expect(calls).toEqual(["keymap", "onKey"]);

    expect(app.send(key("u"))).toBe(1);
    expect(calls).toEqual(["keymap", "onKey", "useKeyboard"]);

    expect(app.send(key("z"))).toBe(1);
    expect(calls).toEqual(["keymap", "onKey", "useKeyboard", "node"]);

    app.dispose();
  });

  test("chord 前缀由 keymap 消费，第二键执行命令", () => {
    const terminal = new FakeTerminal();
    const calls: string[] = [];
    const keymap = createKeymap();
    keymap.bindCommand(
      { id: "save", run: () => { calls.push("save"); } },
      "ctrl+k ctrl+s"
    );
    const app = createTuiApp({
      terminal,
      keymap,
      onQuit: () => {},
      view: () => <text>keymap</text>,
    });

    expect(app.send(key("k", { ctrl: true }))).toBe(1);
    expect(calls).toEqual([]);
    expect(keymap.pendingSequence()).toBe("ctrl+k");
    expect(app.send(key("s", { ctrl: true }))).toBe(1);
    expect(calls).toEqual(["save"]);
    app.dispose();
  });
});
