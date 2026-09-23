import { describe, expect, test } from "bun:test";
import type { AgentMessage, Todo, Turn } from "@butui/agent";
import {
  Journal,
  type WorkspaceFs,
  applyUndo,
  fileChange,
  irreversibleReason,
  planEffects,
  planUndo,
} from "@butui/undo";

/** 内存工作区，测试用 */
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

const message = (id: string, msgid: number, turnId: string): AgentMessage => ({
  id,
  msgid,
  turnId,
  role: "assistant",
  origin: "assistant",
  createdAt: 0,
  branchId: "main",
  text: "",
});

const turn = (id: string, startMsgId: number): Turn => ({
  id,
  branchId: "main",
  startMsgId,
  status: "completed",
});

describe("Journal（SPEC §8.4 记录）", () => {
  test("按 toolCall / turn 检索", () => {
    const journal = new Journal();
    journal.record({
      toolCallId: "c1",
      turnId: "t1",
      reversible: true,
      files: [fileChange("a.ts", "a\n", "b\n")],
    });
    journal.record({
      toolCallId: "c2",
      turnId: "t2",
      reversible: true,
      files: [fileChange("b.ts", "x\n", "y\n")],
    });

    expect(journal.size).toBe(2);
    expect(journal.forToolCall("c1")).toHaveLength(1);
    expect(journal.forTurns(new Set(["t2"]))).toHaveLength(1);
    expect(journal.forTurns(new Set(["t2"]))[0].files[0].path).toBe("b.ts");
  });

  test("识别 SPEC §8.5 的不可逆操作", () => {
    const call = (command: string) => ({
      id: "c",
      turnId: "t",
      name: "bash",
      args: { command },
      status: "success" as const,
      reversible: true,
    });
    expect(irreversibleReason(call("git push origin main"))).toBe("git push");
    expect(irreversibleReason(call("npm publish --access public"))).toBe("npm publish");
    expect(irreversibleReason(call("curl -X POST https://api.example.com"))).toBe("远程写入");
    expect(irreversibleReason(call("rm -rf node_modules"))).toBe("破坏性文件操作");
    expect(irreversibleReason(call("ls -la"))).toBeUndefined();
  });
});

describe("Undo 计划（SPEC §8.3 预览）", () => {
  const messages = [
    message("m1", 1, "t1"),
    message("m2", 2, "t1"),
    message("m3", 3, "t2"),
    message("m4", 4, "t2"),
  ];
  const turns = [turn("t1", 1), turn("t2", 3)];

  const journal = new Journal();
  journal.record({
    toolCallId: "c1",
    turnId: "t1",
    reversible: true,
    files: [fileChange("src/auth.ts", "old\n", "new\n")],
    todoBefore: [{ id: "a", label: "读 SPEC", status: "completed" }],
  });
  journal.record({
    toolCallId: "c2",
    turnId: "t2",
    reversible: true,
    files: [
      fileChange("src/auth.ts", "new\n", "newer\n"),
      fileChange("src/util.ts", "u1\n", "u2\n"),
    ],
    // 撤销只涉及 t2，所以回滚到的是 t2 变更前的快照，不是更早的 c1
    todoBefore: [
      { id: "a", label: "读 SPEC", status: "completed" },
      { id: "b", label: "写 undo", status: "pending" },
    ],
  });

  test("统计将被移出的消息、涉及的文件、回滚的 todo", () => {
    const fs = memoryFs({ "src/auth.ts": "newer\n", "src/util.ts": "u2\n" });
    const plan = planUndo({
      target: "m2",
      messages,
      turns,
      todos: [{ id: "b", label: "写 undo", status: "pending" }],
      changes: journal.changes,
      read: fs.fs.read,
    });

    expect(plan.targetMsgId).toBe(2);
    expect(plan.messages).toEqual(["m3", "m4"]);
    expect(plan.files.sort()).toEqual(["src/auth.ts", "src/util.ts"]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.todos.map(t => t.label)).toEqual(["读 SPEC", "写 undo"]);
    // 后发生的先撤
    expect(plan.changes[0].toolCallId).toBe("c2");
  });

  test("文件被外部修改 → 冲突（SPEC §8.4 第 2 步）", () => {
    const fs = memoryFs({ "src/auth.ts": "被外部改过\n", "src/util.ts": "u2\n" });
    const plan = planUndo({
      target: "m2",
      messages,
      turns,
      todos: [],
      changes: journal.changes,
      read: fs.fs.read,
    });
    expect(plan.conflicts).toContain("src/auth.ts");
  });

  test("不可逆操作进入 irreversible 列表", () => {
    const j = new Journal();
    j.record({
      toolCallId: "c9",
      turnId: "t2",
      reversible: false,
      irreversibleReason: "npm publish",
      files: [],
    });
    const plan = planUndo({ target: "m2", messages, turns, todos: [], changes: j.changes });
    expect(plan.irreversible).toContain("npm publish");
  });

  test("planEffects 生成 UI 展示用的列表", () => {
    const fs = memoryFs({ "src/auth.ts": "被外部改过\n", "src/util.ts": "u2\n" });
    const plan = planUndo({
      target: "m2",
      messages,
      turns,
      todos: [{ id: "b", label: "写 undo", status: "pending" }],
      changes: journal.changes,
      read: fs.fs.read,
    });
    const effects = planEffects(plan);
    expect(effects.some(e => e.kind === "messages" && e.count === 2)).toBe(true);
    expect(effects.some(e => e.kind === "files" && e.count === 2)).toBe(true);
    expect(effects.some(e => e.kind === "todo")).toBe(true);
    expect(effects.some(e => e.irreversible && e.description.includes("已被外部修改"))).toBe(true);
  });
});

