import { describe, expect, test } from "bun:test";
import { mount } from "@butui/test";
import { stats } from "@butui/core";
import { StreamMarkdown, StreamText, createMarkdownStream, createTextStream } from "@butui/stream";

describe("流式渲染：Solid 侧 O(1) 节点创建", () => {
  test("纯文本流：每次追加只新建固定数量的节点", () => {
    const source = createTextStream({ width: 24 });
    const app = mount(() => <StreamText source={source} />, { width: 24, height: 40 });

    const growth: number[] = [];
    for (let i = 0; i < 120; i++) {
      const before = stats.created;
      source.push(`line ${i}\n`);
      app.flush();
      growth.push(stats.created - before);
    }

    // 流式行不是 Solid 节点：整个流只对应一个 <stream> 节点，
    // 追加行只更新它的 props，不新建任何宿主节点。
    const steady = growth.slice(3);
    expect(Math.max(...steady)).toBeLessThanOrEqual(2);
    const total = steady.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(20);
    app.unmount();
  });

  test("markdown 流：长文档流式渲染的节点创建同样是常数", () => {
    const source = createMarkdownStream({ width: 30 });
    const app = mount(() => <StreamMarkdown source={source} />, { width: 30, height: 60 });

    const growth: number[] = [];
    for (let i = 0; i < 80; i++) {
      const before = stats.created;
      source.push(`第 ${i} 段内容，包含 **加粗** 和普通文字。\n\n`);
      app.flush();
      growth.push(stats.created - before);
    }
    const steady = growth.slice(10);
    expect(Math.max(...steady)).toBeLessThanOrEqual(6);
    app.unmount();
  });

  test("尾部行会被替换，但不会重建前面的行", () => {
    const source = createTextStream({ width: 20 });
    const app = mount(() => <StreamText source={source} />, { width: 20, height: 20 });

    source.push("hello world this is a long line that wraps\n");
    app.flush();
    const afterFirst = stats.created;

    // 只改最后一行
    source.push("tail");
    app.flush();
    const delta = stats.created - afterFirst;
    expect(delta).toBeLessThanOrEqual(2);
    expect(app.text()).toContain("tail");
    app.unmount();
  });
});
