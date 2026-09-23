import { describe, expect, test } from "bun:test";
import { mount } from "@butui/test";
import { type AgentEvent, AgentView, createSession, decodeNdjson } from "@butui/agent";

/**
 * 回放 —— SPEC §15「event injection / replay」。
 *
 * 协议是 NDJSON，状态只由事件推导，所以「录一段流 → 重新喂一遍」必须得到
 * 逐字节相同的界面。这也是 remote attach / WebUI / 回归测试的共同基础。
 */
const RECORDING = [
  `{"type":"turn.start","turnId":"t1"}`,
  `{"type":"text.delta","turnId":"t1","delta":"正在分析 **auth 模块**。\\n\\n"}`,
  `{"type":"tool.start","call":{"id":"c1","turnId":"t1","name":"read_file src/auth.ts","args":{},"status":"running","reversible":true}}`,
  `{"type":"tool.result","callId":"c1","result":{"status":"success","output":"ok"}}`,
  `{"type":"todo.update","todos":[{"id":"x","label":"读 SPEC","status":"completed"},{"id":"y","label":"写 undo","status":"pending"}]}`,
  `{"type":"checkpoint.create","checkpoint":{"id":"ck1","branchId":"main","msgid":1,"kind":"full","createdAt":0}}`,
  '{"type":"text.delta","turnId":"t1","delta":"接下来要动 `src/auth.ts`。"}',
  `{"type":"turn.end","turnId":"t1","reason":"completed"}`,
  `{"type":"permission.request","request":{"id":"p1","tool":"bash","detail":"rm -rf node_modules","irreversible":true}}`,
  `{"type":"undo.preview","target":"m1","effects":[{"kind":"files","description":"2 个文件将被反向 patch","count":2},{"kind":"messages","description":"1 条消息移出分支","count":1}]}`,
].join("\n") + "\n";

function replay(recording: string, width = 72, height = 48) {
  const session = createSession({ width: () => width - 6 });
  const app = mount(() => <AgentView session={session} />, { width, height });
  for (const event of decodeNdjson<AgentEvent>(recording)) session.dispatch(event);
  app.flush();
  const text = app.text();
  const semantics = app
    .frame()
    .lines.flatMap(line => line.map(cell => cell.semantic).filter(Boolean));
  app.unmount();
  return { text, semantics, state: session.state };
}

describe("事件流回放（SPEC §15）", () => {
  test("同一段录制回放两次结果完全一致", () => {
    const a = replay(RECORDING);
    const b = replay(RECORDING);
    expect(b.text).toBe(a.text);
    expect(b.semantics).toEqual(a.semantics);
  });

  test("回放出的界面包含所有 agent 元素", () => {
    const { text } = replay(RECORDING);
    expect(text).toContain("○ assistant");
    expect(text).toContain("read_file src/auth.ts");
    expect(text).toContain("todo 1/2");
    expect(text).toContain("permission required");
    expect(text).toContain("该操作无法撤销");
    expect(text).toContain("Undo Preview");
    expect(text).toContain("2 个文件将被反向 patch");
    expect(text).toContain("branch: main");
  });

  test("语义标识覆盖 message / tool / todo / permission / undo / branch", () => {
    const { semantics } = replay(RECORDING);
    const prefixes = new Set(semantics.map(s => s!.split(":")[0]));
    expect(prefixes.has("message")).toBe(true);
    expect(prefixes.has("tool")).toBe(true);
    expect(prefixes.has("todo")).toBe(true);
    expect(prefixes.has("permission")).toBe(true);
    expect(prefixes.has("undo")).toBe(true);
    expect(prefixes.has("status")).toBe(true);
  });

  test("回放出的状态与 reducer 推导一致", () => {
    const { state } = replay(RECORDING);
    expect(state.turns[0].status).toBe("completed");
    expect(state.toolCalls[0].status).toBe("success");
    expect(state.todos).toHaveLength(2);
    expect(state.checkpoints).toHaveLength(1);
    expect(state.permissions).toHaveLength(1);
    expect(state.undoPreview?.effects).toHaveLength(2);
    expect(state.status).toBe("waiting_permission");
  });

  test("分片喂入（每次 7 字节）与整段喂入结果一致", () => {
    const whole = replay(RECORDING);
    const chunked = replay(RECORDING);
    expect(chunked.text).toBe(whole.text);

    // 逐字节切分的 NDJSON 也必须解出同样的事件
    const decoder = decodeNdjson<AgentEvent>(RECORDING);
    expect(decoder).toHaveLength(10);
  });

  test("在响应式 root 外部批量注入后，settle() 提交状态", () => {
    // Solid 2 的写入延迟到 flush：root 外连续 dispatch 之后不 settle 就读到空状态
    const session = createSession({ width: () => 60 });
    for (const event of decodeNdjson<AgentEvent>(RECORDING)) session.dispatch(event);
    expect(session.state.messages).toHaveLength(0);

    session.settle();
    expect(session.state.messages).toHaveLength(1);
    expect(session.state.turns[0].status).toBe("completed");
  });

  test("坏行被包成 error 事件，不影响其余回放", () => {
    const broken = "垃圾数据\n" + RECORDING;
    const { state, text } = replay(broken);
    expect(state.lastError).toContain("NDJSON");
    expect(text).toContain("read_file src/auth.ts");
  });
});
