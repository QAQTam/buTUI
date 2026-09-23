/**
 * 图片渲染管线 —— 把「一张图的字节」变成「buTUI 能画的东西」。
 *
 * 关键边界（SPEC §5.1「最大化利用 Bun 主线 API」）：
 *   - 解码、重采样、编码 **全部** 交给 `Bun.Image`（libspng / libwebp / SIMD 内核）
 *   - TS 侧只做三件小事：读元数据、PNG → RGBA 解析、转义序列编码
 *
 * 于是「打开一张 24MP 照片画成 40×12 个字符」的成本是：Bun 在解码阶段就按
 * 1/8 IDCT 出小图（官方文档：目标 ≤ 源尺寸一半时跳过全尺寸缓冲），我们拿到
 * 的 PNG 只有几十 KB。TS 侧从不接触全分辨率像素。
 *
 * 两条渲染路径：
 *   - 原生协议（kitty / iterm2 / sixel）→ 占位 cell + `ImageLayer` 叠加图形
 *   - cell 协议（halfblock / placeholder）→ 直接产出 ANSI 行，走普通布局
 */
import type { ColorDepth } from "@butui/core";
import { type ImageEnv, type ImageProtocol, isNativeProtocol, pickProtocol } from "./capability.ts";
import {
  type RGB,
  BLACK,
  halfblockLines,
  iterm2Sequence,
  kittySequence,
  placeholderLines,
  sixelSequence,
} from "./encode.ts";
import { type ImageFit, type Rgba, cropRgba, planImageLayout } from "./scale.ts";
import { decodePng } from "./png.ts";
import { type ImagePolicy, loadImageBytes } from "./loader.ts";

/** 一个终端 cell 大致对应的像素尺寸（用于原生协议的编码分辨率） */
export const CELL_PIXEL_WIDTH = 8;
export const CELL_PIXEL_HEIGHT = 16;
/**
 * `planImageLayout` 的像素空间是「1 个 cell 宽 = 1 像素、1 个 cell 高 = 2 像素」
 * （见 CELL_ASPECT）。要换算成真实像素，两个方向都乘 8：
 * 宽 8px/cell，高 2×8 = 16px/cell。
 */
const NATIVE_SCALE = CELL_PIXEL_WIDTH;

export interface RenderImageOptions {
  protocol?: ImageProtocol;
  depth?: ColorDepth;
  /** 占位宽度（cell）；默认 40 */
  cols?: number;
  /** 占位高度（cell）；默认按源图比例算 */
  rows?: number;
  fit?: ImageFit;
  alt?: string;
  background?: RGB;
  maxPixels?: number;
  /**
   * 原生协议是否把 PNG 量化成 256 色调色板（SPEC §12.1 的体积/质量权衡）。
   * 默认关；远程 attach、低带宽、大图时打开。
   */
  quantize?: boolean;
  env?: ImageEnv;
}

export interface RenderedImage {
  protocol: ImageProtocol;
  /** 节点在布局里占的 cell 尺寸 */
  cols: number;
  rows: number;
  /** 实际绘制区相对节点左上角的偏移（contain 居中） */
  rect: { left: number; top: number; cols: number; rows: number };
  /** cell 协议：每行一个 ANSI 字符串（行内 SGR 已经烤好） */
  lines?: string[];
  /** 原生协议：交给 ImageLayer 放置的图形 */
  graphic?: { id: string; sequence: string; id32: number };
  source: { width: number; height: number; format: string; bytes: number };
  /** 降级原因（协议不可用 / 解码失败时给 UI 看） */
  fallback?: string;
}

export function graphicId(protocol: ImageProtocol, cols: number, rows: number, payload: Uint8Array): string {
  return `${protocol}:${cols}x${rows}:${payload.byteLength}:${Bun.hash.crc32(
    payload.subarray(0, Math.min(4096, payload.byteLength))
  ).toString(36)}`;
}

async function resizeTo(
  bytes: Uint8Array,
  width: number,
  height: number,
  maxPixels: number,
  compressionLevel: number,
  quantize = false
): Promise<Uint8Array> {
  return new Bun.Image(bytes, { maxPixels })
    .resize(width, height, { fit: "fill", filter: "lanczos3" })
    // 量化成 256 色调色板 PNG 通常能把负载压到 1/3 左右，而终端上根本看不出
    // 差别（一个 cell 只有 8×16 像素）。远程 attach 场景值得打开。
    .png(quantize ? { compressionLevel, palette: true, colors: 256 } : { compressionLevel })
    .bytes();
}

/**
 * 核心入口：字节 → 可渲染结果。
 *
 * 失败时（协议不可用、解码失败）**不抛异常**，而是降级成占位符 —— 图片画
 * 不出来不应该让整个 TUI 挂掉（SPEC §4.4）。
 */
