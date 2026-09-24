import { describe, expect, test } from "bun:test";
import { FrameBarrierStore } from "../packages/runtime/src/frame-barrier.ts";

describe("FrameBarrierStore", () => {
  test("accepted 与 drained 分阶段完成，并保留完成快照", async () => {
    const store = new FrameBarrierStore();
    const barrier = store.begin(1);
    let accepted = false;
    let drained = false;

    void store.wait(1, "accepted").then(() => {
      accepted = true;
    });
    void store.wait(1, "drained").then(() => {
      drained = true;
    });

    barrier.markAccepted();
    await Promise.resolve();
    expect(accepted).toBe(true);
    expect(drained).toBe(false);

    barrier.markDrained();
    await Promise.resolve();
    expect(drained).toBe(true);

    // 已完成 frame 的后续查询也必须稳定。
    await store.wait(1, "accepted");
    await store.wait(1, "drained");
    expect(store.size).toBe(0);
  });

  test("drained 隐式满足 accepted，不依赖调用顺序", async () => {
    const store = new FrameBarrierStore();
    const barrier = store.begin(7);
    barrier.markDrained();

    await store.wait(7, "accepted");
    await store.wait(7, "drained");
  });

  test("reject 同时终止 accepted / drained，并保留错误", async () => {
    const store = new FrameBarrierStore();
    const barrier = store.begin(2);
    const accepted = store.wait(2, "accepted");
    const drained = store.wait(2, "drained");

    barrier.reject(new Error("boom"));

    await expect(accepted).rejects.toThrow("boom");
    await expect(drained).rejects.toThrow("boom");
    await expect(store.wait(2, "drained")).rejects.toThrow("boom");
  });

  test("accepted 后拒绝 drained 不抹掉 accepted 事实", async () => {
    const store = new FrameBarrierStore();
    const barrier = store.begin(3);
    const drained = store.wait(3, "drained");
    barrier.markAccepted();
    barrier.reject(new Error("suspended"));

    await store.wait(3, "accepted");
    await expect(drained).rejects.toThrow("suspended");
    await expect(store.wait(3, "drained")).rejects.toThrow("suspended");
  });

  test("未知 frame 明确失败", async () => {
    const store = new FrameBarrierStore();
    await expect(store.wait(99)).rejects.toThrow("unknown frame 99");
  });
});
