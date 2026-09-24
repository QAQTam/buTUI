import { describe, expect, test } from "bun:test";
import { MemoryLedger } from "@butui/core";
import {
  MemorySpillStore,
  StreamLedger,
  StreamText,
  createStreamWindow,
  type LineId,
  type SpillRecord,
  type SpillStore,
  type StreamEnvelope,
} from "@butui/stream";
import { mount } from "@butui/test";

class DelayedSpillStore implements SpillStore {
  private readonly inner = new MemorySpillStore();
  readManyCalls = 0;

  write(record: SpillRecord): void {
    this.inner.write(record);
  }

  read(streamId: string, lineId: LineId): SpillRecord | undefined {
    return this.inner.read(streamId, lineId);
  }

  async readMany(
    streamId: string,
    lineIds: readonly LineId[]
  ): Promise<(SpillRecord | undefined)[]> {
    this.readManyCalls++;
    const delay = lineIds[0] === "line-1" ? 30 : 0;
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return this.inner.readMany(streamId, lineIds);
  }

  delete(streamId: string, lineId: LineId): void {
    this.inner.delete(streamId, lineId);
  }
}

function envelope(seq: number, delta: string): StreamEnvelope {
  return {
    sessionId: "window-session",
    streamId: "stream-1",
    seq,
    baseRevision: seq - 1,
    kind: "text",
    priority: 1,
    op: { type: "append", delta },
    createdAt: seq,
  };
}

async function createSpilledLedger(
  lines: number,
  store: SpillStore = new MemorySpillStore()
): Promise<StreamLedger> {
  const ledger = new StreamLedger({
    memory: new MemoryLedger({ totalBytes: 512 }),
    memoryOwner: "window-test",
    spill: { store, policy: { maxBytes: 0 } },
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

describe("createStreamWindow", () => {
  test("只把稳定窗口适配成可挂载的 StreamSource", async () => {
    const ledger = await createSpilledLedger(3_000);
    const source = createStreamWindow({ ledger, streamId: "stream-1" });
    const loaded = await source.load(2_000, 5);

    expect(loaded).toMatchObject({ offset: 2_000, totalLines: 3_000 });
    expect(loaded.lines.map(line => line.text)).toEqual([
      "value-2001",
      "value-2002",
      "value-2003",
      "value-2004",
      "value-2005",
    ]);
    expect(source.offset()).toBe(2_000);
    expect(source.totalLines()).toBe(3_000);
    expect(source.loading()).toBe(false);

    const app = mount(() => <StreamText source={source} />, {
      width: 40,
      height: 10,
    });
    app.flush();
    expect(app.text()).toContain("value-2001");
    expect(app.text()).toContain("value-2005");
    expect(app.text()).not.toContain("value-1\n");
    app.unmount();

    expect(() => source.push("late")).toThrow("只读");

    const appended = await ledger.applyWithSpill(
      envelope(3_001, "value-3001\n")
    );
    expect(appended.status).toBe("applied");
    const refreshed = await source.refresh();
    expect(refreshed?.totalLines).toBe(3_001);
    expect(source.totalLines()).toBe(3_001);
  });

  test("快速滚动时旧请求不能覆盖新窗口", async () => {
    const store = new DelayedSpillStore();
    const ledger = await createSpilledLedger(1_500, store);
    const source = createStreamWindow({ ledger, streamId: "stream-1" });

    const oldRequest = source.load(0, 5);
    const newRequest = source.load(1_400, 5);
    await Promise.all([oldRequest, newRequest]);

    expect(source.offset()).toBe(1_400);
    expect(source.lines.map(line => line.text)).toEqual([
      "value-1401",
      "value-1402",
      "value-1403",
      "value-1404",
      "value-1405",
    ]);
  });

  test("重复窗口命中缓存，refresh 强制绕过缓存", async () => {
    const store = new DelayedSpillStore();
    const ledger = await createSpilledLedger(1_500, store);
    const source = createStreamWindow({
      ledger,
      streamId: "stream-1",
      cacheSize: 2,
    });
    store.readManyCalls = 0;

    await source.load(1_400, 5);
    const afterFirstLoad = store.readManyCalls;
    expect(afterFirstLoad).toBeGreaterThan(0);

    await source.load(1_400, 5);
    expect(store.readManyCalls).toBe(afterFirstLoad);

    await source.refresh();
    expect(store.readManyCalls).toBeGreaterThan(afterFirstLoad);
  });
});
