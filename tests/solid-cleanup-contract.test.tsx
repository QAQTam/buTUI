import { describe, expect, test } from "bun:test";
import { mount } from "@butui/test";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";

/**
 * Solid 2 的清理函数契约 —— 这条踩了很久，单独立一个文件钉住。
 *
 * `createEffect(compute, effect)` 的**返回值**才是清理函数。在 effect 体里调
 * `onCleanup(fn)` 注册的清理**在卸载时不会跑**（Solid 1 里是会跑的），于是
 * 定时器、订阅、焦点 trap 全都泄漏。
 *
 * buTUI 里凡是「effect 里申请、卸载时要还」的东西（`<Spinner>` 的定时器、
 * `<Dialog>` 的焦点 trap）都必须写成 `return () => ...`。
 */
describe("Solid 2 清理函数契约", () => {
  test("只有「effect 返回清理函数」和「组件体里 onCleanup」会跑", () => {
    const log: string[] = [];
    const [show, setShow] = createSignal(true);
    const app = mount(
      () => (
        <box>
          <Show when={show()}>
            <Inner log={log} />
          </Show>
        </box>
      ),
      { width: 10, height: 2 }
    );

    setShow(false);
    app.flush();

    // A:effect 跑了，A:cleanup 没跑（这就是坑）
    expect(log).toEqual(["A:effect", "B:effect", "B:cleanup", "C:cleanup"]);
    app.unmount();
  });
});

function Inner(props: { log: string[] }) {
  const [n] = createSignal(1);
  // A：effect 体里 onCleanup —— 卸载时不会执行
  createEffect(
    () => n(),
    () => {
      props.log.push("A:effect");
      onCleanup(() => props.log.push("A:cleanup"));
    }
  );
  // B：effect 返回清理函数 —— 正确写法
  createEffect(
    () => n(),
    () => {
      props.log.push("B:effect");
      return () => props.log.push("B:cleanup");
    }
  );
  // C：组件体里 onCleanup —— 也正确（owner 是组件）
  onCleanup(() => props.log.push("C:cleanup"));
  return <text>x</text>;
}
