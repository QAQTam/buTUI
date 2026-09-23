import { describe, expect, test } from "bun:test";
import { LineBuffer } from "@butui/stream";

/** 整段折行的参考实现 */
const reference = (text: string, width: number): string[] =>
  Bun.wrapAnsi(text, width, { hard: true, wordWrap: true, trim: false }).split("\n");

/** 确定性伪随机，保证失败可复现 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const ALPHABET = [
  "a", "b", "c", "z", " ", " ", " ", "\n",
  "中", "文", "测", "试", "🎯", "👨‍👩‍👧",
  "**", "*", "_", "`", "-", ">", "#", "|", "1", ".", "(", ")",
];

function randomText(random: () => number, length: number): string {
  let out = "";
  while (out.length < length) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return out.slice(0, length);
}

describe("LineBuffer：增量折行 ≡ 整段折行", () => {
  test("固定用例", () => {
    const cases: Array<[string, number]> = [
      ["a\n", 10],
      ["a\n\nb", 10],
      ["aaa bbb ccc ddd", 4],
      ["hello wor", 6],
      ["中文测试", 3],
      ["a  b", 2],
      ["\n\n\n", 5],
      ["emoji 👨‍👩‍👧 test", 4],
      ["非常长的一行中文内容用来测试折行是否与整段一致", 7],
    ];
    for (const [text, width] of cases) {
      const buffer = new LineBuffer({ width });
      buffer.push(text);
      buffer.flush();
      expect(buffer.lines, `text=${JSON.stringify(text)} width=${width}`).toEqual(
        reference(text, width)
      );
    }
  });

  test("随机文本 + 随机分块（1000 轮）", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const random = rng(seed);
      const width = 2 + Math.floor(random() * 20);
      const text = randomText(random, Math.floor(random() * 120));
      const buffer = new LineBuffer({ width });

      // 按 code point 切块：真实 delta 来自 UTF-8 流式解码，不会切开代理对，
      // 但**会**切开 ZWJ 序列（emoji 分多次到达），这正是要覆盖的情况
      const points = [...text];
      let cursor = 0;
      while (cursor < points.length) {
        const size = 1 + Math.floor(random() * 7);
        buffer.push(points.slice(cursor, cursor + size).join(""));
        cursor += size;
      }
      buffer.flush();

      // 空输入约定为 0 行（wrapAnsi("") 会给出 1 个空行，那是它的边界行为）
      const expected = text === "" ? [] : reference(text, width);
      const actual = [...buffer.lines];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `seed=${seed} width=${width}\ntext=${JSON.stringify(text)}\n` +
            `expected=${JSON.stringify(expected)}\nactual  =${JSON.stringify(actual)}`
        );
      }
    }
  });

  test("空输入产生 0 行（而不是 1 个空行）", () => {
    const buffer = new LineBuffer({ width: 5 });
    expect(buffer.lines).toEqual([]);
    buffer.flush();
    expect(buffer.lines).toEqual([]);
  });

  test("每次 push 返回的行拼起来等于全部行", () => {
    const random = rng(42);
    const text = randomText(random, 300);
    const buffer = new LineBuffer({ width: 9 });
    const emitted: string[] = [];
    for (let i = 0; i < text.length; i += 3) {
      emitted.push(...buffer.push(text.slice(i, i + 3)));
    }
    emitted.push(...buffer.flush());
    expect(emitted).toEqual(reference(text, 9));
  });
});

describe("LineBuffer：复杂度", () => {
  test("每块的处理量与已累积长度无关", () => {
    const measure = (totalLength: number): number => {
      const buffer = new LineBuffer({ width: 40 });
      // 用无空格的重复内容，逼出最多的折行
      const text = "x".repeat(totalLength);
      let before = 0;
      let worst = 0;
      for (let i = 0; i < text.length; i += 8) {
        buffer.push(text.slice(i, i + 8));
        const now = buffer.stats.wrappedChars;
        worst = Math.max(worst, now - before);
        before = now;
      }
      return worst;
    };

    const small = measure(2_000);
    const large = measure(200_000);

    // 单块最多处理 `width + 块长` 个字符，与总量无关
    expect(small).toBeLessThanOrEqual(40 + 8);
    expect(large).toBeLessThanOrEqual(40 + 8);
    expect(large).toBe(small);
  });

  test("总量翻 100 倍，总处理量线性增长而非平方", () => {
    const total = (length: number): number => {
      const buffer = new LineBuffer({ width: 40 });
      const text = "hello world ".repeat(length / 12);
      for (let i = 0; i < text.length; i += 16) buffer.push(text.slice(i, i + 16));
      return buffer.stats.wrappedChars;
    };

    const n1 = total(20_000);
    const n2 = total(200_000);
    // 线性 → 比值约 10；平方 → 比值约 100
    expect(n2 / n1).toBeLessThan(15);
  });
});
