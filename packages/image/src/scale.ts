/**
 * 「图片 → cell 网格」的几何规划。
 *
 * 终端单元格不是正方形：典型字体下宽高比 ≈ 1:2。所有尺寸换算都按
 * `CELL_ASPECT = 2`（一个 cell 高 = 两个 cell 宽）折算成「正方形像素」再算
 * 比例，否则同一张图在 contain / cover 下会被拉长一倍。
 *
 * 这里只做**纯几何**：算出目标像素尺寸、占位 box 和绘制偏移。真正的重采样
 * 交给 Bun.Image（SIMD 内核），TS 侧最多做一次中心裁剪 —— 保持 SPEC §5.1
 * 「重活交给 Bun 主线 API」的边界。
 */
export type ImageFit = "contain" | "cover" | "fill";

/** 一个终端 cell 的高宽比（像素单位） */
export const CELL_ASPECT = 2;

export interface ImageLayoutPlan {
  /** 节点在布局里占的 cell 尺寸 */
  boxCols: number;
  boxRows: number;
  /** 实际画出来的 cell 尺寸（contain 时会小于 box） */
  drawCols: number;
  drawRows: number;
  /** 绘制区在 box 内的偏移（居中） */
  left: number;
  top: number;
  /** 送给 Bun.Image 的目标像素尺寸 */
  pixelWidth: number;
  pixelHeight: number;
  /** cover 需要从重采样结果里中心裁剪出的矩形 */
  crop?: { x: number; y: number; width: number; height: number };
}

export interface ImageLayoutInput {
  srcWidth: number;
  srcHeight: number;
  boxCols: number;
  boxRows: number;
  fit: ImageFit;
}

export function planImageLayout(input: ImageLayoutInput): ImageLayoutPlan {
  const srcWidth = Math.max(1, input.srcWidth);
  const srcHeight = Math.max(1, input.srcHeight);
  const boxCols = Math.max(1, Math.round(input.boxCols));
  const boxRows = Math.max(1, Math.round(input.boxRows));

  // box 在「正方形像素」空间里的尺寸
  const boxPixelWidth = boxCols;
  const boxPixelHeight = boxRows * CELL_ASPECT;

  if (input.fit === "fill") {
    return {
      boxCols,
      boxRows,
      drawCols: boxCols,
      drawRows: boxRows,
      left: 0,
      top: 0,
      pixelWidth: boxPixelWidth,
      pixelHeight: boxPixelHeight,
    };
  }

  if (input.fit === "cover") {
    // 放大到「盖住」box，再把溢出的部分中心裁掉
    const scale = Math.max(boxPixelWidth / srcWidth, boxPixelHeight / srcHeight);
    const pixelWidth = Math.max(1, Math.round(srcWidth * scale));
    const pixelHeight = Math.max(1, Math.round(srcHeight * scale));
    const width = Math.min(boxPixelWidth, pixelWidth);
    const height = Math.min(boxPixelHeight, pixelHeight);
    return {
      boxCols,
      boxRows,
      drawCols: boxCols,
      drawRows: boxRows,
      left: 0,
      top: 0,
      pixelWidth,
      pixelHeight,
      crop: {
        x: Math.floor((pixelWidth - width) / 2),
        y: Math.floor((pixelHeight - height) / 2),
        width,
        height,
      },
    };
  }

  // contain：等比缩到 box 内，然后居中
  const scale = Math.min(boxPixelWidth / srcWidth, boxPixelHeight / srcHeight);
  const pixelWidth = Math.max(1, Math.round(srcWidth * scale));
  const pixelHeight = Math.max(1, Math.round(srcHeight * scale));
  const drawCols = Math.max(1, Math.min(boxCols, Math.ceil(pixelWidth / 1)));
  const drawRows = Math.max(1, Math.min(boxRows, Math.ceil(pixelHeight / CELL_ASPECT)));
  return {
    boxCols,
    boxRows,
    drawCols,
    drawRows,
    left: Math.max(0, Math.floor((boxCols - drawCols) / 2)),
    top: Math.max(0, Math.floor((boxRows - drawRows) / 2)),
    pixelWidth,
    pixelHeight,
  };
}

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export function cropRgba(image: Rgba, rect: { x: number; y: number; width: number; height: number }): Rgba {
  const x = Math.max(0, Math.min(image.width - 1, rect.x));
  const y = Math.max(0, Math.min(image.height - 1, rect.y));
  const width = Math.max(1, Math.min(image.width - x, rect.width));
  const height = Math.max(1, Math.min(image.height - y, rect.height));
  if (x === 0 && y === 0 && width === image.width && height === image.height) return image;

  const data = new Uint8Array(width * height * 4);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(from, from + rowBytes), row * rowBytes);
  }
  return { width, height, data };
}
