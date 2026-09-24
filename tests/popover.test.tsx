import { describe, expect, test } from "bun:test";
import {
  Button,
  Popover,
  createPopoverController,
} from "@butui/components";
import { type Node, focusNode, walk } from "@butui/core";
import { mount } from "@butui/test";
import { flush } from "solid-js";

function findBySemantic(root: Node, semantic: string): Node | undefined {
  for (const node of walk(root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

describe("createPopoverController", () => {
  test("show / toggle / hide 与 onChange", () => {
    const changes: boolean[] = [];
    const controller = createPopoverController({
      onChange: open => changes.push(open),
    });
    controller.show({ x: 2, y: 3 });
    flush();
    expect(controller.open()).toBe(true);
    expect(controller.anchor()).toEqual({ x: 2, y: 3 });
    controller.toggle();
    flush();
    expect(controller.open()).toBe(false);
    controller.toggle({ x: 4, y: 5 });
    flush();
    expect(controller.open()).toBe(true);
    expect(controller.anchor()).toEqual({ x: 4, y: 5 });
    controller.dispose();
    flush();
    expect(controller.open()).toBe(false);
    expect(changes).toEqual([true, false, true]);
  });
});

describe("<Popover>", () => {
  test("点击目标切换，内部可交互，Esc dismiss", () => {
    const controller = createPopoverController();
    const pressed: string[] = [];
    const dismissed: string[] = [];
    const app = mount(
      () => (
        <>
          <box
            width={10}
            height={1}
            semantic="popover-trigger"
            onClick={event =>
              controller.toggle({ x: event.x, y: event.y })
            }
          >
            <text>open</text>
          </box>
          <Popover
            controller={controller}
            width={24}
            height={5}
            ignore={target => target?.semantic === "popover-trigger"}
            onDismiss={() => dismissed.push("dismiss")}
          >
            <Button onPress={() => pressed.push("action")}>执行</Button>
          </Popover>
        </>
      ),
      { width: 50, height: 12 }
    );

    app.click(0, 0);
    app.flush();
    expect(app.text()).toContain("执行");

    const action = findBySemantic(app.root, "button")!;
    focusNode(app.root, action);
    app.key("enter");
    app.flush();
    expect(pressed).toEqual(["action"]);

    const popover = findBySemantic(app.root, "popover")!;
    focusNode(app.root, popover);
    app.key("escape");
    app.flush();
    expect(controller.open()).toBe(false);
    expect(app.text()).not.toContain("执行");
    expect(dismissed).toEqual(["dismiss"]);
    app.unmount();
    controller.dispose();
  });

  test("点击 outside dismiss，ignore anchor 不误关", () => {
    const controller = createPopoverController();
    const app = mount(
      () => (
        <>
          <box
            width={10}
            height={1}
            semantic="popover-trigger"
            onClick={event =>
              controller.toggle({ x: event.x, y: event.y })
            }
          >
            <text>open</text>
          </box>
          <Popover
            controller={controller}
            width={20}
            height={4}
            ignore={target => target?.semantic === "popover-trigger"}
          >
            <text>content</text>
          </Popover>
        </>
      ),
      { width: 40, height: 10 }
    );

    app.click(0, 0);
    app.flush();
    expect(controller.open()).toBe(true);

    app.click(20, 9);
    app.flush();
    expect(controller.open()).toBe(false);
    app.unmount();
    controller.dispose();
  });
});
