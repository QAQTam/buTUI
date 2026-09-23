import { describe, expect, test } from "bun:test";
import {
  KITTY_CHUNK,
  blend,
  halfblockLines,
  iterm2Sequence,
  kittyDelete,
  kittySequence,
  placeholderLines,
  sixelSequence,
  to16,
  to256,
} from "@butui/image";
import { rgbaPng } from "./helpers/png.ts";

const rgba = (pixels: readonly (readonly [number, number, number, number])[]): Uint8Array => {
  const out = new Uint8Array(pixels.length * 4);
  pixels.forEach((p, i) => out.set(p, i * 4));
  return out;
};

/** 测试用最小 sixel 解码器：把序列还原成「每像素一个调色板索引」 */
function decodeSixel(sequence: string): {
  width: number;
  height: number;
  indices: number[][];
  palette: Map<number, [number, number, number]>;
} {
  const body = sequence.slice(3, -2); // 去掉 \x1bPq 和 \x1b\\
  const palette = new Map<number, [number, number, number]>();
  const raster = /^"(\d+);(\d+);(\d+);(\d+)/.exec(body);
  if (!raster) throw new Error("缺少 raster attributes");
  const width = Number(raster[3]);
  const declaredHeight = Number(raster[4]);

  let x = 0;
  let band = 0;
  let color = 0;
  const indices: number[][] = [];

  const put = (value: number): void => {
    for (let bit = 0; bit < 6; bit++) {
      if ((value & (1 << bit)) === 0) continue;
      const y = band * 6 + bit;
      indices[y] ??= [];
      indices[y][x] = color;
    }
  };

  let i = raster[0].length;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "#") {
      const match = /^#(\d+)(?:;2;(\d+);(\d+);(\d+))?/.exec(body.slice(i));
      if (!match) throw new Error(`坏的调色板指令 @${i}`);
      color = Number(match[1]);
      if (match[2] !== undefined) {
        palette.set(color, [Number(match[2]), Number(match[3]), Number(match[4])]);
      }
      i += match[0].length;
      continue;
    }
    if (ch === "$") {
      x = 0;
      i++;
      continue;
    }
    if (ch === "-") {
      band++;
      x = 0;
      i++;
      continue;
    }
    if (ch === "!") {
      const match = /^!(\d+)(.)/.exec(body.slice(i));
      if (!match) throw new Error(`坏的 RLE @${i}`);
      for (let n = 0; n < Number(match[1]); n++) put(match[2].charCodeAt(0) - 63), x++;
      i += match[0].length;
      continue;
    }
    put(ch.charCodeAt(0) - 63);
    x++;
    i++;
  }

  return { width, height: declaredHeight, indices, palette };
}

