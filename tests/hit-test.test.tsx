import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { mount } from "@butui/test";

describe("语义 hit test（SPEC §4.2）", () => {
  test("点击返回语义标识而不是行号", () => {
    const clicked: string[] = [];
    const app = mount(
      () => (
        <box>
          <box semantic="message:m1" onClick={event => clicked.push(event.semantic ?? "?")}>
            <text>first message</text>
          </box>
          <box semantic="message:m2" onClick={event => clicked.push(event.semantic ?? "?")}>
            <text>second message</text>
          </box>
        </box>
      ),
      { width: 30, height: 4 }
    );

    // 点第一行的文字
    expect(app.semanticAt(2, 0)).toBe("message:m1");
    app.click(2, 0);
    // 点第二行
    expect(app.semanticAt(2, 1)).toBe("message:m2");
    app.click(2, 1);

    expect(clicked).toEqual(["message:m1", "message:m2"]);
    app.unmount();
  });

  test("点子节点会冒泡到带语义的卡片", () => {
    const hits: string[] = [];
    const app = mount(
      () => (
        <box semantic="tool:call-1" onClick={event => hits.push(event.semantic ?? "?")}>
          <text>✓ read_file</text>
          <text>src/auth.ts</text>
        </box>
      ),
      { width: 30, height: 3 }
    );

    app.click(3, 1); // 点在第二行（更深的 text 节点）
    expect(hits).toEqual(["tool:call-1"]);
    app.unmount();
  });

  test("stopPropagation 阻止继续冒泡", () => {
    const order: string[] = [];
    const app = mount(
      () => (
        <box semantic="outer" onClick={() => order.push("outer")}>
          <box
            semantic="inner"
            onClick={event => {
              order.push("inner");
              event.stopPropagation();
            }}
          >
            <text>hit</text>
          </box>
        </box>
      ),
      { width: 10, height: 1 }
    );

    app.click(1, 0);
    expect(order).toEqual(["inner"]);
    app.unmount();
  });

  test("disabled 节点不响应点击", () => {
    let count = 0;
    const app = mount(
      () => (
        <box disabled onClick={() => count++}>
          <text>nope</text>
        </box>
      ),
      { width: 10, height: 1 }
    );

    expect(app.click(1, 0)).toBe(0);
    expect(count).toBe(0);
    app.unmount();
  });

  test("wheel 事件走 onWheel", () => {
    const [offset, setOffset] = createSignal(0);
    const app = mount(
      () => (
        <box
          width={8}
          height={1}
          overflow="hidden"
          scrollOffset={offset()}
          onWheel={() => setOffset(o => o + 1)}
        >
          <text>a</text>
          <text>b</text>
        </box>
      ),
      { width: 8, height: 1 }
    );

    expect(app.text()).toBe("a");
    app.wheel(1, 0);
    app.flush();
    expect(app.text()).toBe("b");
    app.unmount();
  });
});
