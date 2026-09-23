import { describe, expect, test } from "bun:test";
import { createDiffStream, type DiffLine } from "@butui/stream";

const line = (id: string, text: string, overrides: Partial<DiffLine> = {}): DiffLine => ({
  id,
  kind: "context",
  text,
  stable: true,
  ...overrides,
});

describe("createDiffStream：增量 patch 模型", () => {
  test("append 只 bump 结构版本；upsert 同一 id 只 bump 那一行", () => {
    const source = createDiffStream({ id: "c1" });
    const v0 = source.version();
    source.upsert([line("l1", "a"), line("l2", "b")]);
    const v1 = source.version();
    const row1 = source.lineVersion(0);

    expect(v1).toBeGreaterThan(v0);
    expect(source.count()).toBe(2);

    source.upsert([line("l1", "a+")]);
    expect(source.version()).toBe(v1); // 没有新行，结构版本不变
    expect(source.lineVersion(0)).toBeGreaterThan(row1);
    expect(source.lineVersion(1)).toBe(0);
    expect(source.lineAt(0)?.text).toBe("a+");
  });

  test("replaceTail 只改尾部，并正确迁移 id 映射", () => {
    const source = createDiffStream();
    source.upsert([line("l1", "a"), line("l2", "b"), line("l3", "c")]);
    source.replaceTail([line("l2", "B"), line("l3", "C")]);

    expect(source.lines.map(l => l.text)).toEqual(["a", "B", "C"]);
    expect(source.lineAt(1)?.id).toBe("l2");

    // 旧 id 已经被替换掉，再 upsert 它会作为新行追加，而不是改错位置。
    source.upsert([line("old", "x")]);
    expect(source.count()).toBe(4);
    expect(source.lineAt(3)?.id).toBe("old");
  });

  test("streaming 只看 stable=false；flush 幂等", () => {
    const source = createDiffStream();
    source.upsert([
      line("h", "@@ -1 +1 @@", { kind: "hunk" }),
      line("a", "const x", { kind: "add", stable: false }),
    ]);
    expect(source.streaming()).toBe(true);

    source.flush();
    expect(source.streaming()).toBe(false);
    expect(source.lineAt(1)?.stable).toBe(true);

    source.flush();
    expect(source.stats.flushed).toBe(1);
  });

  test("apply 顺序执行 upsert / replaceTail", () => {
    const source = createDiffStream();
    source.apply({
      ops: [
        { op: "upsert", lines: [line("a", "a"), line("b", "b")] },
        { op: "replaceTail", lines: [line("b", "B")] },
      ],
    });
    expect(source.lines.map(l => l.text)).toEqual(["a", "B"]);
    expect(source.stats.upserts).toBe(2);
    expect(source.stats.replaceTail).toBe(1);
  });

  test("稳定行把行号涨到两位数时 gutter 会更新", () => {
    const source = createDiffStream();
    source.upsert([line("a", "a", { oldLine: 9, newLine: 9 })]);
    expect(source.gutterWidth()).toBe(1);
    source.upsert([line("a", "a", { oldLine: 10, newLine: 10 })]);
    expect(source.gutterWidth()).toBe(2);
  });

  test("5000 行 diff 中更新一行：结构版本不动，只更新目标行", () => {
    const source = createDiffStream();
    const many: DiffLine[] = [];
    for (let i = 0; i < 5000; i++) many.push(line(`l${i}`, `line ${i}`));
    source.upsert(many);
    const structure = source.version();
    const target = source.lineVersion(4321);
    const updates = source.stats.updated;

    source.upsert([line("l4321", "line 4321 changed")]);
    expect(source.version()).toBe(structure);
    expect(source.lineVersion(4321)).toBeGreaterThan(target);
    expect(source.lineVersion(4320)).toBe(0);
    expect(source.stats.updated).toBe(updates + 1);
  });
});
