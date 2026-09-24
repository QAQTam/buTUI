/**
 * 平滑显现 demo。
 *
 *   bun --conditions=browser run scripts/smooth-stream-demo.tsx
 *
 * 生产者按约 2000 chunk/s 推入，显示端以 120fps / 160 列/秒起步；积压时在
 * 180ms 内平滑追赶，而不是每个 chunk 到了一次性跳出。
 */
import { createTuiApp } from "@butui/runtime";
import { StreamMarkdown, createMarkdownStream } from "@butui/stream";

const source = createMarkdownStream({ width: 72 });
const text = (
  "buTUI 的平滑流式渲染会把 **输入速度** 和 **视觉推进速度** 分开：\n\n" +
  "chunk 可以以 2000 tok/s 到达，但 reveal cursor 仍然按帧推进。普通 token " +
  "像水流一样逐列出现；当积压变大时，cursor 会在有限时间内加速追赶，所以 " +
  "不会无限落后，也不会因为一个 chunk 到来就整段跳出来。\n\n" +
  "CJK、emoji 和 ANSI 样式都按 grapheme / SGR 边界切片。按 Ctrl+C 退出。\n\n"
).repeat(4);

const app = createTuiApp({
  view: () => (
    <box border padding={1} direction="column">
      <text bold color="accent">smooth reveal · 120fps · 2000 chunk/s</text>
      <StreamMarkdown
        source={source}
        smooth={{ fps: 120, speed: 160, catchUpMs: 180, maxColumnsPerFrame: 128 }}
      />
    </box>
  ),
});

const chunks = [...text];
void (async () => {
  for (let i = 0; i < chunks.length; i += 2) {
    source.push(chunks[i] ?? "");
    source.push(chunks[i + 1] ?? "");
    await Bun.sleep(1);
  }
  source.flush();
  await Bun.sleep(3000);
  app.dispose();
  process.exit(0);
})();
