/**
 * 最小 PNG 解码器 —— 只为「把 Bun.Image 缩放后的小图变成 RGBA」而存在。
 *
 * 为什么不直接用 Bun.Image：它没有 raw pixel 出口（见 SPEC §5.6 第 12 条）。
 * 但它的**编码**出口是有的，于是管线变成：
 *
 *   Bun.Image（原生解码 + SIMD 缩放）→ .png() → 本解码器 → RGBA → 协议编码
 *
 * 这条路的解码器只需要处理小图（几十×几十），纯 TS 完全够用；而且因为
 * Bun 的 PNG 编码器只产出 8bit 非交错图，主路径其实只用到 colorType 6。
 * 其它分支（调色板 / 灰度 / 16bit / 低位深）是为了让用户直接喂 PNG 时也能跑，
 * 属于 SPEC §4.4 的渐进增强。
 *
 * 不支持：Adam7 交错（Bun 编码器不产出，遇到就明确报错而不是画花）。
 */
import { inflateSync } from "bun";

export class PngError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PngError";
    this.code = code;
  }
}

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA8，长度 = width * height * 4 */
  rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const VALID_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

interface Chunks {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  palette: Uint8Array | undefined;
  transparency: Uint8Array | undefined;
  idat: Uint8Array[];
}

function readChunks(bytes: Uint8Array): Chunks {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new PngError("ERR_PNG_SIGNATURE", "不是 PNG：签名不匹配");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let seenIhdr = false;

  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const dataStart = at + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new PngError("ERR_PNG_TRUNCATED", `PNG 截断：${type} 块声明 ${length} 字节但数据不足`);
    }
    const data = bytes.subarray(dataStart, dataEnd);

    switch (type) {
      case "IHDR": {
        if (length < 13) throw new PngError("ERR_PNG_IHDR", "IHDR 长度不足");
        width = u32(data, 0);
        height = u32(data, 4);
        bitDepth = data[8];
        colorType = data[9];
        const compression = data[10];
        const filter = data[11];
        interlace = data[12];
        seenIhdr = true;
        if (width === 0 || height === 0) throw new PngError("ERR_PNG_IHDR", "PNG 尺寸为 0");
        if (compression !== 0) throw new PngError("ERR_PNG_IHDR", `不支持的压缩方法 ${compression}`);
        if (filter !== 0) throw new PngError("ERR_PNG_IHDR", `不支持的滤波方法 ${filter}`);
        if (CHANNELS[colorType] === undefined) {
          throw new PngError("ERR_PNG_IHDR", `不支持的 colorType ${colorType}`);
        }
        if (!VALID_DEPTHS[colorType].includes(bitDepth)) {
          throw new PngError("ERR_PNG_IHDR", `colorType ${colorType} 不支持 bitDepth ${bitDepth}`);
        }
        break;
      }
      case "PLTE":
        palette = data.slice();
        break;
      case "tRNS":
        transparency = data.slice();
        break;
      case "IDAT":
        idat.push(data);
        break;
      case "IEND":
        at = bytes.length;
        continue;
      default:
        break;
    }
    at = dataEnd + 4;
  }

  if (!seenIhdr) throw new PngError("ERR_PNG_IHDR", "PNG 缺少 IHDR");
  if (idat.length === 0) throw new PngError("ERR_PNG_IDAT", "PNG 缺少 IDAT");
  if (interlace !== 0) {
    throw new PngError("ERR_PNG_INTERLACE", "Adam7 交错 PNG 暂不支持（先用 Bun.Image 重新编码）");
  }
  return { width, height, bitDepth, colorType, interlace, palette, transparency, idat };
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

/** 逐行反滤波，返回 height × stride 的原始样本字节 */
function unfilter(raw: Uint8Array, width: number, height: number, bitDepth: number, channels: number): Uint8Array {
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new PngError("ERR_PNG_TRUNCATED", `IDAT 解压后 ${raw.length} 字节，至少需要 ${expected}`);
  }

  const out = new Uint8Array(height * stride);
  let prevRow = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[prevRow + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prevRow + x - bpp] : 0;
      let recon: number;
      switch (filter) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + left;
          break;
        case 2:
          recon = value + up;
          break;
        case 3:
          recon = value + ((left + up) >> 1);
          break;
        case 4:
          recon = value + paeth(left, up, upLeft);
          break;
        default:
          throw new PngError("ERR_PNG_FILTER", `未知滤波类型 ${filter}`);
      }
      out[dst + x] = recon & 0xff;
    }
    prevRow = dst;
  }
  return out;
}

/**
 * 把一行原始样本拆成「每像素 channels 个 0-255 分量」。
 * 8bit 直接取字节；16bit 取高字节（终端显示不需要 16bit 精度）；
 * 低位深按位域解包并线性缩放到 0-255。
 */
