import { describe, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";

/**
 * 这组测试不是测 buTUI，而是把 Solid 2 RC 的行为差异钉下来。
 *
 * Solid 1 里 signal 写入是立即生效的；Solid 2 RC 会推迟到 flush。后果是
 * 「同一 tick 内连续读-改-写」会丢更新 —— 对 TUI 来说就是快速输入丢字符。
 * 所以 buTUI 的约定是：**累加型状态一律用 updater 函数**。
 */
describe("Solid 2 signal 语义契约", () => {
  test("写入在 flush 前不可见", () => {
    const [value, setValue] = createSignal(0);
    setValue(1);
    expect(value()).toBe(0);
    flush();
    expect(value()).toBe(1);
  });

  test("同 tick 读-改-写会丢更新（这是坑，不是特性）", () => {
    const [text, setText] = createSignal("");
    setText(text() + "a");
    setText(text() + "b");
    flush();
    // 期望是 "ab"，实际是 "b" —— 第一个字符被吞掉
    expect(text()).toBe("b");
  });

  test("updater 形式是正确的写法", () => {
    const [text, setText] = createSignal("");
    setText(prev => prev + "a");
    setText(prev => prev + "b");
    flush();
    expect(text()).toBe("ab");
  });

  test("同 tick 多次直接赋值是 last-wins", () => {
    const [value, setValue] = createSignal(0);
    setValue(1);
    setValue(2);
    setValue(3);
    flush();
    expect(value()).toBe(3);
  });
});