describe("图片协议编码（SPEC §12.1）", () => {
  test("Kitty：参数、分块、base64 完整性", () => {
    const png = rgbaPng(2, 2, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
    ]);
    const sequence = kittySequence(png, { cols: 4, rows: 2, id: 42 });
    expect(sequence.startsWith("\x1b_G")).toBe(true);
    expect(sequence.endsWith("\x1b\\")).toBe(true);
    expect(sequence).toContain("a=T,f=100,q=2,C=1,c=4,r=2,i=42,p=42");
    expect(sequence).toContain(",m=0;");

    // 只有一块时不应出现 m=1
    expect(sequence).not.toContain("m=1");

    // 负载必须是原 PNG 的 base64
    const payload = sequence.slice(sequence.indexOf(";") + 1, -2);
    expect(payload).toBe(Buffer.from(png).toString("base64"));
  });

  test("Kitty：大图分块，每块 ≤4096 且可无损拼回", () => {
    const big = new Uint8Array(20_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const sequence = kittySequence(big, { cols: 10, rows: 5, id: 7 });

    const chunks = [...sequence.matchAll(/\x1b_G([^;]*);([\s\S]*?)\x1b\\/g)];
    expect(chunks.length).toBeGreaterThan(1);
    const payloads = chunks.map(m => m[2]);
    for (const part of payloads) expect(part.length).toBeLessThanOrEqual(KITTY_CHUNK);
    expect(payloads.join("")).toBe(Buffer.from(big).toString("base64"));

    // 第一块带完整参数且 m=1，最后一块 m=0
    expect(chunks[0][1]).toContain("a=T");
    expect(chunks[0][1]).toContain("m=1");
    expect(chunks.at(-1)![1]).toBe("m=0");
  });

  test("Kitty：删除指令按 image id", () => {
    expect(kittyDelete(42)).toBe("\x1b_Ga=d,d=i,i=42,q=2\x1b\\");
  });

  test("iTerm2：OSC 1337 参数与负载", () => {
    const png = rgbaPng(1, 1, [[1, 2, 3, 255]]);
    const sequence = iterm2Sequence(png, { cols: 8, rows: 3, name: "shot.png" });
    expect(sequence.startsWith("\x1b]1337;File=inline=1;")).toBe(true);
    expect(sequence.endsWith("\x07")).toBe(true);
    expect(sequence).toContain("width=8;height=3;preserveAspectRatio=0");
    expect(sequence).toContain(`name=${Buffer.from("shot.png").toString("base64")}`);
    expect(sequence).toContain(`:${Buffer.from(png).toString("base64")}`);
  });

  test("Sixel：可被反解回原像素的调色板索引", () => {
    const width = 4;
    const height = 6;
    const pixels: [number, number, number, number][] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 纯色：左半红、右半蓝
        pixels.push(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
      }
    }
    const sequence = sixelSequence(rgba(pixels), width, height);
    expect(sequence.startsWith('\x1bPq"1;1;4;6')).toBe(true);
    expect(sequence.endsWith("\x1b\\")).toBe(true);

    const decoded = decodeSixel(sequence);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(6);
    expect(decoded.palette.size).toBe(2);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = decoded.indices[y][x];
        const [r, g, b] = decoded.palette.get(index)!;
        // 红色立方索引 = 5*36 = 180；蓝色 = 5
        expect([r, g, b]).toEqual(x < 2 ? [100, 0, 0] : [0, 0, 100]);
      }
    }
  });

  test("Sixel：行程编码把整行同色压成 !count", () => {
    const width = 20;
    const pixels: [number, number, number, number][] = Array.from({ length: width }, () => [
      255, 255, 255, 255,
    ]);
    const sequence = sixelSequence(rgba(pixels), width, 1);
    expect(sequence).toContain("!20");
    expect(sequence.length).toBeLessThan(80);
  });

  test("半块图：一个 cell 两个像素，SGR 按段合并", () => {
    // 4 列 2 行：上半红、下半蓝，全部同色 → 只应出现一次前景 + 一次背景
    const pixels: [number, number, number, number][] = [];
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) pixels.push(y === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
    }
    const lines = halfblockLines(rgba(pixels), 4, 2, { depth: "truecolor" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe("\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀▀▀▀\x1b[0m");
  });

  test("半块图：奇数高度用背景色补下半格", () => {
    const lines = halfblockLines(rgba([[255, 0, 0, 255]]), 1, 1, { depth: "truecolor" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("▀");
    expect(lines[0]).toContain("\x1b[48;2;0;0;0m");
  });

  test("半块图：256 色与 16 色降级", () => {
    const pixels = rgba([[255, 0, 0, 255], [255, 0, 0, 255]]);
    expect(halfblockLines(pixels, 1, 2, { depth: "256" })[0]).toContain("\x1b[38;5;");
    expect(halfblockLines(pixels, 1, 2, { depth: "16" })[0]).toContain("\x1b[91m");
  });

  test("半块图：完全透明的上下两像素留空格", () => {
    const lines = halfblockLines(rgba([[255, 0, 0, 0], [0, 255, 0, 0]]), 1, 2, {
      transparent: true,
    });
    expect(lines[0]).toBe(" \x1b[0m");
  });

  test("alpha 混到背景色上", () => {
    const pixels = rgba([[255, 0, 0, 128]]);
    expect(blend(pixels, 0, [0, 0, 0])).toEqual([128, 0, 0]);
    expect(blend(pixels, 0, [255, 255, 255])).toEqual([255, 127, 127]);
    expect(blend(rgba([[10, 20, 30, 255]]), 0)).toEqual([10, 20, 30]);
    expect(blend(rgba([[10, 20, 30, 0]]), 0, [7, 8, 9])).toEqual([7, 8, 9]);
  });

  test("颜色量化：黑/白/灰落在预期索引区间", () => {
    expect(to256([0, 0, 0])).toBe(16);
    expect(to256([255, 255, 255])).toBe(231);
    const gray = to256([128, 128, 128]);
    expect(gray).toBeGreaterThanOrEqual(232);
    expect(gray).toBeLessThanOrEqual(255);
    expect(to16([255, 0, 0])).toBe(9);
    expect(to16([0, 0, 0])).toBe(0);
    expect(to16([255, 255, 255])).toBe(15);
  });

  test("占位符：尺寸严格、标签居中、控制字符被清掉", () => {
    const lines = placeholderLines({ cols: 12, rows: 5, text: "shot\x1b[31m.png" });
    expect(lines.length).toBe(5);
    for (const line of lines) expect(Bun.stringWidth(line)).toBe(12);
    expect(lines[0]).toBe(`┌${"─".repeat(10)}┐`);
    expect(lines.at(-1)).toBe(`└${"─".repeat(10)}┘`);
    expect(lines.join("\n")).toContain("shot");
    expect(lines.join("\n")).not.toContain("\x1b");
  });
});
