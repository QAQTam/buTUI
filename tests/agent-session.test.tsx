import { describe, expect, test } from "bun:test";
import { mount } from "@butui/test";
import {
  type AgentEvent,
  type UiCommand,
  AgentView,
  ContextMeter,
  ReasoningLine,
  createSession,
  formatTokens,
  initialState,
  mergeUsage,
  reduce,
} from "@butui/agent";
import { flush } from "solid-js";

/** 构造一段标准的 agent turn 事件流 */
function turnEvents(turnId = "t1"): AgentEvent[] {
  return [
    { type: "turn.start", turnId },
    { type: "text.delta", turnId, delta: "先读一下 " },
    { type: "text.delta", turnId, delta: "`src/auth.ts`。" },
    {
      type: "tool.start",
      call: {
        id: `c-${turnId}`,
        turnId,
        name: "read_file src/auth.ts",
        args: { path: "src/auth.ts" },
        status: "running",
        reversible: true,
      },
    },
    { type: "tool.result", callId: `c-${turnId}`, result: { status: "success", output: "ok" } },
    { type: "turn.end", turnId, reason: "completed" },
  ];
}

describe("会话 reducer（纯函数，可回放）", () => {
  test("一次完整 turn 推导出的状态", () => {
    const state = initialState();
    for (const event of turnEvents()) reduce(state, event);

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].status).toBe("completed");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("assistant");
    expect(state.messages[0].streaming).toBe(false);
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].status).toBe("success");
    expect(state.status).toBe("idle");
  });

  test("权限请求会挂起状态，响应后恢复", () => {
    const state = initialState();
    reduce(state, { type: "permission.request", request: { id: "p1", tool: "bash", detail: "x", irreversible: true } });
    expect(state.status).toBe("waiting_permission");
    expect(state.permissions).toHaveLength(1);
  });

  test("不可逆操作带上 irreversible 标记（SPEC §8.5）", () => {
    const state = initialState();
    reduce(state, {
      type: "permission.request",
      request: { id: "p1", tool: "bash", detail: "npm publish", irreversible: true },
    });
    expect(state.permissions[0].irreversible).toBe(true);
  });

  test("undo.preview / undo.apply 的状态迁移", () => {
    const state = initialState();
    reduce(state, {
      type: "undo.preview",
      target: "m3",
      effects: [{ kind: "files", description: "3 个文件将被反向 patch", count: 3 }],
    });
    expect(state.undoPreview?.target).toBe("m3");
    expect(state.undoPreview?.effects).toHaveLength(1);

    reduce(state, { type: "undo.apply", target: "m3", mode: "branch" });
    expect(state.undoPreview).toBeUndefined();
  });

  test("branch.create / branch.switch", () => {
    const state = initialState();
    reduce(state, { type: "branch.create", from: "3", branchId: "b1" });
    expect(state.branches).toHaveLength(2);
    expect(state.branches[1].fromMsgId).toBe(3);
    reduce(state, { type: "branch.switch", branchId: "b1" });
    expect(state.activeBranch).toBe("b1");
  });

  test("checkpoint.create 累积", () => {
    const state = initialState();
    reduce(state, {
      type: "checkpoint.create",
      checkpoint: { id: "ck1", branchId: "main", msgid: 2, kind: "full", createdAt: 0 },
    });
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0].kind).toBe("full");
  });
});

