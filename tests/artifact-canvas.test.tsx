import { describe, expect, test } from "bun:test";
import {
  type Artifact,
  ArtifactCanvas,
  type Session,
  artifactsFromToolResult,
  artifactSummary,
  classifyOutput,
  createSession,
  formatTable,
  parseNumbers,
  parseTable,
  parseUnifiedDiff,
  prettyJson,
  sparkline,
  unifiedDiff,
} from "@butui/agent";
import { mount } from "@butui/test";

const artifact = (over: Partial<Artifact> & { kind: Artifact["kind"]; source: string }): Artifact => ({
  id: over.id ?? `a-${over.kind}`,
  createdAt: 0,
  ...over,
});

/** 在帧里找到含 needle 的那一行，点它的第一个字符 */
function clickText(app: ReturnType<typeof mount>, needle: string): boolean {
  const frame = app.frame();
  for (let y = 0; y < frame.lines.length; y++) {
    const text = frame.lines[y].map(c => (c.width === 0 ? "" : c.ch)).join("");
    const x = text.indexOf(needle);
    if (x >= 0) {
      app.click(x, y);
      return true;
    }
  }
  return false;
}

describe("Artifact 纯函数（SPEC §11.1 的内容层）", () => {
  test("unified diff 解析：五种行都认得", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.map(l => l.kind)).toEqual([
      "meta",
      "meta",
      "meta",
      "header",
      "context",
      "remove",
      "add",
    ]);
  });

  test("unifiedDiff：真改动的行号与内容", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nLINE2\nline3\n";
    const diff = unifiedDiff(before, after, "src/a.ts");
    expect(diff).toContain("--- a/src/a.ts");
    expect(diff).toContain("+++ b/src/a.ts");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+LINE2");
    // 未变的行作为上下文保留
    expect(diff).toContain(" line1");
    expect(diff).toContain(" line3");
  });

  test("unifiedDiff：远离改动的大段上下文被折叠", () => {
    const before = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");
    const after = before.replace("line30", "LINE30");
    const diff = unifiedDiff(before, after, "big.ts");
    expect(diff).toContain("@@ … 省略");
    expect(diff.split("\n").length).toBeLessThan(30);
  });

  test("unifiedDiff：整段重写时不做 O(n²) LCS", () => {
    const before = Array.from({ length: 600 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 600 }, (_, i) => `b${i}`).join("\n");
    const started = Bun.nanoseconds();
    const diff = unifiedDiff(before, after, "big.ts");
    const elapsed = (Bun.nanoseconds() - started) / 1e6;
    expect(diff).toContain("-a0");
    expect(diff).toContain("+b0");
    expect(elapsed).toBeLessThan(500);
  });

  test("表格解析：TSV / CSV / 竖线 / 空格对齐", () => {
    expect(parseTable("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseTable("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseTable("| a | b |\n| 1 | 2 |")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseTable("PID   USER\n1234  root")).toEqual([
      ["PID", "USER"],
      ["1234", "root"],
    ]);
    // 认不出来就当单列，绝不丢内容
    expect(parseTable("just one line")).toEqual([["just one line"]]);
  });

  test("表格对齐按显示宽度算（CJK 不跑偏）", () => {
    const rows = [
      ["名称", "值"],
      ["a", "1"],
    ];
    const lines = formatTable(rows);
    expect(Bun.stringWidth(lines[0])).toBe(Bun.stringWidth(lines[1]));
    expect(lines[0]).toContain("名称");
  });

  test("表格超宽时按比例截断并加省略号", () => {
    const rows = [["header-one-long", "header-two-long"], ["value-one-long", "value-two-long"]];
    const lines = formatTable(rows, { maxWidth: 24 });
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(24);
    expect(lines[0]).toContain("…");
  });

  test("sparkline：单调上升用满 8 级，等值走中间", () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe("▁▂▃▄▅▆▇█");
    expect(sparkline([5, 5, 5])).toBe("▄▄▄");
    expect(sparkline([1, 3, 2, 8])).toBe("▁▃▂█");
    expect(sparkline([])).toBe("");
  });

  test("sparkline：超出宽度时降采样而不是截断", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const line = sparkline(values, 10);
    expect([...line].length).toBe(10);
    // 降采样后仍然单调不降
    const levels = [...line].map(ch => "▁▂▃▄▅▆▇█".indexOf(ch));
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
  });

  test("parseNumbers：取每行最后一个数（name value 也认）", () => {
    expect(parseNumbers("cpu 12\ncpu 45\n7")).toEqual([12, 45, 7]);
    expect(parseNumbers("no digits here")).toEqual([]);
  });

  test("prettyJson：合法就格式化，非法就原样返回", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("not json")).toBe("not json");
  });

  test("输出分类：JSON / diff / 表格 / 日志", () => {
    expect(classifyOutput('{"a":1}')).toBe("json");
    expect(classifyOutput("diff --git a/x b/x\n@@ -1 +1 @@")).toBe("diff");
    expect(classifyOutput("a\tb\n1\t2")).toBe("table");
    expect(classifyOutput("PID   USER\n1234  root")).toBe("table");
    expect(classifyOutput("starting up\nready")).toBe("log");
    // 提示优先于启发式
    expect(classifyOutput('{"a":1}', "chart")).toBe("chart");
  });

  test("摘要：diff 报增删行数，chart 报数据点数", () => {
    const diff = artifact({ kind: "diff", source: "--- a\n+++ b\n-old\n+new\n+more" });
    expect(artifactSummary(diff)).toContain("2 增 / 1 删");
    expect(artifactSummary(artifact({ kind: "chart", source: "1\n2\n3" }))).toBe("3 个数据点");
    expect(artifactSummary(artifact({ kind: "log", source: "\n\nhello" }))).toBe("hello");
  });

  test("从 tool result 直接生成 artifact（含 workspace diff）", () => {
    const artifacts = artifactsFromToolResult(
      { id: "call-1", turnId: "t1", name: "edit_file", args: {}, status: "success", reversible: true },
      {
        status: "success",
        output: "wrote 2 files",
        workspace: [{ path: "src/a.ts", before: "const a = 1;", after: "const a = 2;" }],
      },
      { now: 42 }
    );

    expect(artifacts.length).toBe(2);
    const diff = artifacts.find(a => a.kind === "diff")!;
    expect(diff.toolCallId).toBe("call-1");
    expect(diff.id).toBe("call-1:src/a.ts");
    expect(diff.createdAt).toBe(42);
    expect(diff.source).toContain("+const a = 2;");

    const output = artifacts.find(a => a.kind === "log")!;
    expect(output.source).toBe("wrote 2 files");
  });
});

