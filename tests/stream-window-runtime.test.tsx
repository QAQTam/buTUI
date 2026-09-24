import { describe, expect, test } from "bun:test";
import { StreamWindow } from "@butui/components";
import { createModifiers, MemoryLedger, type MouseEvent } from "@butui/core";
import { createTuiApp } from "@butui/runtime";
import {
  MemorySpillStore,
  StreamLedger,
  type StreamEnvelope,
} from "@butui/stream";
import { FakeTerminal, tick } from "./helpers/terminal.ts";

function envelope(seq: number, delta: string): StreamEnvelope {
  return {
    sessionId: "runtime-window",
    streamId: "stream-1",
    seq,
    baseRevision: seq - 1,
    kind: "text",
    priority: 1,
    op: { type: "append", delta },
    createdAt: seq,
  };
}

async function createLedger(lines: number): Promise<StreamLedger> {
  const ledger = new StreamLedger({
    memory: new MemoryLedger({ totalBytes: 512 }),
    memoryOwner: "runtime-window",
    spill: { store: new MemorySpillStore(), policy: { maxBytes: 0 } },
  });
  ledger.open({
    streamId: "stream-1",
    kind: "text",
    priority: 1,
    createdAt: 0,
  });
  for (let seq = 1; seq <= lines; seq++) {
    const result = await ledger.applyWithSpill(
      envelope(seq, `value-${seq}\n`)
    );
    if (result.status !== "applied") {
      throw new Error(`append failed at ${seq}: ${result.status}`);
    }
  }
  return ledger;
}

function wheel(direction: "up" | "down"): MouseEvent {
  return {
    type: "mouse",
    action: "wheel",
    button: "none",
    wheel: direction,
    x: 1,
    y: 1,
    modifiers: createModifiers(),
    stopPropagation() {},
    preventDefault() {},
    get defaultPrevented() {
      return false;
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline) {
    await tick();
  }
}

describe("StreamWindow runtime integration", () => {
  test("冷窗口经 createTuiApp 加载，并在 FrameClock 下合并滚轮", async () => {
    const ledger = await createLedger(1_000);
    const terminal = new FakeTerminal();
    terminal.size = { columns: 40, rows: 12 };
    const app = createTuiApp({
      terminal,
      size: terminal.size,
      view: () => (
        <StreamWindow
          ledger={ledger}
          streamId="stream-1"
          height={10}
          width={40}
          scrollbar
        />
      ),
      onQuit: () => {},
    });

    await waitFor(() => app.frame().text().includes("value-1"));
    expect(app.frame().text()).toContain("value-1");
    expect(app.frame().text()).not.toContain("value-11");

    for (let index = 0; index < 5; index++) {
      expect(app.send(wheel("down"))).toBeGreaterThan(0);
    }
    await waitFor(() => app.frame().text().includes("value-15"));

    const text = app.frame().text();
    expect(text).toContain("value-6");
    expect(text).toContain("value-15");
    expect(text).not.toContain("value-1\n");
    app.dispose();
  });
});
