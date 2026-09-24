import { describe, expect, test } from "bun:test";
import {
  StreamLedger,
  createLedgerAdapter,
  createTextStream,
  type ReplaceableStreamSource,
} from "@butui/stream";

describe("StreamLedger adapter", () => {
  test("push / flush 保留 StreamSource 行为并同步 ledger", () => {
    const source = createTextStream({ width: 20 });
    const adapter = createLedgerAdapter(source, {
      streamId: "s1",
      createdAt: 0,
    });

    adapter.push("hello\nworld");
    expect(adapter.lines.map(line => line.text)).toEqual(["hello"]);
    expect(adapter.tail()).toBe("world");
    expect(adapter.projection().stableLines.map(line => line.text)).toEqual([
      "hello",
    ]);
    expect(adapter.projection().volatileTail.map(line => line.text)).toEqual([
      "world",
    ]);

    adapter.flush();
    expect(adapter.projection().status).toBe("finished");
    expect(adapter.projection().stableLines.map(line => line.text)).toEqual([
      "hello",
      "world",
    ]);
    expect(adapter.stats.ledgerRevision).toBe(2);
    expect(() => adapter.push("late")).toThrow();
  });

  test("底层 source 支持扩展时，replace-tail / cancel 同步到 ledger", () => {
    const base = createTextStream({ width: 20 });
    const calls: string[] = [];
    const source: ReplaceableStreamSource = {
      ...base,
      replaceTail(from, text) {
        calls.push(`replace:${from?.lineId ?? "all"}:${text}`);
      },
      cancel(reason) {
        calls.push(`cancel:${reason}`);
      },
    };
    const adapter = createLedgerAdapter(source, {
      streamId: "s1",
      ledger: new StreamLedger(),
    });

    adapter.push("hello");
    const tail = adapter.projection().volatileTail[0]!;
    expect(
      adapter.replaceTail({ lineId: tail.id, grapheme: 0 }, "bye")
    ).toEqual({ status: "applied", revision: 2, linesAdded: 0 });
    expect(adapter.projection().volatileTail[0]?.text).toBe("bye");
    expect(calls).toEqual([`replace:${tail.id}:bye`]);

    expect(adapter.cancel("user")).toEqual({
      status: "applied",
      revision: 3,
      linesAdded: 0,
    });
    expect(adapter.projection().status).toBe("cancelled");
    expect(calls).toEqual([`replace:${tail.id}:bye`, "cancel:user"]);
  });

  test("底层 source 不支持扩展时明确拒绝，不产生 ledger 分叉", () => {
    const source = createTextStream({ width: 20 });
    const adapter = createLedgerAdapter(source, { streamId: "s1" });
    adapter.push("hello");
    const tail = adapter.projection().volatileTail[0]!;

    expect(() =>
      adapter.replaceTail({ lineId: tail.id, grapheme: 0 }, "bye")
    ).toThrow("replace-tail");
    expect(() => adapter.cancel("user")).toThrow("cancel");
    expect(adapter.projection().status).toBe("open");
    expect(adapter.projection().volatileTail[0]?.text).toBe("hello");
  });
});
