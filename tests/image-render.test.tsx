import { describe, expect, test } from "bun:test";
import {
  type ImageResource,
  ImageLayer,
  Image,
  decodePng,
  kittyDelete,
  renderImage,
  renderImageFrom,
} from "@butui/image";
import { Renderer } from "@butui/renderer";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";
import { rgbaPng } from "./helpers/png.ts";

const gradient = (width: number, height: number): Uint8Array => {
  const pixels: [number, number, number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.push([(x * 255) / width, (y * 255) / height, 128, 255].map(Math.round) as never);
    }
  }
  return rgbaPng(width, height, pixels);
};

const ready = (image: Awaited<ReturnType<typeof renderImage>>): ImageResource =>
  Object.assign(() => ({ status: "ready", image }) as const, { refresh: () => {} });

describe("图片渲染管线（SPEC §12.2）", () => {
  test("Kitty：占位 box + 可放置的图形序列", async () => {
    const out = await renderImage(gradient(8, 4), { protocol: "kitty", cols: 4 });
    expect(out.protocol).toBe("kitty");
    expect(out.cols).toBe(4);
    expect(out.rows).toBe(1);
    expect(out.rect).toEqual({ left: 0, top: 0, cols: 4, rows: 1 });
    expect(out.lines).toBeUndefined();
    expect(out.graphic?.sequence).toContain("\x1b_G");
    expect(out.graphic?.sequence).toContain("f=100");
    expect(out.source.width).toBe(8);
  });

  test("iTerm2 / Sixel 走同一条原生路径，但序列不同", async () => {
    const png = gradient(4, 4);
    const iterm = await renderImage(png, { protocol: "iterm2", cols: 4 });
    expect(iterm.graphic?.sequence.startsWith("\x1b]1337;File=")).toBe(true);

    const sixel = await renderImage(png, { protocol: "sixel", cols: 4 });
    expect(sixel.graphic?.sequence.startsWith('\x1bPq"')).toBe(true);
    expect(sixel.graphic?.sequence.endsWith("\x1b\\")).toBe(true);
  });

  test("half-block：产出 ANSI 行，进普通 cell 布局", async () => {
    const out = await renderImage(gradient(4, 4), { protocol: "halfblock", cols: 4, depth: "truecolor" });
    expect(out.protocol).toBe("halfblock");
    expect(out.graphic).toBeUndefined();
    expect(out.lines?.length).toBe(2);
    expect(out.lines?.[0]).toContain("▀");
    expect(out.lines?.[0]).toContain("\x1b[38;2;");
  });

  test("contain：宽图在 box 内垂直居中", async () => {
    // 源 8x4（2:1），box 4x3 → 像素 box 4x6，contain 后画 4x1，顶部留 1 行
    const out = await renderImage(gradient(8, 4), {
      protocol: "halfblock",
      cols: 4,
      rows: 3,
      fit: "contain",
    });
    expect(out.rows).toBe(3);
    expect(out.rect).toEqual({ left: 0, top: 1, cols: 4, rows: 1 });
  });

  test("fill：铺满整个 box", async () => {
    const out = await renderImage(gradient(8, 4), {
      protocol: "halfblock",
      cols: 4,
      rows: 3,
      fit: "fill",
    });
    expect(out.rect).toEqual({ left: 0, top: 0, cols: 4, rows: 3 });
    expect(out.lines?.length).toBe(3);
  });

  test("cover：画满 box（裁剪多余部分）", async () => {
    // 源 4x4（1:1），box 4x1 → 像素 box 4x2；cover 需要放大到 4x4 再裁掉中间 4x2
    const out = await renderImage(gradient(4, 4), {
      protocol: "halfblock",
      cols: 4,
      rows: 1,
      fit: "cover",
    });
    expect(out.rect).toEqual({ left: 0, top: 0, cols: 4, rows: 1 });
    expect(out.lines?.length).toBe(1);
  });

  test("placeholder 协议永远画得出东西（NO_COLOR 兜底）", async () => {
    const out = await renderImage(gradient(4, 4), { protocol: "placeholder", cols: 10, rows: 4, alt: "chart" });
    expect(out.protocol).toBe("placeholder");
    expect(out.lines?.length).toBe(4);
    expect(out.lines?.join("\n")).toContain("chart");
    for (const line of out.lines!) expect(Bun.stringWidth(line)).toBe(10);
  });

  test("坏字节不抛异常，降级成占位符并带上原因", async () => {
    const out = await renderImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { cols: 12, rows: 4 });
    expect(out.protocol).toBe("placeholder");
    expect(out.fallback).toBeTruthy();
    expect(out.source.format).toBe("unknown");
    expect(out.lines?.length).toBe(4);
  });

  test("renderImageFrom 串起安全加载与渲染", async () => {
    const png = gradient(4, 4);
    const out = await renderImageFrom(png, { protocol: "halfblock", cols: 4 });
    expect(out.protocol).toBe("halfblock");
  });

  test("quantize：照片类内容能明显减小原生协议负载", async () => {
    // 确定性伪随机噪点 —— 模拟照片/截图的高频内容（平滑渐变反而压不动）
    let seed = 12345;
    const pixels: [number, number, number, number][] = [];
    for (let i = 0; i < 64 * 32; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      pixels.push([seed & 0xff, (seed >> 8) & 0xff, (seed >> 16) & 0xff, 255]);
    }
    const png = rgbaPng(64, 32, pixels);

    const plain = await renderImage(png, { protocol: "kitty", cols: 40 });
    const quantized = await renderImage(png, { protocol: "kitty", cols: 40, quantize: true });
    expect(quantized.graphic!.sequence.length).toBeLessThan(plain.graphic!.sequence.length);

    // 量化后仍然是合法 PNG，且像素尺寸不变（大图会分块，要拼回全部 base64）
    const payload = quantized.graphic!.sequence;
    const base64 = [...payload.matchAll(/\x1b_G[^;]*;([\s\S]*?)\x1b\\/g)].map(m => m[1]).join("");
    const decoded = decodePng(new Uint8Array(Buffer.from(base64, "base64")));
    expect(decoded.width).toBe(quantized.rect.cols * 8);
    expect(decoded.height).toBe(quantized.rect.rows * 16);
  });
});