/**
 * 把一行原始样本拆成「每像素 channels 个值」。
 *
 * 8bit 直接取字节；16bit 取高字节（终端显示不需要 16bit 精度）；低位深按位域
 * 解包。`normalize` 决定是否把低位深线性缩放到 0-255 —— 灰度需要，**调色板
 * 索引绝不能缩放**（索引 1 缩成 17 会直接画错颜色）。
 */
function sampleRow(
  raw: Uint8Array,
  rowStart: number,
  width: number,
  bitDepth: number,
  channels: number,
  out: Uint8Array,
  normalize: boolean
): void {
  if (bitDepth === 8) {
    for (let i = 0; i < width * channels; i++) out[i] = raw[rowStart + i];
    return;
  }
  if (bitDepth === 16) {
    for (let i = 0; i < width * channels; i++) out[i] = raw[rowStart + i * 2];
    return;
  }

  const mask = (1 << bitDepth) - 1;
  for (let i = 0; i < width * channels; i++) {
    const bitOffset = i * bitDepth;
    const byte = raw[rowStart + (bitOffset >> 3)];
    const shift = 8 - bitDepth - (bitOffset & 7);
    const value = (byte >> shift) & mask;
    out[i] = normalize ? Math.round((value * 255) / mask) : value;
  }
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const chunks = readChunks(bytes);
  const { width, height, bitDepth, colorType } = chunks;
  const channels = CHANNELS[colorType];

  const total = chunks.idat.reduce((n, part) => n + part.length, 0);
  const compressed = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks.idat) {
    compressed.set(part, offset);
    offset += part.length;
  }

  let raw: Uint8Array;
  try {
    // PNG 的 IDAT 按规范是 **zlib** 流（2 字节头 + deflate + adler32）。
    // 但 Bun.inflateSync 默认按 raw deflate 解（windowBits 默认 -15），所以
    // 这里必须显式要求 zlib 模式；顺便做头校验，兼容 raw deflate 输入。
    const zlibWrapped =
      compressed.length >= 2 &&
      (compressed[0] & 0x0f) === 8 &&
      ((compressed[0] << 8) | compressed[1]) % 31 === 0;
    raw = inflateSync(compressed, { windowBits: zlibWrapped ? 15 : -15 });
  } catch (error) {
    throw new PngError("ERR_PNG_INFLATE", `IDAT 解压失败：${(error as Error).message}`);
  }

  const samples = unfilter(raw, width, height, bitDepth, channels);
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const row = new Uint8Array(width * channels);
  const rgba = new Uint8Array(width * height * 4);

  const palette = chunks.palette;
  const transparency = chunks.transparency;
  // tRNS 对 colorType 0/2 表示「单一透明色」：灰度是 2 字节，RGB 是 6 字节，
  // 都是 16bit 大端样本；我们的样本已经缩到 8bit，所以取高字节比较。
  const transparentGray =
    colorType === 0 && transparency && transparency.length >= 2 ? transparency[0] : undefined;
  const transparentRgb =
    colorType === 2 && transparency && transparency.length >= 6
      ? [transparency[0], transparency[2], transparency[4]]
      : undefined;

  for (let y = 0; y < height; y++) {
    sampleRow(samples, y * stride, width, bitDepth, channels, row, colorType !== 3);
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const o = (y * width + x) * 4;
      switch (colorType) {
        case 0: {
          const g = row[s];
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = transparentGray !== undefined && g === transparentGray ? 0 : 255;
          break;
        }
        case 2: {
          rgba[o] = row[s];
          rgba[o + 1] = row[s + 1];
          rgba[o + 2] = row[s + 2];
          rgba[o + 3] =
            transparentRgb !== undefined &&
            row[s] === transparentRgb[0] &&
            row[s + 1] === transparentRgb[1] &&
            row[s + 2] === transparentRgb[2]
              ? 0
              : 255;
          break;
        }
        case 3: {
          const index = row[s];
          if (!palette || index * 3 + 2 >= palette.length) {
            throw new PngError("ERR_PNG_PALETTE", `调色板索引 ${index} 越界`);
          }
          rgba[o] = palette[index * 3];
          rgba[o + 1] = palette[index * 3 + 1];
          rgba[o + 2] = palette[index * 3 + 2];
          rgba[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
          break;
        }
        case 4: {
          const g = row[s];
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = row[s + 1];
          break;
        }
        default: {
          rgba[o] = row[s];
          rgba[o + 1] = row[s + 1];
          rgba[o + 2] = row[s + 2];
          rgba[o + 3] = row[s + 3];
          break;
        }
      }
    }
  }

  return { width, height, rgba };
}
