import { describe, expect, test } from "bun:test";
import { AgentView, type AgentEvent, createSession } from "@butui/agent";
import { mount } from "@butui/test";

const toolStart: AgentEvent = {
  type: "tool.start",
  call: {
    id: "c1",
    turnId: "t1",
    name: "edit_file",
    args: {},
    status: "running",
    reversible: true,
  },
};

describe("AgentEvent: tool.diff", () => {
  test("同一 diff line id 的 chunk 只更新该行，不重复追加", () => {
    const session = createSession({ width: () => 60 });
    session.dispatch({ type: "turn.start", turnId: "t1" });
    session.dispatch(toolStart);
    session.dispatch({
      type: "tool.diff",
      callId: "c1",
      patch: {
        ops: [
          {
            op: "upsert",
            lines: [
              { id: "h1", kind: "hunk", text: "@@ -1 +1 @@", stable: false },
              { id: "a1", kind: "add", text: "const", newLine: 1, stable: false },
            ],
          },
        ],
      },
    });
    session.settle();

    const source = session.diffFor("c1");
    expect(source?.count()).toBe(2);

    session.dispatch({
      type: "tool.diff",
      callId: "c1",
      patch: {
        ops: [
          {
            op: "upsert",
            lines: [{ id: "a1", kind: "add", text: "const x = 1", newLine: 1, stable: false }],
          },
        ],
      },
    });
    session.settle();

    expect(source?.count()).toBe(2);
    expect(source?.lineAt(1)?.text).toBe("const x = 1");
    expect(source?.streaming()).toBe(true);
  });

  test("final / tool.result / turn.end 都会定稿 diff", () => {
    const session = createSession({ width: () => 60 });
    session.dispatch({ type: "turn.start", turnId: "t1" });
    session.dispatch(toolStart);
    session.dispatch({
      type: "tool.diff",
      callId: "c1",
      patch: {
        ops: [{ op: "upsert", lines: [{ id: "a1", kind: "add", text: "x", stable: false }] }],
      },
    });
    session.dispatch({ type: "tool.diff", callId: "c1", patch: { ops: [] }, final: true });
    expect(session.diffFor("c1")?.streaming()).toBe(false);

    session.dispatch({
      type: "tool.diff",
      callId: "c1",
      patch: {
        ops: [{ op: "upsert", lines: [{ id: "a2", kind: "add", text: "y", stable: false }] }],
      },
    });
    session.dispatch({ type: "tool.result", callId: "c1", result: { status: "success" } });
    expect(session.diffFor("c1")?.streaming()).toBe(false);
  });

  test("AgentView 能实时显示并更新工具 diff", () => {
    const session = createSession({ width: () => 60 });
    session.dispatch({ type: "turn.start", turnId: "t1" });
    session.dispatch(toolStart);
    session.dispatch({
      type: "tool.diff",
      callId: "c1",
      patch: {
        ops: [
          {
            op: "upsert",
            lines: [
              { id: "h1", kind: "hunk", text: "@@ -1 +1 @@", stable: false },
              { id: "a1", kind: "add", text: "const x", newLine: 1, stable: false },
            ],
          },
        ],
      },
    });
    session.settle();

    const app = mount(() => <AgentView session={session} />, { width: 60, height: 20 });
    expect(app.text()).toContain("@@ -1 +1 @@");
    expect(app.text()).toContain("const x");

    session.dispatch({
      type: "tool.diff",
      callId: "c1",
      patch: {
        ops: [
          { op: "upsert", lines: [{ id: "a1", kind: "add", text: "const x = 42", newLine: 1, stable: true }] },
        ],
      },
    });
    session.settle();
    app.flush();

    expect(app.text()).toContain("const x = 42");
    expect(app.text().match(/const x/g)).toHaveLength(1);
    app.unmount();
  });
});
