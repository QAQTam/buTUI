import { describe, expect, test } from "bun:test";
import { type AgentEvent, createSession } from "@butui/agent";
import { createTextEditor } from "@butui/components";
import { ImageLayer } from "@butui/image";
import { mount } from "@butui/test";
import { App, FOOTER_ROWS } from "../examples/agent-demo/src/app.tsx";

/**
 * demo 外壳（SPEC §11.1 的放置策略）。
 *
 * ArtifactCanvas 是**独立面板**：宽终端下是右侧栏，窄终端下不占对话空间。
 * 这里验证的正是这条策略，而不是画布本身（画布在 artifact-canvas.test.tsx）。
 */
const ARTIFACT_EVENTS: AgentEvent[] = [
  {
    type: "tool.start",
    call: { id: "c1", turnId: "t1", name: "edit_file", args: {}, status: "success", reversible: true },
  },
  {
    type: "tool.result",
    callId: "c1",
    result: {
      status: "success",
      output: "wrote src/auth.ts",
      workspace: [{ path: "src/auth.ts", before: "const a = 1;", after: "const a = 2;" }],
    },
  },
];

function setup(columns: number, rows: number) {
  const session = createSession({ width: () => columns - 6 });
  for (const event of ARTIFACT_EVENTS) session.dispatch(event);
  session.settle();
  const imageLayer = new ImageLayer();
  const app = mount(
    () => (
      <App
        session={session}
        size={() => ({ columns, rows })}
        editor={createTextEditor()}
        imageLayer={imageLayer}
        onImageLoad={() => {}}
      />
    ),
    // 和 main.tsx 里 createTuiApp 的配置一致：贴底 + 底部固定 4 行
    { width: columns, height: rows, scroll: "bottom", stickyBottom: FOOTER_ROWS }
  );
  return { app, session };
}

describe("agent demo 外壳（artifact 面板放置）", () => {
  test("宽终端：artifact 面板作为右侧栏出现，且带并排比较能力", () => {
    const { app } = setup(120, 30);
    const text = app.text();
    expect(text).toContain("artifacts 2");
    expect(text).toContain("diff");
    expect(text).toContain("+const a = 2;");
    // 对话与面板并排：diff 卡片在右半边
    const diffRow = app.frame().lines.findIndex(line =>
      line.map(c => (c.width === 0 ? "" : c.ch)).join("").includes("+const a = 2;")
    );
    expect(diffRow).toBeGreaterThanOrEqual(0);
    const line = app.frame().lines[diffRow].map(c => (c.width === 0 ? "" : c.ch)).join("");
    expect(line.indexOf("+const a = 2;")).toBeGreaterThan(70);
    app.unmount();
  });

  test("窄终端：面板不出现，对话不被挤掉", () => {
    const { app } = setup(80, 30);
    const text = app.text();
    expect(text).not.toContain("artifacts 2");
    app.unmount();
  });

  test("转录贴底：消息很多时最后一条可见，输入栏仍钉在底部", () => {
    const session = createSession({ width: () => 74 });
    const events: AgentEvent[] = [{ type: "turn.start", turnId: "t1" }];
    for (let i = 0; i < 40; i++) {
      events.push({ type: "text.delta", turnId: "t1", delta: `第 ${i} 行\n` });
    }
    events.push({ type: "turn.end", turnId: "t1", reason: "completed" });
    for (const event of events) session.dispatch(event);
    session.settle();

    const app = mount(
      () => (
        <App
          session={session}
          size={() => ({ columns: 80, rows: 16 })}
          editor={createTextEditor()}
          imageLayer={new ImageLayer()}
          onImageLoad={() => {}}
        />
      ),
      { width: 80, height: 16, scroll: "bottom", stickyBottom: FOOTER_ROWS }
    );
    const text = app.text();
    expect(text).toContain("第 39 行"); // 跟底
    expect(text).not.toContain("第 0 行"); // 老内容滚上去了
    expect(text).toContain("说点什么…"); // 输入栏还在（sticky）
    app.unmount();
  });

  test("没有 artifact 时不渲染面板（也不建图片图层）", () => {
    const session = createSession({ width: () => 114 });
    const imageLayer = new ImageLayer();
    const app = mount(
      () => (
        <App
          session={session}
          size={() => ({ columns: 120, rows: 24 })}
          editor={createTextEditor()}
          imageLayer={imageLayer}
          onImageLoad={() => {}}
        />
      ),
      { width: 120, height: 24 }
    );
    expect(app.text()).not.toContain("artifacts");
    expect(imageLayer.size).toBe(0);
    app.unmount();
  });
});
