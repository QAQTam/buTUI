import { describe, expect, test } from "bun:test";
import { type AgentEvent, createSession } from "@butui/agent";
import { ImageLayer, artifactImageRenderer } from "@butui/image";
import { mount } from "@butui/test";
import { App } from "../examples/agent-demo/src/app.tsx";

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
        imageLayer={imageLayer}
        onImageLoad={() => {}}
      />
    ),
    { width: columns, height: rows }
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

  test("没有 artifact 时不渲染面板（也不建图片图层）", () => {
    const session = createSession({ width: () => 114 });
    const imageLayer = new ImageLayer();
    const app = mount(
      () => (
        <App
          session={session}
          size={() => ({ columns: 120, rows: 24 })}
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
