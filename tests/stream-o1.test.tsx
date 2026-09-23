import { describe, expect, test } from "bun:test";
import { stats as nodeStats } from "@butui/core";
import { layout } from "@butui/layout";
import { StreamMarkdown, StreamText, createMarkdownStream, createTextStream } from "@butui/stream";
import { mount } from "@butui/test";

/**
 * 这组测试把「流式渲染 O(1)」钉成**确定性断言**，不依赖墙钟时间。
 *
 * 判据是各层的计数器：
 *   - 引擎：每次 push 交给 Bun.wrapAnsi / Bun.markdown.render 的字符数
 *   - 布局：每次布局真正重新测量的节点数
 *   - 响应式：每次 push 新建的宿主节点数
 *
 * 三者都不随已累积长度增长，才算真的 O(1)。
 */

interface Probe {
  perPush: { wrapped: number; styled: number; measured: number; created: number };
}

function runTextStream(initialLines: number, deltas: number): Probe {
  const source = createTextStream({ width: 40 });
  const app = mount(() => <StreamText source={source} />, { width: 40, height: 24 });
  for (let i = 0; i < initialLines; i++) source.push(`第 ${i} 行内容，稍微长一点让它折行。\n`);
  app.flush();
  app.paint();

  let wrapped = 0;
  let measured = 0;
  let created = 0;
  for (let i = 0; i < deltas; i++) {
    const w0 = Number(source.stats.wrappedChars ?? 0);
    const c0 = nodeStats.created;
    source.push(`新增第 ${i} 行内容，稍微长一点让它折行。\n`);
    app.flush();
    const counters = { measured: 0, reused: 0 };
    layout(app.root, 40, 24, { stats: counters });
    wrapped = Math.max(wrapped, Number(source.stats.wrappedChars ?? 0) - w0);
    measured = Math.max(measured, counters.measured);
    created = Math.max(created, nodeStats.created - c0);
  }
  app.unmount();
  return { perPush: { wrapped, styled: 0, measured, created } };
}

function runMarkdownStream(initialParagraphs: number, deltas: number): Probe {
  const source = createMarkdownStream({ width: 40 });
  const app = mount(() => <StreamMarkdown source={source} />, { width: 40, height: 24 });
  for (let i = 0; i < initialParagraphs; i++) source.push(`第 ${i} 段，包含 **加粗** 与 ` + "`code`" + `。\n\n`);
  app.flush();
  app.paint();

  let styled = 0;
  let wrapped = 0;
  let measured = 0;
  let created = 0;
  for (let i = 0; i < deltas; i++) {
    const s0 = Number(source.stats.styledChars ?? 0);
    const w0 = Number(source.stats.wrappedChars ?? 0);
    const c0 = nodeStats.created;
    source.push(`新增第 ${i} 段，包含 **加粗** 与 ` + "`code`" + `。\n\n`);
    app.flush();
    const counters = { measured: 0, reused: 0 };
    layout(app.root, 40, 24, { stats: counters });
    styled = Math.max(styled, Number(source.stats.styledChars ?? 0) - s0);
    wrapped = Math.max(wrapped, Number(source.stats.wrappedChars ?? 0) - w0);
    measured = Math.max(measured, counters.measured);
    created = Math.max(created, nodeStats.created - c0);
  }
  app.unmount();
  return { perPush: { wrapped, styled, measured, created } };
}

describe("流式渲染 O(1) 回归", () => {
  test("纯文本流：N 翻 50 倍，每次 delta 的各层成本不变", () => {
    const small = runTextStream(100, 60).perPush;
    const large = runTextStream(5000, 60).perPush;

    // 引擎：单次折行的字符数与总量无关
    expect(large.wrapped).toBeLessThanOrEqual(small.wrapped + 8);
    // 布局：单次布局真正测量的节点数不变
    expect(large.measured).toBeLessThanOrEqual(small.measured + 1);
    // 响应式：单次 push 新建的宿主节点数不变
    expect(large.created).toBeLessThanOrEqual(small.created + 1);
  });

  test("markdown 流：N 翻 50 倍，解析 / 布局 / 节点创建都不变", () => {
    const small = runMarkdownStream(50, 40).perPush;
    const large = runMarkdownStream(2500, 40).perPush;

    expect(large.styled).toBeLessThanOrEqual(small.styled + 16);
    expect(large.wrapped).toBeLessThanOrEqual(small.wrapped + 8);
    expect(large.measured).toBeLessThanOrEqual(small.measured + 1);
    expect(large.created).toBeLessThanOrEqual(small.created + 1);
  });

  test("布局的增量快路径确实生效（不是靠缓存全量重算）", () => {
    const source = createTextStream({ width: 40 });
    const app = mount(() => <StreamText source={source} />, { width: 40, height: 24 });
    for (let i = 0; i < 2000; i++) source.push(`行 ${i}\n`);
    app.flush();
    layout(app.root, 40, 24, {}); // 先建立缓存

    const counters = { measured: 0, reused: 0 };
    source.push("新的一行\n");
    app.flush();
    layout(app.root, 40, 24, { stats: counters });

    // 一次追加只应该真正测量极少数节点（新行 + 尾部）
    expect(counters.measured).toBeLessThanOrEqual(3);
    expect(counters.reused).toBeGreaterThan(0);
    app.unmount();
  });

  test("视口外的内容不参与每帧复制", () => {
    const source = createTextStream({ width: 40 });
    const app = mount(() => <StreamText source={source} />, { width: 40, height: 10 });
    for (let i = 0; i < 3001; i++) source.push(`行 ${i}\n`);
    app.flush();

    const frame = layout(app.root, 40, 10, {});
    expect(frame.lines.length).toBe(10);
    expect(frame.total).toBe(3001);
    // 帧只包含可视窗口
    expect(frame.lines.every(l => l.length === 40)).toBe(true);
    app.unmount();
  });
});
