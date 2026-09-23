/**
 * 测试用 PNG 编码器。
 *
 * 主路径的编码器在 `@butui/image` 里（`encodePng`）。这里额外提供**解码器
 * 兼容面**需要的花样：调色板、低位深、16bit、逐行指定滤波 —— 用来验证
 * 「别人生成的 PNG 我们也解得开」。块与 zlib 的拼接复用包的实现，避免两份
 * 可能漂移的代码。
 */
import { pngChunk, zlibCompress } from "@butui/image";

export type ColorType = 0 | 2 | 3 | 6;
export type FilterType = 0 | 1 | 2 | 3 | 4;

export interface PngSpec {
  width: number;
  height: number;
  colorType: ColorType;
  bitDepth: number;
  /** 未滤波的样本字节，逐行紧密排列（不含每行的 filter 字节） */
  samples: Uint8Array;
  /** colorType 3 的调色板 */
  palette?: Uint8Array;
  transparency?: Uint8Array;
  /** 每行使用的滤波类型；给一个数字表示所有行都用它 */
  filter?: FilterType;
}

function writeU32(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 按 PNG 规则给一行样本做滤波（编码方向） */
export function filterRow(
  raw: Uint8Array,
  previous: Uint8Array | undefined,
  filter: FilterType,
  bpp: number
): Uint8Array {
  const out = new Uint8Array(raw.length);
  for (let x = 0; x < raw.length; x++) {
    const left = x >= bpp ? raw[x - bpp] : 0;
    const up = previous ? previous[x] : 0;
    const upLeft = previous && x >= bpp ? previous[x - bpp] : 0;
    let value: number;
    switch (filter) {
      case 0:
        value = raw[x];
        break;
      case 1:
        value = raw[x] - left;
        break;
      case 2:
        value = raw[x] - up;
        break;
      case 3:
        value = raw[x] - ((left + up) >> 1);
        break;
      default:
        value = raw[x] - paeth(left, up, upLeft);
        break;
    }
    out[x] = value & 0xff;
  }
  return out;
}

export function buildPng(spec: PngSpec): Uint8Array<ArrayBuffer> {
  const channels = { 0: 1, 2: 3, 3: 1, 6: 4 }[spec.colorType];
  const stride = Math.ceil((spec.width * channels * spec.bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * spec.bitDepth) / 8));
  const filter = spec.filter ?? 0;

  const raw = new Uint8Array(spec.height * (stride + 1));
  for (let y = 0; y < spec.height; y++) {
    const row = spec.samples.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? spec.samples.subarray((y - 1) * stride, y * stride) : undefined;
    raw[y * (stride + 1)] = filter;
    raw.set(filterRow(row, previous, filter, bpp), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, spec.width);
  writeU32(ihdr, 4, spec.height);
  ihdr[8] = spec.bitDepth;
  ihdr[9] = spec.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
  ];
  if (spec.palette) parts.push(pngChunk("PLTE", spec.palette));
  if (spec.transparency) parts.push(pngChunk("tRNS", spec.transparency));
  parts.push(pngChunk("IDAT", zlibCompress(raw)));
  parts.push(pngChunk("IEND", new Uint8Array(0)));

  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 便捷：从 [[r,g,b,a], ...] 的二维数组造 RGBA8 PNG */
export function rgbaPng(
  width: number,
  height: number,
  pixels: readonly (readonly [number, number, number, number])[],
  filter: FilterType = 0
): Uint8Array<ArrayBuffer> {
  const samples = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = pixels[i];
    samples[i * 4] = r;
    samples[i * 4 + 1] = g;
    samples[i * 4 + 2] = b;
    samples[i * 4 + 3] = a;
  }
  return buildPng({ width, height, colorType: 6, bitDepth: 8, samples, filter });
}

/** 便捷：RGB8 PNG */
export function rgbPng(
  width: number,
  height: number,
  pixels: readonly (readonly [number, number, number])[],
  filter: FilterType = 0
): Uint8Array<ArrayBuffer> {
  const samples = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = pixels[i];
    samples[i * 3] = r;
    samples[i * 3 + 1] = g;
    samples[i * 3 + 2] = b;
  }
  return buildPng({ width, height, colorType: 2, bitDepth: 8, samples, filter });
}

export function pixelAt(rgba: Uint8Array, width: number, x: number, y = 0): number[] {
  const at = (y * width + x) * 4;
  return [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]];
}
