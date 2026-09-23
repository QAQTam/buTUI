import { describe, expect, test } from "bun:test";
import { applyPatch, diffLines, hashContent, reversePatch, splitLines } from "@butui/undo";

describe("行级 patch（SPEC §8.4）", () => {
  test("apply(diff(before, after)) === after", () => {
    const cases: Array<[string, string]> = [
      ["a\nb\nc\n", "a\nB\nc\n"],
      ["a\nb\nc\n", "a\nc\n"],
      ["a\nc\n", "a\nb\nc\n"],
      ["", "hello\n"],
      ["hello\n", ""],
      ["a\nb\nc", "x\ny\nz"],
      ["same\n", "same\n"],
      ["line1\nline2\nline3\nline4\n", "line1\nline2 changed\nline3\nline4\nnew\n"],
    ];
    for (const [before, after] of cases) {
      const patch = diffLines(before, after);
      const result = applyPatch(before, patch);
      expect(result.ok, `${JSON.stringify(before)} → ${JSON.stringify(after)}`).toBe(true);
      if (result.ok) expect(result.text).toBe(after);
    }
  });

  test("reverse 把 after 变回 before", () => {
    const before = "a\nb\nc\nd\n";
    const after = "a\nX\nc\nY\nZ\n";
    const patch = diffLines(before, after);
    const back = applyPatch(after, reversePatch(patch));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.text).toBe(before);
  });

  test("相同文本产生空 patch", () => {
    expect(diffLines("same\n", "same\n").ops).toEqual([]);
    const result = applyPatch("same\n", diffLines("same\n", "same\n"));
    expect(result.ok && result.text).toBe("same\n");
  });

  test("上下文不匹配时报冲突，而不是写坏文件", () => {
    const patch = diffLines("a\nb\nc\n", "a\nB\nc\n");
    const result = applyPatch("a\nZZZ\nc\n", patch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.at).toBe(1);
      expect(result.expected).toEqual(["b"]);
      expect(result.actual).toEqual(["ZZZ"]);
    }
  });

  test("末尾换行风格被保留", () => {
    expect(applyPatch("a\nb", diffLines("a\nb", "a\nc"))).toEqual({ ok: true, text: "a\nc" });
    expect(applyPatch("a\nb\n", diffLines("a\nb\n", "a\nc\n"))).toEqual({
      ok: true,
      text: "a\nc\n",
    });
  });

  test("splitLines 的边界", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
  });

  test("hashContent 对内容敏感、对相同内容稳定", () => {
    expect(hashContent("a\n")).toBe(hashContent("a\n"));
    expect(hashContent("a\n")).not.toBe(hashContent("a"));
  });

  test("随机文本 fuzz：两个方向都能还原", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const randomText = (lines: number) => {
      const out: string[] = [];
      for (let i = 0; i < lines; i++) out.push(`line ${Math.floor(rnd() * 12)}`);
      return out.length ? out.join("\n") + (rnd() > 0.5 ? "\n" : "") : "";
    };

    for (let i = 0; i < 300; i++) {
      const before = randomText(Math.floor(rnd() * 20));
      const after = randomText(Math.floor(rnd() * 20));
      const patch = diffLines(before, after);

      const forward = applyPatch(before, patch);
      if (!forward.ok || forward.text !== after) {
        throw new Error(`forward 失败 #${i}\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}\npatch=${JSON.stringify(patch)}`);
      }

      const backward = applyPatch(after, reversePatch(patch));
      if (!backward.ok || backward.text !== before) {
        throw new Error(`backward 失败 #${i}\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`);
      }
    }
  });
});
