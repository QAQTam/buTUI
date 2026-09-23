import { describe, expect, test } from "bun:test";
import { PngError, adler32, decodePng, encodePng } from "@butui/image";
import { buildPng, pixelAt, rgbPng, rgbaPng } from "./helpers/png.ts";

const red = [255, 0, 0, 255] as const;
const green = [0, 255, 0, 255] as const;
const blue = [0, 0, 255, 255] as const;
const half = [0, 255, 0, 128] as const;

describe("PNG 解码（SPEC §12 图片子系统的地基）", () => {
  test("RGBA8 逐像素还原", () => {
    const png = rgbaPng(2, 2, [red, green, blue, half]);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(pixelAt(decoded.rgba, 2, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(decoded.rgba, 2, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(decoded.rgba, 2, 0, 1)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(decoded.rgba, 2, 1, 1)).toEqual([0, 255, 0, 128]);
  });

  test("5 种滤波类型都能反解", () => {
    const pixels = [red, green, blue, half, green, red, half, blue, blue];
    const expected = decodePng(rgbaPng(3, 3, pixels, 0)).rgba;
    for (const filter of [1, 2, 3, 4] as const) {
      const decoded = decodePng(rgbaPng(3, 3, pixels, filter));
      expect([...decoded.rgba], `filter ${filter}`).toEqual([...expected]);
    }
  });

  test("RGB8（无 alpha）补成不透明", () => {
    const png = rgbPng(2, 1, [
      [255, 0, 0],
      [0, 0, 255],
    ]);
    const decoded = decodePng(png);
    expect(pixelAt(decoded.rgba, 2, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(decoded.rgba, 2, 1, 0)).toEqual([0, 0, 255, 255]);
  });

  test("调色板 + tRNS 透明度", () => {
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const samples = new Uint8Array([0, 1, 2, 1]);
    const png = buildPng({
      width: 4,
      height: 1,
      colorType: 3,
      bitDepth: 8,
      samples,
      palette,
      transparency: new Uint8Array([255, 0, 128]),
    });
    const decoded = decodePng(png);
    expect(pixelAt(decoded.rgba, 4, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(decoded.rgba, 4, 1)).toEqual([0, 255, 0, 0]);
    expect(pixelAt(decoded.rgba, 4, 2)).toEqual([0, 0, 255, 128]);
  });

  test("低位深（4bit）调色板按位域解包", () => {
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    // 一行 4 个像素，4bit 索引：0,1,2,1 → 0x01 0x21
    const samples = new Uint8Array([0x01, 0x21]);
    const png = buildPng({ width: 4, height: 1, colorType: 3, bitDepth: 4, samples, palette });
    const decoded = decodePng(png);
    expect(pixelAt(decoded.rgba, 4, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(decoded.rgba, 4, 1)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(decoded.rgba, 4, 2)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(decoded.rgba, 4, 3)).toEqual([0, 255, 0, 255]);
  });

  test("灰度 8bit 展开成 RGB", () => {
    const samples = new Uint8Array([0, 128, 255]);
    const png = buildPng({ width: 3, height: 1, colorType: 0, bitDepth: 8, samples });
    const decoded = decodePng(png);
    expect(pixelAt(decoded.rgba, 3, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(decoded.rgba, 3, 1)).toEqual([128, 128, 128, 255]);
    expect(pixelAt(decoded.rgba, 3, 2)).toEqual([255, 255, 255, 255]);
  });

  test("16bit 取高字节", () => {
    // 16bit RGB：0xFFFF,0x0000,0x0000 / 0x0000,0x8000,0xFFFF
    const samples = new Uint8Array([
      0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x80, 0x00, 0xff, 0xff,
    ]);
    const png = buildPng({ width: 2, height: 1, colorType: 2, bitDepth: 16, samples });
    const decoded = decodePng(png);
    expect(pixelAt(decoded.rgba, 2, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(decoded.rgba, 2, 1)).toEqual([0, 128, 255, 255]);
  });

  test("非 PNG 字节明确报错，而不是画出花屏", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(PngError);
  });

  test("IDAT 被破坏时报错，而不是画出花屏", () => {
    const png = rgbaPng(4, 4, new Array(16).fill(red));
    // 把 IDAT 的数据段拦腰截断（保留头部与 CRC 位置，让 CRC 也不匹配）
    const broken = png.slice();
    const idatAt = 8 + 25; // signature + IHDR
    broken[idatAt + 11] ^= 0xff;
    broken[idatAt + 12] ^= 0xff;
    expect(() => decodePng(broken)).toThrow(PngError);
  });

  test("与 Bun.Image 编码的 PNG 互通（真实主路径）", async () => {
    const source = rgbaPng(3, 2, [red, green, blue, half, green, red]);
    const reencoded = await new Bun.Image(source).png().bytes();
    const decoded = decodePng(reencoded);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect(pixelAt(decoded.rgba, 3, 0, 0)).toEqual([255, 0, 0, 255]);
    // 半透明像素在 Bun 的重编码里必须原样保留
    expect(pixelAt(decoded.rgba, 3, 0, 1)).toEqual([0, 255, 0, 128]);
    expect(pixelAt(decoded.rgba, 3, 2, 1)).toEqual([255, 0, 0, 255]);
  });
});

describe("PNG 编码器（程序化造图）", () => {
  test("encodePng → decodePng 逐像素还原，5 种滤波都对", () => {
    const rgba = new Uint8Array(4 * 3 * 4);
    for (let i = 0; i < 4 * 3; i++) {
      rgba[i * 4] = i * 20;
      rgba[i * 4 + 1] = 255 - i * 20;
      rgba[i * 4 + 2] = (i * 37) & 0xff;
      rgba[i * 4 + 3] = 200;
    }
    for (const filter of [0, 1, 2, 3, 4] as const) {
      const png = encodePng({ width: 4, height: 3, rgba, filter });
      const decoded = decodePng(png);
      expect(decoded.width, `filter ${filter}`).toBe(4);
      expect(decoded.height).toBe(3);
      expect([...decoded.rgba]).toEqual([...rgba]);
    }
  });

  test("encodePng 的产物 Bun.Image 能完整解码（证明 zlib 包装正确）", async () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]);
    const png = encodePng({ width: 2, height: 1, rgba });
    const round = await new Bun.Image(png).png().bytes();
    const decoded = decodePng(round);
    expect(pixelAt(decoded.rgba, 2, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(decoded.rgba, 2, 1)).toEqual([0, 255, 0, 128]);
  });

  test("encodePng 拒绝长度不对的像素缓冲", () => {
    expect(() => encodePng({ width: 2, height: 2, rgba: new Uint8Array(4) })).toThrow();
  });

  test("adler32 对已知输入给出标准值", () => {
    // zlib 规范里的例子：adler32("Wikipedia") = 0x11E60398
    expect(adler32(new TextEncoder().encode("Wikipedia"))).toBe(0x11e60398);
  });
});
