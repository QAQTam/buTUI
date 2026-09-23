/**
 * Web demo 的 mock agent —— 只产出 AgentEvent，与 TUI demo 用的是同一套协议。
 */
import type { AgentEvent, UiCommand } from "@butui/agent";

const SCRIPTS = [
  "**Remote attach 成立**：服务端只发事件，浏览器里跑的是同一个 Session。\n\n",
  "- 同一串事件 → TUI 和 WebUI 推导出同一份状态\n",
  "- 渲染层完全不同（cell 网格 vs DOM），协议只有一套\n\n",
  "> `Ctrl+C` 退出终端那边，浏览器这边不受影响。\n",
];

let turn = 0;

export function createWebAgent(emit: (event: AgentEvent) => void) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const run = (text: string) => {
    const turnId = `w${++turn}`;
    emit({ type: "turn.start", turnId });
    emit({
      type: "tool.start",
      call: {
        id: `c${turn}`,
        turnId,
        name: text.includes("undo") ? "git diff" : "grep -rn attach src/",
        args: {},
        status: "running",
        reversible: true,
      },
    });
    later(260, () => {
      emit({ type: "tool.result", callId: `c${turn}`, result: { status: "success", output: "ok" } });
      emit({
        type: "todo.update",
        todos: [
          { id: "a", label: "协议驱动 UI", status: "completed" },
          { id: "b", label: "TUI 渲染", status: "completed" },
          { id: "c", label: "WebUI 渲染", status: "in_progress" },
        ],
      });
      const script = SCRIPTS[(turn - 1) % SCRIPTS.length];
      let i = 0;
      const drip = () => {
        const piece = script.slice(i, i + 3);
        i += 3;
        if (piece) emit({ type: "text.delta", turnId, delta: piece });
        if (i < script.length) later(16, drip);
        else emit({ type: "turn.end", turnId, reason: "completed" });
      };
      drip();
    });
  };

  return {
    start: () => later(300, () => run("看看 remote attach")),
    handle(command: UiCommand) {
      if (command.type === "user.submit") run(command.text);
      if (command.type === "permission.respond") {
        emit({ type: "turn.start", turnId: `w${++turn}` });
        emit({ type: "text.delta", turnId: `w${turn}`, delta: "已记录你的授权决定。\n" });
        emit({ type: "turn.end", turnId: `w${turn}`, reason: "completed" });
      }
    },
  };
}