describe("<Image> 组件 + ImageLayer（SPEC §12.2 / §6 分层）", () => {
  test("half-block 图进入 cell 网格", async () => {
    const image = await renderImage(gradient(4, 4), { protocol: "halfblock", cols: 4 });
    const app = mount(() => <Image source={ready(image)} width={4} />, { width: 20, height: 3 });
    expect(app.text()).toContain("▀");
    app.unmount();
  });

  test("加载中显示占位符，加载完成后换成图片", async () => {
    const image = await renderImage(gradient(4, 4), { protocol: "halfblock", cols: 6 });
    // 用真实 signal 驱动：组件的反应性靠 Solid 的追踪，不是靠轮询
    const [state, setState] = createSignal<{ status: "loading" } | { status: "ready"; image: typeof image }>({
      status: "loading",
    });
    const resource: ImageResource = Object.assign(() => state(), { refresh: () => {} });

    const app = mount(() => <Image source={resource} width={10} height={3} alt="shot" />, {
      width: 20,
      height: 4,
    });
    expect(app.text()).toContain("shot");
    expect(app.text()).toContain("┌");

    setState({ status: "ready", image });
    app.flush();
    expect(app.text()).toContain("▀");
    expect(app.text()).not.toContain("┌");
    app.unmount();
  });

  test("原生协议：占位 cell 打上 graphic 标记，且尺寸等于 box", async () => {
    const image = await renderImage(gradient(8, 4), { protocol: "kitty", cols: 4 });
    const app = mount(
      () => (
        <column>
          <text>header</text>
          <Image source={ready(image)} width={4} />
        </column>
      ),
      { width: 20, height: 4 }
    );

    const frame = app.frame();
    const marked: { x: number; y: number }[] = [];
    frame.lines.forEach((line, y) =>
      line.forEach((cell, x) => {
        if (cell.graphic) marked.push({ x, y });
      })
    );
    expect(marked.length).toBe(4); // 4 列 × 1 行
    expect(marked.every(m => m.y === 1)).toBe(true);
    // 占位 cell 是空白 —— 图形由终端画上去
    const placeholderLine = frame.lines[1];
    expect(placeholderLine.slice(0, 4).every(cell => cell.ch === " ")).toBe(true);
    expect(placeholderLine.slice(4, 8).every(cell => cell.ch === " ")).toBe(true);
    app.unmount();
  });

  test("ImageLayer：定位、去重、重绘与删除", async () => {
    const image = await renderImage(gradient(8, 4), { protocol: "kitty", cols: 4 });
    const app = mount(
      () => (
        <column>
          <text>header</text>
          <Image source={ready(image)} width={4} />
        </column>
      ),
      { width: 20, height: 4 }
    );

    const layer = new ImageLayer();
    layer.register(image.graphic!.id, {
      protocol: "kitty",
      sequence: image.graphic!.sequence,
      id32: image.graphic!.id32,
    });

    const frame = app.frame();
    const first = layer.render(frame, [0, 1, 2, 3]);
    // 第 2 行（0-based 1）第 1 列
    expect(first).toContain("\x1b[2;1H");
    expect(first).toContain(image.graphic!.sequence);
    expect(first.startsWith(kittyDelete(image.graphic!.id32))).toBe(true);

    // 没有任何行被重绘 → 不再重发几十 KB 的 base64
    expect(layer.render(frame, [])).toBe("");

    // 图片所在行被重绘 → 必须重放（文字重绘会把图擦掉）
    expect(layer.render(frame, [1])).toContain(image.graphic!.sequence);
    app.unmount();
  });

  test("ImageLayer：图片离开视口后 Kitty 精确删除", async () => {
    const image = await renderImage(gradient(8, 4), { protocol: "kitty", cols: 4 });
    const withImage = mount(() => <Image source={ready(image)} width={4} />, { width: 10, height: 2 });
    const layer = new ImageLayer();
    layer.register(image.graphic!.id, {
      protocol: "kitty",
      sequence: image.graphic!.sequence,
      id32: image.graphic!.id32,
    });
    layer.render(withImage.frame(), [0]);
    withImage.unmount();

    const without = mount(() => <text>gone</text>, { width: 10, height: 2 });
    const out = layer.render(without.frame(), [0]);
    expect(out).toBe(kittyDelete(image.graphic!.id32));
    without.unmount();
  });

  test("渲染器钩子：图形序列排在文字差分之后", async () => {
    const image = await renderImage(gradient(8, 4), { protocol: "kitty", cols: 4 });
    const layer = new ImageLayer();
    layer.register(image.graphic!.id, {
      protocol: "kitty",
      sequence: image.graphic!.sequence,
      id32: image.graphic!.id32,
    });

    let output = "";
    const renderer = new Renderer(chunk => {
      output += chunk;
    }, {
      afterDraw: (frame, stats) => layer.render(frame, stats.changed),
    });

    const app = mount(
      () => (
        <column>
          <text>header</text>
          <Image source={ready(image)} width={4} />
        </column>
      ),
      { width: 20, height: 4 }
    );

    const stats = renderer.draw(app.frame());
    expect(stats.changed.length).toBeGreaterThan(0);
    const textIndex = output.indexOf("header");
    const graphicIndex = output.indexOf("\x1b_G");
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(graphicIndex).toBeGreaterThan(textIndex);
    app.unmount();
  });
});
