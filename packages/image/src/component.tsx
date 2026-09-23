/**
 * `<Image>` 组件与 `createImage` 资源 —— SPEC §12.2。
 *
 * 组件本身不做任何像素工作，只做三件事：
 *   1. 把异步加载状态映射成 `<image>` 节点的属性
 *   2. 加载中 / 失败时退化成纯文本占位符（绝不抛异常炸掉整个 UI）
 *   3. 原生协议时把图形序列注册进 `ImageLayer`
 *
 * 数据流与 `<stream>` 完全一致：Solid 侧一次 setProp → 布局侧按 (rev, width)
 * 缓存 → 渲染器差分。图片因此天然支持「滚动、resize、流式输出共存」。
 */
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { type ImageProtocol, isNativeProtocol } from "./capability.ts";
import { placeholderLines } from "./encode.ts";
import type { ImageLayer } from "./layer.ts";
import type { ImagePolicy } from "./loader.ts";
import { type RenderImageOptions, type RenderedImage, renderImageFrom } from "./render.ts";

export type ImageState =
  | { status: "loading" }
  | { status: "ready"; image: RenderedImage }
  | { status: "error"; error: Error };

export interface ImageResource {
  (): ImageState;
  /** 强制重新加载（文件变了、用户点了刷新） */
  refresh(): void;
}

export interface CreateImageOptions extends RenderImageOptions {
  policy?: ImagePolicy;
  /** 原生协议的图形图层；不给就退化成 cell 渲染 */
  layer?: ImageLayer;
  /** 状态变化回调（用来 schedulePaint） */
  onUpdate?: () => void;
}

export function createImage(
  source: () => string | Uint8Array,
  options: CreateImageOptions = {}
): ImageResource {
  const [state, setState] = createSignal<ImageState>({ status: "loading" });
  let token = 0;
  let disposed = false;

  const load = async (src: string | Uint8Array): Promise<void> => {
    const current = ++token;
    try {
      const image = await renderImageFrom(src, options);
      if (disposed || current !== token) return;
      if (image.graphic && options.layer) {
        options.layer.register(image.graphic.id, {
          protocol: image.protocol as ImageProtocol,
          sequence: image.graphic.sequence,
          id32: image.graphic.id32,
        });
      }
      setState({ status: "ready", image });
    } catch (error) {
      if (disposed || current !== token) return;
      setState({ status: "error", error: error as Error });
    }
    options.onUpdate?.();
  };

  const refresh = (): void => {
    void load(source());
  };

  // SPEC §5.6 第 5 条：Solid 2 RC 的 createEffect 需要两个参数（compute + effect）
  createEffect(
    () => source(),
    () => refresh()
  );

  onCleanup(() => {
    disposed = true;
  });

  return Object.assign(() => state(), { refresh });
}

export interface ImageProps {
  source: ImageResource;
  /** 占位宽度（cell） */
  width?: number;
  /** 占位高度（cell） */
  height?: number;
  alt?: string;
  semantic?: string;
}

export function Image(props: ImageProps) {
  const current = () => props.source();

  // 占位符要**引用稳定**：Solid 的 setProp 用 Object.is 比较，每次新建数组
  // 会让节点每帧都变脏。createMemo 保证只有 cols/rows/alt 真的变了才换引用。
  const fallback = createMemo(() => {
    const cols = Math.max(4, Math.round(props.width ?? 40));
    const rows = Math.max(3, Math.round(props.height ?? 6));
    const state = current();
    const text =
      state.status === "error" ? `${props.alt ?? "image"}（加载失败）` : props.alt ?? "image";
    return { cols, rows, lines: placeholderLines({ cols, rows, text }) };
  });

  /**
   * 节点的最终属性。三种状态收敛成一个形状：
   *   - 就绪 + 原生协议 → 只有 graphic + rect（占位 cell 由布局补空白）
   *   - 就绪 + cell 协议 → 只有 lines
   *   - 加载中 / 失败     → 纯文本占位符
   */
  const node = createMemo(() => {
    const state = current();
    if (state.status === "ready") {
      const image = state.image;
      if (image.graphic) {
        return {
          lines: undefined as string[] | undefined,
          graphic: image.graphic.id as string | undefined,
          rect: image.rect as RenderedImage["rect"] | undefined,
          cols: image.cols,
          rows: image.rows,
        };
      }
      return {
        lines: image.lines,
        graphic: undefined,
        rect: undefined,
        cols: image.cols,
        rows: image.rows,
      };
    }
    const placeholder = fallback();
    return {
      lines: placeholder.lines as string[] | undefined,
      graphic: undefined,
      rect: undefined,
      cols: placeholder.cols,
      rows: placeholder.rows,
    };
  });

  return (
    <image
      lines={node().lines}
      graphic={node().graphic}
      rect={node().rect}
      cols={node().cols}
      rows={node().rows}
      semantic={props.semantic}
    />
  );
}

/**
 * 协议可用性检查：给 UI 用（比如「当前终端画不了图，是否用占位符」）。
 * 真正的协议选择在 `pickProtocol` 里，这里只是把结果翻译成人话。
 */
export function describeProtocol(protocol: ImageProtocol): string {
  switch (protocol) {
    case "kitty":
      return "Kitty graphics";
    case "iterm2":
      return "iTerm2 inline image";
    case "sixel":
      return "Sixel";
    case "halfblock":
      return "Unicode 半块";
    case "placeholder":
      return "纯文本占位符";
    default:
      return "无";
  }
}

export { isNativeProtocol };
