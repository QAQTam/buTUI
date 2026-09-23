/**
 * 图片子系统演示 / 自检。
 *
 *   bun --conditions=browser run scripts/image-demo.tsx
 *
 * 不需要真终端：程序化造一张图，跑完五条协议路径，把「会写进终端的字节」
 * 和「会进入 cell 网格的字符」都打出来。想看真实终端效果时：
 *
 *   BUTUI_IMAGE_PROTOCOL=kitty bun --conditions=browser run scripts/image-demo.tsx --raw
 */
import {
  type ImageEnv,
  ImageLayer,
  decodePng,
  detectProtocolSupport,
  encodePng,
  pickProtocol,
  renderImage,
} from "@butui/image";
import { layout } from "@butui/layout";
import { Renderer, plainText } from "@butui/renderer";
import { createElement, stripAnsi } from "@butui/core";

const WIDTH = 96;
const HEIGHT = 48;

/** 造一张能一眼看出「有没有画对」的测试图：对角渐变 + 网格 + 半透明圆 */
function testImage(): Uint8Array {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const radius = Math.min(WIDTH, HEIGHT) * 0.32;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 4;
      const grid = x % 16 === 0 || y % 16 === 0;
      const inside = (x - cx) ** 2 + (y - cy) ** 2 < radius ** 2;
      rgba[at] = grid ? 255 : Math.round((x / WIDTH) * 255);
      rgba[at + 1] = grid ? 255 : Math.round((y / HEIGHT) * 255);
      rgba[at + 2] = grid ? 255 : 80;
      rgba[at + 3] = inside ? 160 : 255;
    }
  }
  return encodePng({ width: WIDTH, height: HEIGHT, rgba });
}

const png = testImage();
console.log(`测试图：${WIDTH}×${HEIGHT} RGBA，PNG ${(png.length / 1024).toFixed(1)} KiB`);
console.log(`解码自检：${decodePng(png).width}×${decodePng(png).height}`);

const env = process.env as ImageEnv;
console.log(
  `能力探测：kitty=${detectProtocolSupport(env).kitty} iterm2=${detectProtocolSupport(env).iterm2} ` +
    `sixel=${detectProtocolSupport(env).sixel} tmux=${detectProtocolSupport(env).multiplexed}`
);
console.log(`\n本终端选中的协议：${pickProtocol({ env, force: process.env.BUTUI_IMAGE_PROTOCOL as never })}\n`);

// 量化开关的体积对比（远程 attach 场景最关心这个数）
{
  const plain = await renderImage(png, { protocol: "kitty", cols: 40, quantize: false });
  const quantized = await renderImage(png, { protocol: "kitty", cols: 40, quantize: true });
  console.log(
    `PNG 负载：真彩 ${(plain.graphic!.sequence.length / 1024).toFixed(1)} KiB → ` +
      `256 色量化 ${(quantized.graphic!.sequence.length / 1024).toFixed(1)} KiB`
  );
}

console.log("协议        box(cell)  绘制区      负载        说明");
console.log("─".repeat(76));

const layer = new ImageLayer();
const protocols = ["kitty", "iterm2", "sixel", "halfblock", "placeholder"] as const;
const results = [];

for (const protocol of protocols) {
  const started = Bun.nanoseconds();
  const image = await renderImage(png, { protocol, cols: 40, depth: "truecolor", alt: "demo" });
  const elapsed = (Bun.nanoseconds() - started) / 1e6;
  results.push(image);
  const payload = image.graphic ? `${(image.graphic.sequence.length / 1024).toFixed(1)} KiB` : "—";
  const note = image.fallback ? `降级：${image.fallback}` : `${elapsed.toFixed(1)} ms`;
  console.log(
    `${protocol.padEnd(11)} ${`${image.cols}×${image.rows}`.padEnd(10)} ` +
      `${`${image.rect.cols}×${image.rect.rows}`.padEnd(11)} ${payload.padEnd(11)} ${note}`
  );
  if (image.graphic) {
    layer.register(image.graphic.id, {
      protocol,
      sequence: image.graphic.sequence,
      id32: image.graphic.id32,
    });
  }
}

console.log("\n── cell 协议：半块图（这里只打印可见字符，SGR 已经剥掉）──");
const halfblock = results.find(r => r.protocol === "halfblock");
if (halfblock?.lines) {
  const visible = halfblock.lines.map(line => stripAnsi(line));
  console.log(visible.slice(0, 4).join("\n"));
  console.log(
    `… 共 ${visible.length} 行 × ${Bun.stringWidth(visible[0])} cell，` +
      `每 cell 承载 2 个像素（上半格 fg / 下半格 bg）`
  );
}

console.log("\n── 占位符（NO_COLOR 兜底）──");
const placeholder = results.find(r => r.protocol === "placeholder");
console.log(placeholder?.lines?.join("\n") ?? "(无)");

// ── 把原生图形接进真实布局 + 渲染器 ────────────────────────────────────────
const native = results.find(r => r.graphic);
if (native?.graphic) {
  const root = createElement("root");
  const box = createElement("box", { width: 44 });
  const image = createElement("image", {
    graphic: native.graphic.id,
    rect: native.rect,
    cols: native.cols,
    rows: native.rows,
  });
  root.children.push(box);
  box.parent = root;
  box.children.push(image);
  image.parent = box;
  root.rev = 1;
  box.rev = 1;
  image.rev = 1;

  const frame = layout(root, 44, native.rows + 2, { depth: "truecolor" });
  let painted = "";
  const renderer = new Renderer(
    chunk => {
      painted += chunk;
    },
    { afterDraw: (f, stats) => layer.render(f, stats.changed) }
  );

  const first = renderer.draw(frame);
  const bytesFirst = painted.length;
  painted = "";
  const second = renderer.draw(frame);
  console.log(`\n── 原生协议接进渲染器（${native.protocol}）──`);
  console.log(`首帧：文字 ${first.changedLines} 行 + 图形，共 ${(bytesFirst / 1024).toFixed(1)} KiB`);
  console.log(
    `无变化帧：文字 ${second.changedLines} 行，图形 ${painted.length} 字节（0 = 没有重发 base64）`
  );
  console.log(`帧内容（cell 网格）：\n${plainText(frame) || "  （占位 cell 全是空白 —— 图形由终端画在网格之上）"}`);

  if (process.argv.includes("--raw")) {
    const terminal = new Renderer(chunk => process.stdout.write(chunk), {
      afterDraw: (f, stats) => layer.render(f, stats.changed),
    });
    terminal.draw(frame);
    process.stdout.write("\x1b[0m\n");
  }
}

console.log(`\n所有序列都不含未净化输入：图形负载 = 我们自己编码的 base64（SPEC §12.3）`);
