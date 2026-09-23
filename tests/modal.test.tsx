import { describe, expect, test } from "bun:test";
import {
  type ButuiEvent,
  type KeyEvent,
  type Node,
  createModifiers,
  eventTarget,
  focusNode,
  walk,
} from "@butui/core";
import { Button, Dialog, Modal } from "@butui/components";
import { type TuiApp, createTuiApp } from "@butui/runtime";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";
import { FakeTerminal, tick } from "./helpers/terminal.ts";

const key = (name: string, text?: string): KeyEvent =>
  eventTarget({
    type: "key" as const,
    name,
    ...(text !== undefined ? { text } : {}),
    modifiers: createModifiers(),
  }) as KeyEvent;

function findBySemantic(app: { root: Node }, semantic: string): Node | undefined {
  for (const node of walk(app.root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

function insideOf(root: Node | undefined, id: number | null): boolean {
  if (!root || id === null) return false;
  for (const node of walk(root)) if (node.id === id) return true;
  return false;
}

describe("<Button>", () => {
  test("默认画成 [ 文案 ]，Enter / 空格 / 点击都触发", () => {
    const pressed: string[] = [];
    const app = mount(
      () => (
        <box>
          <Button onPress={() => pressed.push("enter")}>允许</Button>
        </box>
      ),
      { width: 20, height: 2 }
    );
    expect(app.text()).toContain("[ 允许 ]");

    const node = findBySemantic(app, "button")!;
    focusNode(app.root, node);
    app.key("enter");
    app.key(" ", " ");
    app.click(2, 0);
    app.flush();
    expect(pressed).toEqual(["enter", "enter", "enter"]);
    app.unmount();
  });

  test("disabled 时不可聚焦、也不触发", () => {
    const pressed: string[] = [];
    const app = mount(
      () => (
        <box>
          <Button disabled onPress={() => pressed.push("x")}>拒绝</Button>
        </box>
      ),
      { width: 20, height: 2 }
    );
    const node = findBySemantic(app, "button")!;
    expect(node.kind === "element" && node.props.focusable).toBe(false);
    app.click(2, 0);
    app.flush();
    expect(pressed).toEqual([]);
    app.unmount();
  });

  test("plain 只做焦点高亮，不画括号", () => {
    const app = mount(() => <Button plain>裸按钮</Button>, { width: 20, height: 1 });
    expect(app.text()).toContain("裸按钮");
    expect(app.text()).not.toContain("[");
    app.unmount();
  });
});

describe("<Dialog> / <Modal>", () => {
  function setup(initial = true) {
    const terminal = new FakeTerminal();
    const [open, setOpen] = createSignal(initial);
    const events: string[] = [];
    const app: TuiApp = createTuiApp({
      terminal,
      view: () => (
        <>
          <box>
            <text>背景内容</text>
            <Button semantic="bg-button" onPress={() => events.push("bg")}>
              背景按钮
            </Button>
          </box>
          <Modal
            open={open()}
            title="允许执行？"
            width={30}
            onDismiss={() => {
              events.push("dismiss");
              setOpen(false);
            }}
          >
            <text>rm -rf node_modules</text>
            <Button tone="success" semantic="allow" onPress={() => events.push("allow")}>
              允许
            </Button>
          </Modal>
        </>
      ),
      onQuit: () => {},
    });
    return { app, terminal, open, setOpen, events };
  }

  test("弹窗画在视口之上，并自动聚焦", () => {
    const { app } = setup();
    const text = app.frame().text();
    expect(text).toContain("允许执行？");
    expect(text).toContain("rm -rf node_modules");
    // 遮罩是透明的：背景没被抹掉，只是被对话框盖住了中间几列
    expect(text).toContain("[ 背景按钮 ]");
    expect(text).toContain("背景内");
    expect(app.focusedId()).not.toBeNull();
    app.dispose();
  });

  test("Esc 触发 onDismiss（应用自己决定关不关）", () => {
    const { app, events } = setup();
    app.send(key("escape"));
    expect(events).toEqual(["dismiss"]);
    app.dispose();
  });

  test("焦点被 trap 在对话框里，Tab 不会跑到背景按钮上", () => {
    const { app } = setup();
    const dialog = findBySemantic(app, "dialog")!;
    expect(insideOf(dialog, app.focusedId())).toBe(true);

    for (let i = 0; i < 6; i++) {
      app.send(key("tab"));
      expect(insideOf(dialog, app.focusedId())).toBe(true);
    }
    app.dispose();
  });

  test("关掉之后焦点回到原来的节点", async () => {
    const { app, setOpen } = setup(false);
    const bg = findBySemantic(app, "bg-button")!;
    app.focus(bg);
    expect(app.focusedId()).toBe(bg.id);

    setOpen(true);
    await tick(); // runtime 的微任务：flush + 重绘
    expect(app.focusedId()).not.toBe(bg.id); // 进弹窗了

    setOpen(false);
    await tick();
    expect(app.focusedId()).toBe(bg.id); // 回来了
    app.dispose();
  });

  test("按钮点击走 onPress，不冒泡成背景点击", () => {
    const { app, events } = setup();
    const allow = findBySemantic(app, "allow")!;
    focusNode(app.root, allow);
    app.send(key("enter"));
    expect(events).toEqual(["allow"]);
    app.dispose();
  });

  test("open=false 时整棵子树不在树里（内部状态一起清掉）", async () => {
    const { app, setOpen } = setup(false);
    expect(app.frame().text()).not.toContain("允许执行？");
    setOpen(true);
    await tick();
    expect(app.frame().text()).toContain("允许执行？");
    setOpen(false);
    await tick();
    expect(findBySemantic(app, "dialog")).toBeUndefined();
    app.dispose();
  });
});

describe("<Dialog> 内联模式", () => {
  test("modal={false} 不 trap 焦点", () => {
    const app = mount(
      () => (
        <box>
          <Button semantic="outside">外面</Button>
          <Dialog modal={false} title="内联" width={20}>
            <Button semantic="inside">里面</Button>
          </Dialog>
        </box>
      ),
      { width: 30, height: 8 }
    );
    // 没 trap 的话，外面的按钮仍然可以聚焦
    const outside = findBySemantic(app, "outside")!;
    focusNode(app.root, outside);
    expect(app.root.children.length).toBeGreaterThan(0);
    app.unmount();
  });
});
