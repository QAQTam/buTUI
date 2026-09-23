import { describe, expect, test } from "bun:test";
import { type AgentEvent, type UiCommand, AgentView, createSession } from "@butui/agent";
import { type WorkspaceFs, hashContent } from "@butui/undo";
import { mount } from "@butui/test";

/** 内存工作区 */
function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const fs: WorkspaceFs = {
    read: path => files.get(path),
    write: (path, text) => {
      files.set(path, text);
      writes.push(path);
    },
  };
  return { fs, files, writes };
}

/**
 * 造一个「两个 turn、每个 turn 改一次文件」的会话。
 *
 *   t1: 读文件 → 改 a.txt (v1 → v2)
 *   t2: 改 a.txt (v2 → v3) + 改 b.txt
 */
function scenario(withPrelude = false) {
  const store = memoryFs({ "a.txt": "v1\n", "b.txt": "b1\n" });
  const commands: UiCommand[] = [];
  const session = createSession({ width: () => 50, onCommand: c => commands.push(c) });
  // 可选的「第 0 条消息」，用来把 undo 目标设在所有变更之前
  if (withPrelude) session.submit("开始");

  const events: AgentEvent[] = [
    { type: "turn.start", turnId: "t1" },
    { type: "text.delta", turnId: "t1", delta: "先改 a.txt。" },
    {
      type: "tool.start",
      call: { id: "c1", turnId: "t1", name: "edit a.txt", args: {}, status: "running", reversible: true },
    },
    {
      type: "tool.result",
      callId: "c1",
      result: { status: "success", workspace: [{ path: "a.txt", before: "v1\n", after: "v2\n" }] },
    },
    { type: "todo.update", todos: [{ id: "x", label: "改 a", status: "completed" }] },
    { type: "turn.end", turnId: "t1", reason: "completed" },
    { type: "turn.start", turnId: "t2" },
    { type: "text.delta", turnId: "t2", delta: "再改两个文件。" },
    {
      type: "tool.start",
      call: { id: "c2", turnId: "t2", name: "edit a.txt", args: {}, status: "running", reversible: true },
    },
    {
      type: "tool.result",
      callId: "c2",
      result: { status: "success", workspace: [{ path: "a.txt", before: "v2\n", after: "v3\n" }] },
    },
    {
      type: "tool.start",
      call: { id: "c3", turnId: "t2", name: "edit b.txt", args: {}, status: "running", reversible: true },
    },
    {
      type: "tool.result",
      callId: "c3",
      result: { status: "success", workspace: [{ path: "b.txt", before: "b1\n", after: "b2\n" }] },
    },
    { type: "turn.end", turnId: "t2", reason: "completed" },
  ];

  for (const event of events) session.dispatch(event);
  // root 外批量注入后必须提交（Solid 2 的写入延迟到 flush）
  session.settle();
  // 应用事件里描述的「文件已改」状态
  store.files.set("a.txt", "v3\n");
  store.files.set("b.txt", "b2\n");
  return { session, store, commands };
}

describe("Session × Undo（SPEC §8）", () => {
  test("工具报告的 workspace 变更自动进 journal", () => {
    const { session } = scenario();
    expect(session.journal.size).toBe(3);
    const files = session.journal.changes.flatMap(c => c.files.map(f => f.path));
    expect(files).toEqual(["a.txt", "a.txt", "b.txt"]);
    // 链式修改的 hash 记录正确
    expect(session.journal.changes[0].files[0].beforeHash).toBe(hashContent("v1\n"));
    expect(session.journal.changes[0].files[0].afterHash).toBe(hashContent("v2\n"));
  });

  test("本地预览：统计消息 / 文件 / todo / 冲突", () => {
    const { session, store } = scenario();
    const target = session.state.messages[0].id; // t1 的 assistant 消息
    const plan = session.previewUndo(target, store.fs.read);

    expect(plan.messages).toHaveLength(1); // t2 的消息
    expect(plan.files.sort()).toEqual(["a.txt", "b.txt"]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes.map(c => c.toolCallId)).toEqual(["c3", "c2"]);
  });

  test("requestUndoPreview 把 effects 挂到 UI 上", () => {
    const { session, store } = scenario();
    session.requestUndoPreview(session.state.messages[0].id, store.fs.read);
    session.settle();

    const preview = session.state.undoPreview;
    expect(preview).toBeDefined();
    expect(preview!.effects.some(e => e.kind === "messages")).toBe(true);
    expect(preview!.effects.some(e => e.kind === "files" && e.count === 2)).toBe(true);
  });

  test("revert：按逆序把两个文件都还原", () => {
    const { session, store } = scenario();
    const outcome = session.undo(session.state.messages[0].id, "revert", store.fs);
    session.settle();

    expect(outcome.ok).toBe(true);
    expect(store.files.get("a.txt")).toBe("v2\n");
    expect(store.files.get("b.txt")).toBe("b1\n");
    expect(outcome.applied.sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("revert 到最早 → 回到最初内容", () => {
    const { session, store } = scenario(true);
    // 目标设在所有变更之前
    const prelude = session.state.messages[0];
    expect(prelude.text).toBe("开始");

    const outcome = session.undo(prelude.id, "revert", store.fs);
    expect(outcome.ok).toBe(true);
    expect(store.files.get("a.txt")).toBe("v1\n");
    expect(store.files.get("b.txt")).toBe("b1\n");
  });

  test("branch 模式：不动文件，开新分支且原历史保留", () => {
    const { session, store } = scenario();
    const target = session.state.messages[0].id;
    const before = session.state.messages.length;

    const outcome = session.undo(target, "branch", store.fs);
    session.settle();

    expect(outcome.ok).toBe(true);
    expect(store.writes).toEqual([]); // 没动工作区
    expect(session.state.messages).toHaveLength(before); // 历史没删
    expect(session.state.branches).toHaveLength(2);
    expect(session.state.activeBranch).toBe("b1");
    // 新分支上只能看到目标之前的消息
    expect(session.visibleMessages()).toHaveLength(1);
    expect(session.visibleMessages()[0].id).toBe(target);
  });

  test("外部修改导致冲突：报冲突且不写任何文件", () => {
    const { session, store } = scenario();
    store.files.set("b.txt", "被别的进程改了\n");

    const outcome = session.undo(session.state.messages[0].id, "revert", store.fs);
    session.settle();

    expect(outcome.ok).toBe(false);
    expect(outcome.conflicts).toContain("b.txt");
    expect(store.writes).toEqual([]);
    expect(session.state.revertConflicts).toContain("b.txt");
  });

  test("UI：预览面板与冲突对话框都能渲染出语义节点", () => {
    const { session, store } = scenario();
    const app = mount(() => <AgentView session={session} />, { width: 72, height: 48 });

    session.requestUndoPreview(session.state.messages[0].id, store.fs.read);
    app.flush();
    expect(app.text()).toContain("Undo Preview");

    const semantics = () =>
      app.frame().lines.flatMap(line => line.map(c => c.semantic).filter(Boolean));
    expect(semantics().some(s => s === "undo:confirm")).toBe(true);

    // 制造冲突
    store.files.set("b.txt", "外部修改\n");
    session.undo(session.state.messages[0].id, "revert", store.fs);
    app.flush();
    expect(app.text()).toContain("revert 冲突");
    expect(semantics().some(s => s === "revert:conflict")).toBe(true);

    app.unmount();
  });
});
