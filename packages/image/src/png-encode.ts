/**
 * 最小 PNG **编码器** —— 让 buTUI 能凭空造图。
 *
 * 为什么图片子系统需要它：
 *   - 程序化生成的图（图表、二维码、diff 缩略图）不需要外部文件
 *   - 测试可以精确构造像素，逐点验证解码与半块渲染
 *   - 不需要为了「画一张图」去依赖 canvas / sharp
 *
 * 只用 RGBA8（colorType 6）+ 可选的 5 种滤波。刻意不支持调色板 / 16bit：
 * 那是解码器的兼容面，不是编码器的目标。
 *
 * 注意 zlib 包装是自己拼的：`Bun.deflateSync` 在 1.4.x 里忽略 `windowBits`，
 * 永远输出 raw deflate，而 PNG 的 IDAT 要求 zlib 流（见 SPEC §5.6）。
 */
import { deflateSync } from "bun";

export type PngFilter = 0 | 1 | 2 | 3 | 4;

export interface EncodePngOptions {
  width: number;
  height: number;
  /** RGBA8，长度必须是 width*height*4 */
  rgba: Uint8Array;
  /** 每行的滤波类型，默认 1（Sub，对渐变/截图压缩率好） */
  filter?: PngFilter;
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

/** Adler-32（zlib 的尾部校验） */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a += data[i];
    b += a;
    if ((i & 0xfff) === 0xfff) {
      a %= 65521;
      b %= 65521;
    }
  }
  a %= 65521;
  b %= 65521;
  return ((b << 16) | a) >>> 0;
}

/** raw deflate → zlib 流（PNG IDAT 要的格式） */
export function zlibCompress(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const deflated = deflateSync(new Uint8Array(source));
  const out = new Uint8Array(deflated.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(deflated, 2);
  const adler = adler32(source);
  out[out.length - 4] = (adler >>> 24) & 0xff;
  out[out.length - 3] = (adler >>> 16) & 0xff;
  out[out.length - 2] = (adler >>> 8) & 0xff;
  out[out.length - 1] = adler & 0xff;
  return out;
}

/** 拼一个 PNG 块：长度 + 类型 + 数据 + CRC32 */
export function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const length = data.length;
  out[0] = (length >>> 24) & 0xff;
  out[1] = (length >>> 16) & 0xff;
  out[2] = (length >>> 8) & 0xff;
  out[3] = length & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0;
  out[8 + data.length] = (crc >>> 24) & 0xff;
  out[9 + data.length] = (crc >>> 16) & 0xff;
  out[10 + data.length] = (crc >>> 8) & 0xff;
  out[11 + data.length] = crc & 0xff;
  return out;
}

/** 正向滤波：把一行样本变成 PNG 里的存储形式 */
export function filterRow(
  raw: Uint8Array,
  previous: Uint8Array | undefined,
  filter: PngFilter,
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

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function encodePng(options: EncodePngOptions): Uint8Array<ArrayBuffer> {
  const { width, height, rgba } = options;
  const filter = options.filter ?? 1;
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodePng: rgba 长度应为 ${expected}，实际 ${rgba.length}`);
  }

  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : undefined;
    raw[y * (stride + 1)] = filter;
    raw.set(filterRow(row, previous, filter, 4), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff;
  ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff;
  ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff;
  ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff;
  ihdr[7] = height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colorType RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibCompress(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
