import { describe, expect, test } from "bun:test";
import { TerminalArbiter, type TerminalArbiterOptions } from "@butui/terminal";

function harness(writeResult = true) {
  let now = 0;
  let nextHandle = 1;
  let result = writeResult;
  const writes: string[] = [];
  const drains = new Set<() => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();

  const options: TerminalArbiterOptions = {
    write(bytes) {
      writes.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
      return result;
    },
    onDrain(listener) {
      drains.add(listener);
      return () => drains.delete(listener);
    },
    now: () => now,
    setTimeout: (callback, delay) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + delay, callback });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: handle => {
      timers.delete(handle as unknown as number);
    },
  };

  return {
    arbiter: new TerminalArbiter(options),
    writes,
    setWriteResult(value: boolean) {
      result = value;
    },
    drain() {
      for (const listener of [...drains]) listener();
    },
    runNextTimer() {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) throw new Error("no timer scheduled");
      const [handle, timer] = next;
      timers.delete(handle);
      now = timer.at;
      timer.callback();
      return now;
    },
  };
}

describe("TerminalArbiter", () => {
  test("同一时刻只有一个 active lease，release 后按优先级授予", async () => {
    const h = harness();
    const first = await h.arbiter.acquire({
      owner: "runtime",
      kind: "frame",
      reason: "main",
    });
    const appendPromise = h.arbiter.acquire({
      owner: "log",
      kind: "append",
      reason: "console",
    });
    const rawPromise = h.arbiter.acquire({
      owner: "child",
      kind: "raw",
      reason: "pty",
      priority: 10,
    });

    expect(h.arbiter.current()).toBe(first);
    await h.arbiter.release(first);
    const raw = await rawPromise;
    expect(raw.kind).toBe("raw");
    expect(h.arbiter.current()).toBe(raw);

    await h.arbiter.release(raw);
    const append = await appendPromise;
    expect(append.kind).toBe("append");
    h.arbiter.dispose();
  });

  test("frame stale / superseded 被拒绝，合法 frame 记录 accepted", async () => {
    const h = harness();
    const lease = await h.arbiter.acquire({
      owner: "runtime",
      kind: "frame",
      reason: "main",
    });

    expect(
      h.arbiter.write(lease, { kind: "frame", frameId: 1, bytes: "a" })
    ).toMatchObject({ accepted: true, blocked: false });
    expect(
      h.arbiter.write(lease, { kind: "frame", frameId: 1, bytes: "b" })
    ).toMatchObject({ accepted: false, rejectedReason: "stale-frame" });
    expect(
      h.arbiter.write(lease, {
        kind: "frame",
        frameId: 2,
        replaces: 1,
        bytes: "c",
      })
    ).toMatchObject({ accepted: false, rejectedReason: "superseded" });
    expect(
      h.arbiter.write(lease, { kind: "frame", frameId: 2, bytes: "d" })
    ).toMatchObject({ accepted: true });
    h.arbiter.dispose();
  });

  test("append 标记 full damage，下一次 frame 清账", async () => {
    const h = harness();
    const lease = await h.arbiter.acquire({
      owner: "runtime",
      kind: "frame",
      reason: "main",
    });

    expect(
      h.arbiter.write(lease, { kind: "append", bytes: "log\n" })
    ).toMatchObject({ accepted: true, requiresFullDamage: true });
    expect(h.arbiter.requiresFullDamage()).toBe(true);
    expect(
      h.arbiter.write(lease, { kind: "frame", frameId: 1, bytes: "frame" })
    ).toMatchObject({ accepted: true, requiresFullDamage: true });
    expect(h.arbiter.requiresFullDamage()).toBe(false);
    h.arbiter.dispose();
  });

  test("raw suspend / resume 后要求 full damage", async () => {
    const h = harness();
    const frame = await h.arbiter.acquire({
      owner: "runtime",
      kind: "frame",
      reason: "main",
    });
    const rawPromise = h.arbiter.acquire({
      owner: "child",
      kind: "raw",
      reason: "pty",
      priority: 10,
    });

    await h.arbiter.suspend(frame, "child");
    const raw = await rawPromise;
    expect(h.arbiter.write(raw, { kind: "append", bytes: "raw" }).accepted).toBe(true);

    await h.arbiter.release(raw);
    await h.arbiter.resume(frame);
    expect(h.arbiter.requiresFullDamage()).toBe(true);
    expect(h.arbiter.current()).toBe(frame);
    h.arbiter.dispose();
  });

  test("blocked 返回 drained promise，drain 后 resolve", async () => {
    const h = harness(false);
    const lease = await h.arbiter.acquire({
      owner: "runtime",
      kind: "frame",
      reason: "main",
    });
    const receipt = h.arbiter.write(lease, {
      kind: "frame",
      frameId: 1,
      bytes: "blocked",
      flush: "drained",
    });

    expect(receipt).toMatchObject({ accepted: false, blocked: true });
    let drained = false;
    receipt.drained?.then(() => {
      drained = true;
    });
    h.drain();
    await Bun.sleep(0);
    expect(drained).toBe(true);
    h.arbiter.dispose();
  });

  test("ttl 到期 revoke，并拒绝后续写", async () => {
    const h = harness();
    const lease = await h.arbiter.acquire({
      owner: "plugin",
      kind: "append",
      reason: "log",
      ttlMs: 100,
    });
    h.runNextTimer();
    expect(lease.state).toBe("revoked");
    expect(h.arbiter.current()).toBeUndefined();
    expect(h.arbiter.write(lease, { kind: "append", bytes: "late" })).toMatchObject({
      accepted: false,
      rejectedReason: "closed",
    });
    h.arbiter.dispose();
  });
});
