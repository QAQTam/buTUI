/**
 * `@butui/image` —— SPEC §12 图片子系统。
 *
 * 分层：
 *   capability  协议探测（SPEC §12.1 优先级）
 *   loader      安全加载（SPEC §12.3）
 *   png         最小 PNG → RGBA 解码
 *   scale       cell / 像素几何规划
 *   encode      Kitty / iTerm2 / Sixel / 半块 / 占位符编码
 *   render      管线：Bun.Image 解码缩放 → 编码
 *   layer       原生图形图层（渲染器钩子）
 *   component   `<Image>` + createImage
 */
export * from "./capability.ts";
export * from "./encode.ts";
export * from "./loader.ts";
export * from "./layer.ts";
export * from "./png.ts";
export * from "./png-encode.ts";
export * from "./render.ts";
export * from "./scale.ts";
export * from "./component.tsx";
