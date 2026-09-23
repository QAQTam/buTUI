import { describe, expect, test } from "bun:test";
import { stats as nodeStats } from "@butui/core";
import { Diff } from "@butui/components";
import { createDiffStream, type DiffLine } from "@butui/stream";
import { focusNode, mount } from "@butui/test";

const line = (id: string, text: string, overrides: Partial<DiffLine> = {}): DiffLine => ({
  id,
  kind: "context",
  text,
  stable: true,
  ...overrides,
});

describe("<Diff>：流式 diff 视图", () => {
  test("渲染 hunk / add / remove / context 与行号", () => {
    const source = createDiffStream({ id: "c1" });
    source.upsert([
      line("h", "@@ -1,2 +1,2 @@", { kind: "hunk" }),
      line("c1", "const answer = 42;", { oldLine: 1, newLine: 1 }),
      line("r1", "const answer = 41;", { kind: "remove", oldLine: 2 }),
      line("a1", "const answer = 43;", { kind: "add", newLine: 2 }),
    ]);
    const app = mount(
      () => <Diff source={source} height={4} lineNumbers language="ts" animate={false} />,
      { width: 50, height: 5 }
    );

    const text = app.text();
    expect(text).toContain("@@ -1,2 +1,2 @@");
    expect(text).toContain("1 1   const answer = 42;");
    expect(text).toContain("- const answer = 41;");
    expect(text).toContain("+ const answer = 43;");

    // context 行走语法高亮，add / remove 保持 diff 语义色。
    const contextCell = app.frame().lines[1].find(cell => cell.ch === "c");
    expect(contextCell?.sgr).toContain("38;2;125;211;252");
    const addCell = app.frame().lines[3].find(cell => cell.ch === "a");
    expect(addCell?.sgr).toContain("38;2;74;222;128");
    app.unmount();
  });

  test("只创建视口行；追加后贴底跟随", () => {
    const source = createDiffStream();
    const app = mount(
      () => <Diff source={source} height={4} animate={false} />,
      { width: 40, height: 5 }
    );
    const before = nodeStats.created;
    for (let i = 0; i < 1000; i++) {
      source.upsert([line(`l${i}`, `line ${i}`)]);
    }
    app.flush();
    const created = nodeStats.created - before;

    // 4 行视口，每行固定数量的宿主节点；与 1000 条无关。
    expect(created).toBeLessThan(150);
    expect(app.text()).toContain("line 999");
    expect(app.text()).not.toContain("line 995");
    app.unmount();
  });

  test("流式行显示游标，定稿后游标消失", () => {
    const source = createDiffStream();
    source.upsert([line("a", "const x", { kind: "add", stable: false })]);
    const app = mount(
      () => <Diff source={source} height={2} animate={false} />,
      { width: 30, height: 2 }
    );

    expect(app.text()).toContain("const x▌");
    source.flush();
    app.flush();
    expect(app.text()).toContain("const x");
    expect(app.text()).not.toContain("▌");
    app.unmount();
  });

  test("用户往回滚后，新 chunk 不抢回视口；End 恢复跟随", () => {
    const source = createDiffStream();
    for (let i = 0; i < 8; i++) source.upsert([line(`l${i}`, `line ${i}`)]);
    const app = mount(
      () => <Diff source={source} height={3} animate={false} />,
      { width: 30, height: 3 }
    );
    expect(app.text()).toContain("line 7");

    focusNode(app.root, app.root.children[0]);
    app.key("up");
    app.flush();
    const scrolled = app.text();
    source.upsert([line("l8", "line 8")]);
    app.flush();
    expect(app.text()).toBe(scrolled);
    expect(app.text()).not.toContain("line 8");

    app.key("end");
    app.flush();
    expect(app.text()).toContain("line 8");
    app.unmount();
  });

  test("长行截断，不把固定行高的虚拟化窗口撑坏", () => {
    const source = createDiffStream();
    source.upsert([line("long", "x".repeat(100))]);
    const app = mount(
      () => <Diff source={source} height={1} animate={false} />,
      { width: 20, height: 1 }
    );
    expect(app.text().endsWith("…")).toBe(true);
    expect(app.frame().lines).toHaveLength(1);
    app.unmount();
  });

  test("scrollbar 的 thumb 精确跟随窗口位置", () => {
    const source = createDiffStream();
    for (let i = 0; i < 20; i++) source.upsert([line(`l${i}`, `line ${i}`)]);
    const app = mount(
      () => <Diff source={source} height={4} scrollbar animate={false} />,
      { width: 20, height: 4 }
    );

    expect(app.frame().lines[3].at(-1)?.ch).toBe("█");
    focusNode(app.root, app.root.children[0]);
    app.key("home");
    app.flush();
    expect(app.frame().lines[0].at(-1)?.ch).toBe("█");
    expect(app.frame().lines[3].at(-1)?.ch).toBe("│");
    app.unmount();
  });
});