describe("Undo 执行（SPEC §8.4）", () => {
  test("revert 按逆序应用 reverse patch", () => {
    const fs = memoryFs({ "a.txt": "v3\n" });
    const journal = new Journal();
    journal.record({
      toolCallId: "c1",
      turnId: "t1",
      reversible: true,
      files: [fileChange("a.txt", "v1\n", "v2\n")],
    });
    journal.record({
      toolCallId: "c2",
      turnId: "t2",
      reversible: true,
      files: [fileChange("a.txt", "v2\n", "v3\n")],
    });

    // 目标在两次变更之前 → 两个 turn 的变更都要撤，且后发生的先撤
    const messages = [message("m0", 0, "t0"), message("m1", 1, "t1"), message("m2", 2, "t2")];
    const turns = [turn("t1", 1), turn("t2", 2)];
    const plan = planUndo({
      target: "m0",
      messages,
      turns,
      todos: [],
      changes: journal.changes,
      read: fs.fs.read,
    });
    expect(plan.changes.map(c => c.toolCallId)).toEqual(["c2", "c1"]);

    const result = applyUndo(plan, fs.fs, "revert");
    expect(result.ok).toBe(true);
    expect(fs.files.get("a.txt")).toBe("v1\n");
    expect(result.applied).toEqual(["a.txt"]);
  });

  test("branch 模式不动工作区", () => {
    const fs = memoryFs({ "a.txt": "v2\n" });
    const journal = new Journal();
    journal.record({
      toolCallId: "c1",
      turnId: "t1",
      reversible: true,
      files: [fileChange("a.txt", "v1\n", "v2\n")],
    });
    const messages = [message("m1", 1, "t1"), message("m2", 2, "t1")];
    const plan = planUndo({
      target: "m1",
      messages,
      turns: [turn("t1", 1)],
      todos: [],
      changes: journal.changes,
      read: fs.fs.read,
    });

    const result = applyUndo(plan, fs.fs, "branch");
    expect(result.ok).toBe(true);
    expect(fs.files.get("a.txt")).toBe("v2\n");
    expect(fs.writes).toEqual([]);
  });

  test("有冲突时一个文件都不写（全有或全无）", () => {
    const fs = memoryFs({ "a.txt": "v3\n", "b.txt": "被外部改过\n" });
    const journal = new Journal();
    journal.record({
      toolCallId: "c1",
      turnId: "t1",
      reversible: true,
      files: [fileChange("a.txt", "v1\n", "v2\n"), fileChange("b.txt", "b1\n", "b2\n")],
    });
    const plan = planUndo({
      target: "m0",
      messages: [message("m0", 0, "t0"), message("m1", 1, "t1")],
      turns: [turn("t1", 1)],
      todos: [],
      changes: journal.changes,
      read: fs.fs.read,
    });

    expect(plan.conflicts).toContain("b.txt");
    const result = applyUndo(plan, fs.fs, "revert");
    expect(result.ok).toBe(false);
    expect(fs.writes).toEqual([]);
    expect(fs.files.get("a.txt")).toBe("v3\n");
  });

  test("不可逆变更被跳过，可逆的照常撤销", () => {
    const fs = memoryFs({ "a.txt": "v2\n" });
    const journal = new Journal();
    journal.record({
      toolCallId: "c1",
      turnId: "t1",
      reversible: true,
      files: [fileChange("a.txt", "v1\n", "v2\n")],
    });
    journal.record({
      toolCallId: "c2",
      turnId: "t1",
      reversible: false,
      irreversibleReason: "git push",
      files: [],
    });

    const plan = planUndo({
      target: "m0",
      messages: [
        { ...message("m0", 0, "t0") },
        message("m1", 1, "t1"),
      ],
      turns: [turn("t1", 1)],
      todos: [],
      changes: journal.changes,
      read: fs.fs.read,
    });

    const result = applyUndo(plan, fs.fs, "revert");
    expect(result.ok).toBe(true);
    expect(result.skipped).toContain("git push");
    expect(fs.files.get("a.txt")).toBe("v1\n");
  });
});
