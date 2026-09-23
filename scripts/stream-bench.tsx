/**
 * 流式渲染 O(1) 基准。
 *
 *   bun --conditions=browser run scripts/stream-bench.tsx
 */
import { mount } from "@butui/test";
import { StreamMarkdown, StreamText, createMarkdownStream, createTextStream } from "@butui/stream";

const DELTAS = 200;

function textBench(initial: number) {
  const source = createTextStream({ width: 40 });
  const app = mount(() => <StreamText source={source} />, { width: 40, height: 24 });
  for (let i = 0; i < initial; i++) source.push(`第 ${i} 行内容，稍微长一点让它折行。\n`);
  app.flush();
  app.paint();

  let push = 0;
  let flush = 0;
  let paint = 0;
  for (let i = 0; i < DELTAS; i++) {
    let t = performance.now();
    source.push(`新增第 ${i} 行内容，稍微长一点让它折行。\n`);
    push += performance.now() - t;
    t = performance.now();
    app.flush();
    flush += performance.now() - t;
    t = performance.now();
    app.paint();
    paint += performance.now() - t;
  }
  app.unmount();
  return { push: push / DELTAS, flush: flush / DELTAS, paint: paint / DELTAS };
}

function markdownBench(initial: number) {
  const source = createMarkdownStream({ width: 50 });
  const app = mount(() => <StreamMarkdown source={source} />, { width: 50, height: 24 });
  for (let i = 0; i < initial; i++) source.push(`第 ${i} 段，包含 **加粗** 和 \`code\`。\n\n`);
  app.flush();
  app.paint();

  let total = 0;
  for (let i = 0; i < DELTAS; i++) {
    const t = performance.now();
    source.push(`新增段落 ${i}，包含 **加粗** 与 \`code\`，还有一点中文。\n\n`);
    app.flush();
    app.paint();
    total += performance.now() - t;
  }
  app.unmount();
  return total / DELTAS;
}

console.log("纯文本流（每行约 20 字，宽 40）");
console.log("| N | push | flush | paint | 合计 |");
console.log("|---|---|---|---|---|");
for (const n of [100, 1000, 3000, 9000]) {
  const r = textBench(n);
  const total = r.push + r.flush + r.paint;
  console.log(
    `| ${n} | ${r.push.toFixed(3)} | ${r.flush.toFixed(3)} | ${r.paint.toFixed(3)} | **${total.toFixed(3)} ms** |`
  );
}

console.log("\nmarkdown 流（每段含内联样式，宽 50）");
for (const n of [50, 1000, 3000, 6000]) {
  console.log(`| ${n} | **${markdownBench(n).toFixed(3)} ms/delta** |`);
}
