import { describe, expect, test } from "bun:test";
import { type AgentEvent, type UiCommand, AgentView, createSession } from "@butui/agent";
import { mount } from "@butui/test";

/** demo 现在完全由协议驱动：这里注入事件、断言界面、检查发出的命令 */
function setup(width = 64, height = 30) {
  const commands: UiCommand[] = [];
  const session = createSession({ width: () => width - 6, onCommand: c => commands.push(c) });
  const app = mount(() => <AgentView session={session} />, { width, height });
  return { session, app, commands };
}

const TURN: AgentEvent[] = [
  { type: "turn.start", turnId: "t1" },
  { type: "text.delta", turnId: "t1", delta: "先读一下 `src/auth.ts`。" },
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
      { id: "y", label: "写 undo preview", status: "pending" },
    ],
  },
  { type: "turn.end", turnId: "t1", reason: "completed" },
];

describe("agent demo（协议驱动）", () => {
  test("事件流渲染出消息 / tool card / todo", () => {
    const { session, app } = setup();
    for (const event of TURN) session.dispatch(event);
    app.flush();

    const text = app.text();
    expect(text).toContain("○ assistant");
    expect(text).toContain("read_file src/auth.ts");
    expect(text).toContain("todo 1/2");
    expect(text).toContain("branch: main");
    app.unmount();
  });

  test("提交输入走 user.submit 命令", () => {
    const { session, app, commands } = setup();
    session.submit("看看 buTUI 能不能落地");
    app.flush();

    expect(commands).toEqual([{ type: "user.submit", text: "看看 buTUI 能不能落地" }]);
    expect(app.text()).toContain("看看 buTUI 能不能落地");
    app.unmount();
  });

  test("权限弹窗可点击，响应走 permission.respond", () => {
    const { session, app, commands } = setup();
    session.dispatch({
      type: "permission.request",
      request: { id: "p1", tool: "bash", detail: "rm -rf node_modules", irreversible: true },
    });
    app.flush();
    expect(app.text()).toContain("该操作无法撤销");

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
    app.click(allow!.x, allow!.y);
    app.flush();

    expect(commands).toEqual([{ type: "permission.respond", id: "p1", allow: true }]);
    expect(session.state.permissions).toHaveLength(0);
    app.unmount();
  });

  test("消息节点带 message:<id> 语义，供上层做 undo / fork 路由", () => {
    const { session, app } = setup();
    for (const event of TURN) session.dispatch(event);
    app.flush();

    const frame = app.frame();
    const semantics = frame.lines.flatMap(line => line.map(c => c.semantic).filter(Boolean));
    expect(semantics.some(s => s!.startsWith("message:"))).toBe(true);
    // 消息体也带语义，点到正文同样能定位到消息
    expect(semantics.some(s => s!.endsWith(":body"))).toBe(true);
    app.unmount();
  });
});