describe("会话 + Solid 组件", () => {
  const setup = () => {
    const commands: UiCommand[] = [];
    const session = createSession({ width: () => 48, onCommand: c => commands.push(c) });
    const app = mount(() => <AgentView session={session} />, { width: 48, height: 20 });
    return { session, app, commands };
  };

  test("事件流驱动渲染", () => {
    const { session, app } = setup();
    for (const event of turnEvents()) session.dispatch(event);
    app.flush();

    const text = app.text();
    expect(text).toContain("○ assistant");
    expect(text).toContain("read_file src/auth.ts");
    expect(text).toContain("✓");
    app.unmount();
  });

  test("流式文本在 turn.end 之前就已经可见", () => {
    const { session, app } = setup();
    session.dispatch({ type: "turn.start", turnId: "t1" });
    session.dispatch({ type: "text.delta", turnId: "t1", delta: "正在输出" });
    app.flush();

    expect(app.text()).toContain("正在输出");
    app.unmount();
  });

  test("消息先于 stream source 建立时也能正确渲染 markdown", () => {
    // 回归：tool.start 会先建 assistant 消息，text.delta 才懒建 stream source。
    // 如果 sourceFor() 没有响应性，<Show> 会一直停在 fallback 上，markdown
    // 就会以原文显示。
    const { session, app } = setup();
    session.dispatch({
      type: "tool.start",
      call: {
        id: "c1",
        turnId: "t1",
        name: "read_file x",
        args: {},
        status: "running",
        reversible: true,
      },
    });
    app.flush();

    session.dispatch({ type: "text.delta", turnId: "t1", delta: "**粗体** 与 `code`" });
    app.flush();

    const sgr = app
      .frame()
      .lines.flatMap(line => line.map(c => c.sgr))
      .filter(Boolean);
    expect(sgr.some(s => s.includes("\x1b[1m"))).toBe(true);
    expect(app.text()).not.toContain("**");
    app.unmount();
  });

  test("点击消息返回 message:<id> 语义节点（SPEC §4.2）", () => {
    const { session, app } = setup();
    for (const event of turnEvents()) session.dispatch(event);
    app.flush();

    const frame = app.frame();
    let spot: { x: number; y: number; semantic: string } | undefined;
    for (let y = 0; y < frame.lines.length && !spot; y++) {
      for (let x = 0; x < frame.lines[y].length; x++) {
        const semantic = frame.lines[y][x].semantic;
        if (semantic?.startsWith("message:")) {
          spot = { x, y, semantic };
          break;
        }
      }
    }
    expect(spot).toBeDefined();
    expect(spot!.semantic.startsWith("message:")).toBe(true);
    app.unmount();
  });

  test("点击 tool card 返回 tool:<callId>", () => {
    const { session, app } = setup();
    for (const event of turnEvents()) session.dispatch(event);
    app.flush();

    const frame = app.frame();
    let found: string | undefined;
    for (const line of frame.lines) {
      for (const cell of line) {
        if (cell.semantic?.startsWith("tool:")) found = cell.semantic;
      }
    }
    expect(found).toBe("tool:c-t1");
    app.unmount();
  });

  test("user.submit 走命令通道，不直接改 agent 状态", () => {
    const { session, commands, app } = setup();
    session.submit("重构 auth");
    app.flush();

    expect(commands).toEqual([{ type: "user.submit", text: "重构 auth" }]);
    expect(app.text()).toContain("重构 auth");
    app.unmount();
  });

  test("权限弹窗的按钮带独立语义且可点击", () => {
    const { session, app } = setup();
    session.dispatch({
      type: "permission.request",
      request: { id: "p1", tool: "bash", detail: "rm -rf x", irreversible: true },
    });
    app.flush();

    const frame = app.frame();
    let allow: { x: number; y: number } | undefined;
    for (let y = 0; y < frame.lines.length && !allow; y++) {
      for (let x = 0; x < frame.lines[y].length; x++) {
        if (frame.lines[y][x].semantic === "permission:p1:allow") {
          allow = { x, y };
          break;
        }
      }
    }
    expect(allow).toBeDefined();
    app.unmount();
  });
});

describe("token 用量（SPEC §11.3）", () => {
  test("usage 事件累加增量，上下文占用取最近一次", () => {
    const state = initialState();
    reduce(state, { type: "usage", usage: { input: 1200, output: 300, cached: 800 } });
    expect(state.usage).toEqual({ input: 1200, output: 300, cached: 800, contextTokens: 1200 });

    reduce(state, {
      type: "usage",
      usage: { input: 2000, output: 400, cached: 1500, contextWindow: 128_000 },
    });
    expect(state.usage.input).toBe(3200); // 累计
    expect(state.usage.output).toBe(700);
    expect(state.usage.cached).toBe(2300);
    expect(state.usage.contextTokens).toBe(2000); // 不是 3200 —— 上下文看的是最近一次
    expect(state.usage.contextWindow).toBe(128_000);
  });

  test("mergeUsage：窗口只报一次也会被记住", () => {
    const first = mergeUsage({ input: 0, output: 0 }, { input: 10, output: 1, contextWindow: 8000 });
    const second = mergeUsage(first, { input: 20, output: 2 });
    expect(second.contextWindow).toBe(8000);
    expect(second.contextTokens).toBe(20);
  });

  test("mergeUsage 不产生 cached: 0（省得组件画一个 0%）", () => {
    const merged = mergeUsage({ input: 1, output: 1 }, { input: 1, output: 1 });
    expect("cached" in merged).toBe(false);
  });
});

describe("ContextMeter / ReasoningLine", () => {
  test("按窗口比例画占用条", () => {
    const app = mount(
      () => <ContextMeter usage={{ input: 0, output: 0, contextTokens: 32_000, contextWindow: 128_000 }} />,
      { width: 40, height: 1 }
    );
    const text = app.text();
    expect(text).toContain("32k/128k");
    expect(text).toContain("███"); // 25% of 10
    app.unmount();
  });

  test("占用超过 90% 转 danger 色", () => {
    const app = mount(
      () => <ContextMeter usage={{ input: 0, output: 0, contextTokens: 120_000, contextWindow: 128_000 }} />,
      { width: 40, height: 1 }
    );
    const sgr = app.frame().lines[0].map(c => c.sgr).join("");
    expect(sgr).toContain("38;2;248;113;113"); // theme.danger
    app.unmount();
  });

  test("没有 contextWindow 时只报数，不画比例", () => {
    const app = mount(() => <ContextMeter usage={{ input: 12_500, output: 900 }} />, {
      width: 40,
      height: 1,
    });
    expect(app.text()).toContain("12.5k");
    expect(app.text()).not.toContain("/");
    app.unmount();
  });

  test("formatTokens 分档", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(32_000)).toBe("32k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  test("ReasoningLine 默认折成一行（超长截断，不撑高转录）", () => {
    const app = mount(
      () => <ReasoningLine text={"思考".repeat(40)} streaming />,
      { width: 20, height: 2 }
    );
    const text = app.text();
    expect(text).toContain("思考中");
    expect(text).toContain("…");
    // 第二行是空的 —— 只占一行
    expect(app.frame().lines[1].map(c => c.ch).join("").trim()).toBe("");
    app.unmount();
  });
});