describe("ArtifactCanvas（SPEC §11.1 的交互层）", () => {
  test("渲染卡片：kind、摘要、工具关联都在", () => {
    const artifacts = [
      artifact({ id: "d1", kind: "diff", source: "--- a\n+++ b\n-a\n+b", toolCallId: "call-9" }),
      artifact({ id: "l1", kind: "log", source: "line 1\nline 2" }),
    ];
    const app = mount(() => <ArtifactCanvas artifacts={artifacts} />, { width: 60, height: 24 });
    const text = app.text();
    expect(text).toContain("diff");
    expect(text).toContain("1 增 / 1 删");
    expect(text).toContain("+b");
    expect(text).toContain("tool:call-9");
    // 标题栏有自己的语义，卡片内容归属 artifact:<id>
    expect(app.semanticAt(1, 0)).toBe("artifact:canvas:header");
    const cardRow = app.text().split("\n").findIndex(line => line.includes("+b"));
    expect(app.semanticAt(2, cardRow)).toBe("artifact:d1");
    app.unmount();
  });

  test("折叠 → 展开：长日志默认只显示 6 行并提示剩余", () => {
    const source = Array.from({ length: 20 }, (_, i) => `log line ${i}`).join("\n");
    // 高度要够：展开后是 20 行内容，视口太矮会看不到最后一行
    const app = mount(() => <ArtifactCanvas artifacts={[artifact({ id: "l1", kind: "log", source })]} />, {
      width: 40,
      height: 40,
    });

    expect(app.text()).toContain("log line 0");
    expect(app.text()).toContain("log line 5");
    expect(app.text()).not.toContain("log line 6");
    expect(app.text()).toContain("还有 14 行");

    expect(clickText(app, "▤")).toBe(true);
    app.flush();
    expect(app.text()).toContain("log line 19");
    expect(app.text()).not.toContain("还有 14 行");
    app.unmount();
  });

  test("pin：固定后出现标记；两张都 pin 且开比较时并排", () => {
    const artifacts = [
      artifact({ id: "a", kind: "log", source: "AAA" }),
      artifact({ id: "b", kind: "log", source: "BBB" }),
    ];
    const app = mount(() => <ArtifactCanvas artifacts={artifacts} compare />, {
      width: 80,
      height: 24,
    });

    expect(clickText(app, "[pin]")).toBe(true);
    app.flush();
    expect(app.text()).toContain("📌");
    expect(app.text()).toContain("1 pinned");
    expect(app.text()).not.toContain("并排比较");

    // 第二张也 pin 上 → 进入并排模式
    expect(clickText(app, "[pin]")).toBe(true);
    app.flush();
    expect(app.text()).toContain("并排比较");

    // 并排时两张卡在同一行：找同一行同时含 AAA / BBB
    const frame = app.frame();
    const sameRow = frame.lines.some(line => {
      const text = line.map(c => (c.width === 0 ? "" : c.ch)).join("");
      return text.includes("AAA") && text.includes("BBB");
    });
    expect(sameRow).toBe(true);
    app.unmount();
  });

  test("[open] 走 artifact.open 命令（remote attach / WebUI 打开）", () => {
    const sent: unknown[] = [];
    const session = { send: (command: unknown) => sent.push(command) } as unknown as Session;
    const app = mount(
      () => <ArtifactCanvas artifacts={[artifact({ id: "img-1", kind: "log", source: "x" })]} session={session} />,
      { width: 40, height: 12 }
    );

    expect(clickText(app, "[open]")).toBe(true);
    expect(sent).toEqual([{ type: "artifact.open", id: "img-1" }]);
    app.unmount();
  });

  test("[copy] 回调拿到 artifact（复制路径）", () => {
    const copied: Artifact[] = [];
    const app = mount(
      () => (
        <ArtifactCanvas
          artifacts={[artifact({ id: "f1", kind: "file", source: "src/auth.ts" })]}
          onCopy={a => copied.push(a)}
        />
      ),
      { width: 40, height: 12 }
    );
    expect(clickText(app, "[copy]")).toBe(true);
    expect(copied.map(a => a.source)).toEqual(["src/auth.ts"]);
    app.unmount();
  });

  test("表格 artifact 渲染成对齐的列", () => {
    const app = mount(
      () => (
        <ArtifactCanvas
          artifacts={[artifact({ id: "t1", kind: "table", source: "名称,值\nfoo,1\nbarbar,22" })]}
        />
      ),
      { width: 40, height: 14 }
    );
    const lines = app.text().split("\n");
    const headerLine = lines.find(line => line.includes("名称") && line.includes("值") && !line.includes("table"))!;
    const fooLine = lines.find(line => line.includes("foo"))!;
    const barbarLine = lines.find(line => line.includes("barbar"))!;
    // 比的是**显示列**（CJK 占 2 列，不能用 indexOf 的 code unit 位置）
    const columnOf = (line: string, needle: string): number =>
      Bun.stringWidth(line.slice(0, line.indexOf(needle)));
    expect(columnOf(headerLine, "值")).toBe(columnOf(fooLine, "1"));
    expect(columnOf(barbarLine, "22")).toBe(columnOf(fooLine, "1"));
    app.unmount();
  });

  test("chart artifact 画成 sparkline + 统计", () => {
    const app = mount(
      () => (
        <ArtifactCanvas
          artifacts={[artifact({ id: "c1", kind: "chart", source: "1\n3\n2\n8" })]}
        />
      ),
      { width: 40, height: 12 }
    );
    expect(app.text()).toContain("▁▃▂█");
    expect(app.text()).toContain("min 1 · max 8 · last 8");
    app.unmount();
  });

  test("json artifact 被格式化后按行渲染", () => {
    const app = mount(
      () => (
        <ArtifactCanvas artifacts={[artifact({ id: "j1", kind: "json", source: '{"a":1,"b":[2]}' })]} />
      ),
      { width: 40, height: 14 }
    );
    expect(app.text()).toContain('"a": 1');
    expect(app.text()).toContain("2");
    app.unmount();
  });

  test("image artifact：没注入渲染器时退化成文本占位（不依赖任何图片能力）", () => {
    const app = mount(
      () => (
        <ArtifactCanvas
          artifacts={[artifact({ id: "i1", kind: "image", source: "/nope/missing.png", mime: "image/png" })]}
        />
      ),
      { width: 50, height: 20 }
    );
    app.flush();
    expect(app.text()).toContain("image");
    expect(app.text()).toContain("/nope/missing.png");
    expect(app.text()).toContain("未注入图片渲染器");
    app.unmount();
  });

  test("image artifact：注入渲染器后走注入的实现（TUI / WebUI 各自接各自的）", () => {
    const calls: string[] = [];
    const app = mount(
      () => (
        <ArtifactCanvas
          artifacts={[artifact({ id: "i2", kind: "image", source: "shots/a.png", mime: "image/png" })]}
          renderers={{
            image: (source, alt) => {
              calls.push(`${source}|${alt}`);
              return <text color="accent">IMG {source}</text>;
            },
          }}
        />
      ),
      { width: 50, height: 16 }
    );
    expect(calls).toEqual(["shots/a.png|shots/a.png（image/png）"]);
    expect(app.text()).toContain("IMG shots/a.png");
    app.unmount();
  });

  test("空 canvas 只渲染标题，不报错", () => {
    const app = mount(() => <ArtifactCanvas artifacts={[]} />, { width: 30, height: 3 });
    expect(app.text()).toContain("artifacts 0");
    app.unmount();
  });

  test("session 里 artifact.add 之后能渲染出来（协议 → UI 全链路）", () => {
    const session = createSession({ width: () => 40 });
    const app = mount(
      () => <ArtifactCanvas artifacts={session.state.artifacts} session={session} />,
      { width: 40, height: 16 }
    );
    expect(app.text()).toContain("artifacts 0");

    session.dispatch({
      type: "artifact.add",
      artifact: artifact({ id: "x1", kind: "log", source: "hello artifact" }),
    });
    session.settle();
    app.flush();

    expect(app.text()).toContain("artifacts 1");
    expect(app.text()).toContain("hello artifact");
    app.unmount();
  });
});