export async function renderImage(
  bytes: Uint8Array,
  options: RenderImageOptions = {}
): Promise<RenderedImage> {
  const depth = options.depth ?? "truecolor";
  const protocol = options.protocol ?? pickProtocol({ depth, env: options.env });
  const maxPixels = options.maxPixels ?? 4096 * 4096;
  const fit: ImageFit = options.fit ?? "contain";
  const alt = options.alt ?? "";
  const background = options.background ?? BLACK;

  let source: RenderedImage["source"];
  try {
    const meta = await new Bun.Image(bytes, { maxPixels }).metadata();
    source = { width: meta.width, height: meta.height, format: meta.format, bytes: bytes.byteLength };
  } catch (error) {
    // 连元数据都读不出来：给一个固定尺寸的占位符，并把原因带出去
    const cols = Math.max(4, options.cols ?? 40);
    const rows = Math.max(3, options.rows ?? 6);
    return {
      protocol: "placeholder",
      cols,
      rows,
      rect: { left: 0, top: 0, cols, rows },
      lines: placeholderLines({ cols, rows, text: alt || "image" }),
      source: { width: 0, height: 0, format: "unknown", bytes: bytes.byteLength },
      fallback: (error as Error).message,
    };
  }

  // ── 几何：先定 cell 占位，再定像素分辨率 ────────────────────────────────
  const boxCols = Math.max(1, Math.round(options.cols ?? 40));
  const boxRows =
    options.rows !== undefined
      ? Math.max(1, Math.round(options.rows))
      : Math.max(1, Math.round((source.height * boxCols) / source.width / 2));

  const plan = planImageLayout({
    srcWidth: source.width,
    srcHeight: source.height,
    boxCols,
    boxRows,
    fit,
  });

  const rect = {
    left: plan.left,
    top: plan.top,
    cols: plan.drawCols,
    rows: plan.drawRows,
  };

  if (protocol === "placeholder" || protocol === "none") {
    return {
      protocol: "placeholder",
      cols: boxCols,
      rows: boxRows,
      rect: { left: 0, top: 0, cols: boxCols, rows: boxRows },
      lines: placeholderLines({ cols: boxCols, rows: boxRows, text: alt || source.format }),
      source,
    };
  }

  if (isNativeProtocol(protocol)) {
    // 原生协议的分辨率：cell → 真实像素（8×16），否则 40 个字符宽的图只有 40px
    const pixelWidth = Math.max(1, plan.pixelWidth * NATIVE_SCALE);
    const pixelHeight = Math.max(1, plan.pixelHeight * NATIVE_SCALE);
    try {
      const png = await resizeTo(bytes, pixelWidth, pixelHeight, maxPixels, 9, options.quantize);
      const id = graphicId(protocol, plan.drawCols, plan.drawRows, png);
      const id32 = Bun.hash.crc32(id);
      let sequence: string;
      if (protocol === "kitty") {
        sequence = kittySequence(png, { cols: plan.drawCols, rows: plan.drawRows, id: id32 });
      } else if (protocol === "iterm2") {
        sequence = iterm2Sequence(png, {
          cols: plan.drawCols,
          rows: plan.drawRows,
          name: alt || "image.png",
        });
      } else {
        const decoded = decodePng(png);
        sequence = sixelSequence(decoded.rgba, decoded.width, decoded.height, { background });
      }
      return {
        protocol,
        cols: boxCols,
        rows: boxRows,
        rect,
        graphic: { id, sequence, id32 },
        source,
      };
    } catch (error) {
      const reason = (error as Error).message;
      return {
        protocol: "placeholder",
        cols: boxCols,
        rows: boxRows,
        rect: { left: 0, top: 0, cols: boxCols, rows: boxRows },
        lines: placeholderLines({ cols: boxCols, rows: boxRows, text: alt || source.format }),
        source,
        fallback: reason,
      };
    }
  }

  // ── cell 协议：half-block ────────────────────────────────────────────────
  try {
    const pixelWidth = Math.max(1, plan.pixelWidth);
    const pixelHeight = Math.max(2, plan.pixelHeight);
    const png = await resizeTo(bytes, pixelWidth, pixelHeight, maxPixels, 6);
    const raw = decodePng(png);
    let decoded: Rgba = { width: raw.width, height: raw.height, data: raw.rgba };
    if (plan.crop) decoded = cropRgba(decoded, plan.crop);
    const lines = halfblockLines(decoded.data, decoded.width, decoded.height, {
      depth,
      background,
      transparent: true,
    });
    return { protocol: "halfblock", cols: boxCols, rows: boxRows, rect, lines, source };
  } catch (error) {
    return {
      protocol: "placeholder",
      cols: boxCols,
      rows: boxRows,
      rect: { left: 0, top: 0, cols: boxCols, rows: boxRows },
      lines: placeholderLines({ cols: boxCols, rows: boxRows, text: alt || source.format }),
      source,
      fallback: (error as Error).message,
    };
  }
}

/** 一步到位：安全加载 + 渲染 */
export async function renderImageFrom(
  source: string | Uint8Array,
  options: RenderImageOptions & { policy?: ImagePolicy } = {}
): Promise<RenderedImage> {
  const loaded = await loadImageBytes(source, options.policy ?? {});
  return renderImage(loaded.bytes, options);
}
