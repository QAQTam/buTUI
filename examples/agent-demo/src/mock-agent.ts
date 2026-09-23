/**
 * Mock agent —— 演示 SPEC §13 的协议。
 *
 * 它只做两件事：
 *   1. 消费 `UiCommand`（UI 发出的命令）
 *   2. 产出 `AgentEvent`（UI 消费的事件）
 *
 * 真实 agent（bugent / buagent）接进来时，只需要把这两个方向换成
 * NDJSON over stdio / WebSocket，UI 一行都不用改。
 */
import type { AgentEvent, UiCommand } from "@butui/agent";

export interface MockAgent {
  handle(command: UiCommand): void;
  /** 启动时先跑一轮，让界面有内容 */
  greet(): void;
}

const SCRIPTS = [
  [
    "**结论**：`@solidjs/universal` 的 `createRenderer` 契约直接可用，host ops 只有 13 个。\n\n",
    "- 文本层交给 `Bun.stringWidth` / `wrapAnsi` / `sliceAnsi`\n",
    "- 布局、cell buffer、输入解析要自己写\n\n",
    "> 其余都能靠 Bun 主线 API 撑住。\n",
  ],
  [
    "流式渲染的关键是**增量定稿边界**：\n\n",
    "1. 纯文本 —— 最后一个空格之前\n",
    "2. markdown —— 块状态机 + 内联定界符闭合\n\n",
    "这样每条 delta 都是 `O(delta + W)`，与已累积长度无关。\n",
  ],
  [
    "实测：\n\n",
    "| N | 每次 delta |\n",
    "|---|---|\n",
    "| 100 | 0.051 ms |\n",
    "| 9000 | 0.021 ms |\n\n",
    "**与已累积长度无关。**\n",
  ],
];

let turnSeq = 0;
let scriptIndex = 0;

export function createMockAgent(emit: (event: AgentEvent) => void): MockAgent {
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const runTurn = (userText: string) => {
    const turnId = `t${++turnSeq}`;
    emit({ type: "turn.start", turnId });

    const script = SCRIPTS[scriptIndex++ % SCRIPTS.length];
    let index = 0;
    let step = 0;

    const pump = () => {
      if (index >= script.length) {
        emit({ type: "turn.end", turnId, reason: "completed" });
        if (scriptIndex % SCRIPTS.length === 0) {
          emit({
            type: "permission.request",
            request: {
              id: `p${turnSeq}`,
              tool: "bash",
              detail: "rm -rf node_modules && bun install",
              irreversible: true,
            },
          });
        }
        return;
      }
      const chunk = script[index];
      // 逐 3 字符吐，模拟真实模型 delta
      let cursor = 0;
      const drip = () => {
        const piece = chunk.slice(cursor, cursor + 3);
        cursor += 3;
        if (piece) emit({ type: "text.delta", turnId, delta: piece });
        if (cursor < chunk.length) {
          later(18, drip);
          return;
        }
        index++;
        later(120, pump);
      };
      drip();
      void step;
    };

    // 先跑一个 tool call，再开始吐字
    emit({
      type: "tool.start",
      call: {
        id: `c${turnSeq}`,
        turnId,
        name: userText.includes("SPEC") ? "read_file buTUI/SPEC.md" : "grep -rn auth src/",
        args: {},
        status: "running",
        reversible: true,
      },
    });
    later(220, () => {
      emit({ type: "tool.result", callId: `c${turnSeq}`, result: { status: "success", output: "ok" } });
      emit({
        type: "todo.update",
        todos: [
          { id: "t1", label: "读 SPEC", status: "completed" },
          { id: "t2", label: "验证 Solid 2 RC universal", status: "completed" },
          { id: "t3", label: "验证 Bun 原生 API", status: "in_progress" },
          { id: "t4", label: "写 undo preview", status: "pending" },
        ],
      });
      pump();
    });
  };

  return {
    greet() {
      later(300, () => runTurn("看看 buTUI 能不能落地"));
    },
    handle(command) {
      switch (command.type) {
        case "user.submit":
          runTurn(command.text);
          return;
        case "permission.respond":
          emit({ type: "checkpoint.create", checkpoint: { id: `ck${turnSeq}`, branchId: "main", msgid: turnSeq, kind: "full", createdAt: 0 } });
          return;
        case "undo.preview":
          emit({
            type: "undo.preview",
            target: command.target,
            effects: [
              { kind: "messages", description: "2 条消息将移出当前分支", count: 2 },
              { kind: "files", description: "1 个文件将被反向 patch", count: 1 },
              { kind: "todo", description: "1 项 todo 状态回滚", count: 1 },
            ],
          });
          return;
        case "undo.apply":
          emit({ type: "branch.create", from: command.target, branchId: `b${turnSeq + 1}` });
          emit({ type: "branch.switch", branchId: `b${turnSeq + 1}` });
          return;
        default:
          return;
      }
    },
  };
}
