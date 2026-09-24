import { describe, expect, test } from "bun:test";
import { Portal } from "@butui/components";
import { type Node, walk } from "@butui/core";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

function findBySemantic(root: Node, semantic: string): Node | undefined {
  for (const node of walk(root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

describe("<Portal>", () => {
  test("默认挂到 app root，children 保持响应式", () => {
    const [text, setText] = createSignal("portal one");
    const app = mount(
      () => (
        <box>
          <text>base</text>
          <Portal>
            <text>{text()}</text>
          </Portal>
        </box>
      ),
      { width: 40, height: 6 }
    );

    expect(app.text()).toContain("base");
    expect(app.text()).toContain("portal one");
    const portal = findBySemantic(app.root, "portal")!;
    expect(portal.parent).toBe(app.root);

    setText("portal two");
    app.flush();
    expect(app.text()).toContain("portal two");
    expect(app.text()).not.toContain("portal one");
    app.unmount();
  });

  test("显式 mount 后容器挂到目标节点，卸载时移除", () => {
    const [target, setTarget] = createSignal<Node>();
    const app = mount(
      () => (
        <>
          <box ref={setTarget} height={2}>
            <text>host</text>
          </box>
          <Portal mount={target()}>
            <text>detached</text>
          </Portal>
        </>
      ),
      { width: 40, height: 6 }
    );
    app.flush();

    const portal = findBySemantic(app.root, "portal")!;
    expect(portal.parent).toBe(target()!);
    expect(app.text()).toContain("detached");

    app.unmount();
    expect(
      target()?.children.some(
        node => node.kind === "element" && node.props.semantic === "portal"
      )
    ).toBe(false);
  });
});
