/**
 * Artifact 的图片渲染器 —— 把 `@butui/image` 接到 `ArtifactCanvas` 上。
 *
 * 为什么是「注入」而不是 `@butui/agent` 直接依赖 `@butui/image`：
 * 图片解码要用 Bun 内建（`bun` 的 `inflateSync`）和 `Bun.Image`，而同一份
 * agent 组件树还要能进 WebUI 的 **browser** 打包 —— 静态依赖会让
 * `Bun.build({ target: "browser" })` 直接报「Browser build cannot import Bun
 * builtin」。所以 TUI 侧显式注入，WebUI 侧注入 `<img>`，模型层保持干净。
 */
import { Image, type ImageLayer, type ImagePolicy, type ImageResource, createImage } from "./index.ts";

export interface ArtifactImageRendererOptions {
  layer?: ImageLayer;
  policy?: ImagePolicy;
  /** 占位宽度（cell），默认 40 */
  width?: number;
  /** 图片异步加载完成时回调（用来 schedulePaint） */
  onUpdate?: () => void;
}

/**
 * 返回一个 `(source, alt) => JSX` 的渲染器，直接传给
 * `<ArtifactCanvas renderers={{ image: artifactImageRenderer({ layer }) }} />`。
 */
export function artifactImageRenderer(
  options: ArtifactImageRendererOptions = {}
): (source: string, alt: string) => unknown {
  const width = options.width ?? 40;

  // 渲染器必须是**组件**：createImage 内部要建 effect，需要响应式 owner
  function ImageArtifact(props: { source: string; alt: string }) {
    const resource: ImageResource = createImage(() => props.source, {
      layer: options.layer,
      policy: options.policy,
      cols: width,
      alt: props.alt,
      onUpdate: options.onUpdate,
    });
    return <Image source={resource} width={width} alt={props.alt} />;
  }

  return (source: string, alt: string) => <ImageArtifact source={source} alt={alt} />;
}
