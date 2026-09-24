import { describe, expect, test } from "bun:test";
import {
  ToastViewport,
  createToastQueue,
  type ToastEvent,
} from "@butui/components";
import { focusNode, walk, type Node } from "@butui/core";
import { mount } from "@butui/test";

function findBySemantic(root: Node, semantic: string): Node | undefined {
  for (const node of walk(root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

function fakeTimers() {
  let now = 0;
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  return {
    now: () => now,
    setNow(value: number) {
      now = value;
    },
    setTimeout(callback: () => void, _delay: number) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimeout(handle: number | ReturnType<typeof setTimeout>) {
      if (typeof handle === "number") callbacks.delete(handle);
    },
    run(handle: number) {
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      callback?.();
    },
    handles() {
      return [...callbacks.keys()];
    },
  };
}

describe("createToastQueue", () => {
  test("dedupe 合并并增加 count，maxVisible 触发 overflow", () => {
    const timers = fakeTimers();
    const events: ToastEvent[] = [];
    const queue = createToastQueue({
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      maxVisible: 2,
      defaultDurationMs: 0,
    });
    queue.onEvent(event => events.push(event));

    const first = queue.push({ title: "保存", dedupeKey: "save" });
    const merged = queue.push({ title: "保存成功", dedupeKey: "save" });
    expect(merged.id).toBe(first.id);
    expect(merged.count).toBe(2);
    expect(queue.visible()[0]?.title).toBe("保存成功");

    queue.push({ title: "第二" });
    queue.push({ title: "第三" });
    expect(queue.visible().map(item => item.title)).toEqual(["第三", "第二"]);
    expect(
      queue.all().find(item => item.id === first.id)?.state
    ).toBe("dismissed");
    expect(events.map(event => event.type)).toEqual([
      "added",
      "updated",
      "added",
      "dismissed",
      "added",
    ]);
    queue.dispose();
  });

  test("TTL 支持 pause / resume，超时进入 expired", () => {
    const timers = fakeTimers();
    const queue = createToastQueue({
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      defaultDurationMs: 100,
    });
    const item = queue.push({ title: "加载" });
    const handle = timers.handles()[0]!;

    expect(queue.pause(item.id)).toBe(true);
    expect(timers.handles()).toEqual([]);
    timers.setNow(200);
    expect(queue.resume(item.id)).toBe(true);
    expect(queue.all()[0]?.expiresAt).toBe(300);

    timers.run(timers.handles()[0]!);
    expect(queue.all()[0]?.state).toBe("expired");
    expect(queue.visible()).toEqual([]);
    queue.dispose();
  });
});

describe("<ToastViewport>", () => {
  test("响应式显示 toast，Enter 执行 action 并关闭", async () => {
    const queue = createToastQueue({ defaultDurationMs: 0 });
    const actions: string[] = [];
    const app = mount(
      () => (
        <>
          <box>
            <text>背景</text>
          </box>
          <ToastViewport
            queue={queue}
            width={30}
            onAction={(_toast, action) => actions.push(action.id)}
          />
        </>
      ),
      { width: 60, height: 12 }
    );
    const toast = queue.push({
      title: "构建完成",
      message: "3 files changed",
      tone: "success",
      actions: [{ id: "open", label: "打开" }],
    });
    app.flush();

    expect(app.text()).toContain("构建完成");
    expect(app.text()).toContain("3 files changed");
    expect(app.text()).toContain("打开");

    const action = findBySemantic(
      app.root,
      `toast:${toast.id}:action:open`
    )!;
    focusNode(app.root, action);
    app.key("enter");
    await Bun.sleep(0);
    app.flush();
    app.paint();
    expect(actions).toEqual(["open"]);
    expect(app.text()).not.toContain("构建完成");
    app.unmount();
    queue.dispose();
  });

  test("Esc 关闭可 dismiss toast", () => {
    const queue = createToastQueue({ defaultDurationMs: 0 });
    const app = mount(
      () => <ToastViewport queue={queue} width={24} />,
      { width: 50, height: 10 }
    );
    const toast = queue.push({ title: "可关闭" });
    app.flush();

    const node = findBySemantic(app.root, `toast:${toast.id}`)!;
    focusNode(app.root, node);
    app.key("escape");
    app.flush();
    expect(queue.visible()).toEqual([]);
    expect(app.text()).not.toContain("可关闭");
    app.unmount();
    queue.dispose();
  });
});
