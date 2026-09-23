import { describe, expect, test } from "bun:test";
import { type AgentEvent, type UiCommand, AgentView, createSession } from "@butui/agent";
import { ansiToHtml, mountWebUI, sgrToCss, xterm256 } from "@butui/web";
import { mount } from "@butui/test";
import { flush } from "solid-js";

/**
 * WebUI 与 TUI **共享 Session 和事件协议，不共享组件代码**（SPEC §2.2 / §3）。
 *
 * 这组测试要证明的正是这条架构主张：同一串事件，终端和浏览器里得到的是
 * 同一份语义结构。
 */

const TURN: AgentEvent[] = [
  { type: "turn.start", turnId: "t1" },
  { type: "text.delta", turnId: "t1", delta: "先读一下 " },
  { type: "text.delta", turnId: "t1", delta: "**auth** 模块。" },
  {
    type: "tool.start",
    call: {
      id: "c1",
      turnId: "t1",
      name: "read_file src/auth.ts",
      args: {},
      status: "success",
      reversible: true,
    },
  },
  {
    type: "todo.update",
    todos: [
      { id: "x", label: "读 SPEC", status: "completed" },
      { id: "y", label: "写 undo", status: "pending" },
    ],
  },
  { type: "turn.end", turnId: "t1", reason: "completed" },
];

function setupDom() {
  const commands: UiCommand[] = [];
  const session = createSession({ width: () => 60, onCommand: c => commands.push(c) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = mountWebUI(session, container);
  return { session, container, commands, dispose };
}

const semanticsOf = (root: Element): string[] =>
  Array.from(root.querySelectorAll("[data-semantic]")).map(
    el => el.getAttribute("data-semantic") ?? ""
  );

describe("ANSI → HTML", () => {
  test("粗体 / 颜色 / 反显", () => {
    expect(ansiToHtml("\x1b[1mbold\x1b[22m")).toBe(
      '<span style="font-weight:600">bold</span>'
    );
    expect(ansiToHtml("\x1b[38;2;125;211;252mhi\x1b[0m")).toBe(
      '<span style="color:rgb(125,211,252)">hi</span>'
    );
    expect(ansiToHtml("\x1b[7mcode\x1b[27m")).toContain("background:#888");
  });

  test("HTML 被转义（不能让工具输出注入 DOM）", () => {
    expect(ansiToHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  test("256 色换算", () => {
    expect(xterm256(0)).toBe("#000000");
    expect(xterm256(231)).toBe("rgb(255,255,255)");
    expect(sgrToCss("\x1b[38;5;117m")).toBe("color:rgb(135,215,255)");
  });
});

describe("WebUI（@solidjs/web，generate: dom）", () => {
  test("事件流驱动 DOM 渲染", () => {
    const { session, container, dispose } = setupDom();
    for (const event of TURN) session.dispatch(event);
    flush();

    expect(container.textContent).toContain("assistant");
    expect(container.textContent).toContain("read_file src/auth.ts");
    expect(container.textContent).toContain("todo 1/2");
    expect(container.textContent).toContain("branch: main");
    dispose();
  });

  test("流式 markdown 在 DOM 里也是增量的、带样式的", () => {
    const { session, container, dispose } = setupDom();
    const text = "**结论**：host ops 只有 13 个。\n\n- 第一项\n- 第二项\n";
    for (let i = 0; i < text.length; i += 3) {
      session.dispatch({ type: "text.delta", turnId: "t1", delta: text.slice(i, i + 3) });
    }
    flush();

    const md = container.querySelector(".butui-md");
    expect(md).not.toBeNull();
    // 粗体被转成 span style
    expect(md!.innerHTML).toContain("font-weight:600");
    // markdown 语法被消化，不会以原文出现
    expect(md!.textContent).not.toContain("**");
    expect(md!.textContent).toContain("结论");
    // 列表项各占一行
    expect(md!.textContent).toContain("第一项");
    dispose();
  });

  test("语义标识与 TUI 一致 —— 同一 Session，两套渲染", () => {
    const session = createSession({ width: () => 60 });

    // TUI
    const tui = mount(() => <AgentView session={session} />, { width: 60, height: 40 });
    // WebUI
    const container = document.createElement("div");
    document.body.appendChild(container);
    const disposeWeb = mountWebUI(session, container);

    for (const event of TURN) session.dispatch(event);
    tui.flush();
    flush();

    const tuiSemantics = tui
      .frame()
      .lines.flatMap(line => line.map(cell => cell.semantic).filter(Boolean)) as string[];
    const webSemantics = semanticsOf(container);

    const normalize = (list: string[]) =>
      [...new Set(list.map(s => s.replace(/:body$/, "")))].sort();

    // 两边都能定位到消息、工具卡、todo、状态栏
    for (const expected of ["message:m1", "tool:c1", "todo:panel", "status:bar"]) {
      expect(normalize(tuiSemantics), `TUI 缺少 ${expected}`).toContain(expected);
      expect(normalize(webSemantics), `WebUI 缺少 ${expected}`).toContain(expected);
    }

    tui.unmount();
    disposeWeb();
  });

  test("点击权限按钮走同一条 UiCommand", () => {
    const { session, container, commands, dispose } = setupDom();
    session.dispatch({
      type: "permission.request",
      request: { id: "p1", tool: "bash", detail: "rm -rf node_modules", irreversible: true },
    });
    flush();

    expect(container.textContent).toContain("该操作无法撤销");
    const allow = container.querySelector<HTMLButtonElement>('[data-semantic="permission:p1:allow"]');
    expect(allow).not.toBeNull();
    allow!.click();
    flush();

    expect(commands).toEqual([{ type: "permission.respond", id: "p1", allow: true }]);
    expect(session.state.permissions).toHaveLength(0);
    dispose();
  });

  test("点消息 → 选中 → undo 预览 → 确认", () => {
    const { session, container, commands, dispose } = setupDom();
    for (const event of TURN) session.dispatch(event);
    flush();

    const message = container.querySelector<HTMLElement>('[data-semantic="message:m1"]');
    expect(message).not.toBeNull();
    message!.click();
    flush();

    const undo = container.querySelector<HTMLButtonElement>('[data-semantic="action:undo"]');
    expect(undo).not.toBeNull();
    undo!.click();
    flush();

    expect(container.textContent).toContain("Undo Preview");
    const confirm = container.querySelector<HTMLButtonElement>('[data-semantic="undo:confirm"]');
    expect(confirm).not.toBeNull();
    confirm!.click();

    expect(commands.some(c => c.type === "undo.apply")).toBe(true);
    dispose();
  });

  test("dispose 后不再更新", () => {
    const { session, container, dispose } = setupDom();
    for (const event of TURN) session.dispatch(event);
    flush();
    dispose();
    // Solid 的 render dispose 会清空容器
    const afterDispose = container.textContent;
    session.dispatch({ type: "text.delta", turnId: "t2", delta: "新内容" });
    flush();
    expect(container.textContent).toBe(afterDispose);
  });
});