describe("流式标记（regression）", () => {
  test("text.delta 之后 message.streaming 必须为 true", () => {
    const session = createSession({ width: () => 60, onCommand: () => {} });
    session.dispatch({ type: "turn.start", turnId: "t1" });
    session.dispatch({ type: "text.delta", turnId: "t1", delta: "hi" });
    session.settle();
    expect(session.state.messages[0]!.streaming).toBe(true);

    const app = mount(() => <AgentView session={session} />, { width: 60, height: 8 });
    expect(app.text()).toContain("streaming…");

    session.dispatch({ type: "turn.end", turnId: "t1", reason: "completed" });
    session.settle();
    expect(session.state.messages[0]!.streaming).toBe(false);
    app.unmount();
  });
});

describe("并发 turn（regression：turn.end 不能封掉别的 turn 的流）", () => {
  test("A 轮结束时，B 轮还在流的 source 不受影响", () => {
    const session = createSession({ width: () => 60, onCommand: () => {} });
    session.dispatch({ type: "turn.start", turnId: "t1" });
    session.dispatch({ type: "turn.start", turnId: "t2" });
    session.dispatch({ type: "text.delta", turnId: "t2", delta: "B 先说" });
    session.settle();

    // A 轮结束（它没有任何文本）—— 以前这里会把 t2 的 source 一起 flush
    session.dispatch({ type: "turn.end", turnId: "t1", reason: "completed" });
    session.settle();

    expect(() => {
      session.dispatch({ type: "text.delta", turnId: "t2", delta: "，B 继续说" });
      session.settle();
    }).not.toThrow();

    const b = session.state.messages.find(m => m.turnId === "t2")!;
    expect(session.textOf(b.id)).toBe("B 先说，B 继续说");
    expect(session.sourceFor(b.id)).toBeDefined();

    session.dispatch({ type: "turn.end", turnId: "t2", reason: "completed" });
    session.settle();
    expect(session.state.messages.find(m => m.turnId === "t2")!.text).toBe("B 先说，B 继续说");
  });

  test("turn.end 之后又来的 delta 被忽略（不崩）", () => {
    const session = createSession({ width: () => 60, onCommand: () => {} });
    session.dispatch({ type: "turn.start", turnId: "t1" });
    session.dispatch({ type: "text.delta", turnId: "t1", delta: "完成" });
    session.dispatch({ type: "turn.end", turnId: "t1", reason: "completed" });
    session.settle();

    expect(() => {
      session.dispatch({ type: "text.delta", turnId: "t1", delta: "（迟到）" });
      session.settle();
    }).not.toThrow();
    expect(session.state.messages[0]!.text).toBe("完成");
  });
});

describe("思考流（ReasoningLine 的数据来源）", () => {
  test("turn 内可取，turn.end 之后丢掉（不落库）", () => {
    const session = createSession({ width: () => 60, onCommand: () => {} });
    session.dispatch({ type: "turn.start", turnId: "t1" });
    session.dispatch({ type: "reasoning.delta", turnId: "t1", delta: "先看 " });
    session.dispatch({ type: "reasoning.delta", turnId: "t1", delta: "auth.ts" });
    session.settle();

    const source = session.reasoningFor("t1");
    expect(source).toBeDefined();
    expect(source!.tail()).toBe("先看 auth.ts");

    session.dispatch({ type: "turn.end", turnId: "t1", reason: "completed" });
    session.settle();
    expect(session.reasoningFor("t1")).toBeUndefined();
  });

  test("MessageView 里能直接渲染思考行", () => {
    const session = createSession({ width: () => 60, onCommand: () => {} });
    session.dispatch({ type: "turn.start", turnId: "t1" });
    session.dispatch({ type: "reasoning.delta", turnId: "t1", delta: "在想一件事" });
    session.dispatch({ type: "text.delta", turnId: "t1", delta: "答案是 42" });
    session.settle();

    const app = mount(() => <AgentView session={session} />, { width: 60, height: 12 });
    const text = app.text();
    expect(text).toContain("思考中");
    expect(text).toContain("在想一件事");
    expect(text).toContain("答案是 42");
    app.unmount();
  });
});
