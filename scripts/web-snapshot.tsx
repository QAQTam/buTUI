/**
 * 把 WebUI 渲染成 HTML（文档 / 调试用）。
 *
 *   bun --conditions=browser --preload ./tests/dom-setup.ts run scripts/web-snapshot.tsx
 */
import { type AgentEvent, createSession, decodeNdjson } from "@butui/agent";
import { mountWebUI } from "@butui/web";
import { flush } from "solid-js";

const RECORDING = [
  `{"type":"text.delta","turnId":"t1","delta":"**Remote attach 成立**：服务端只发事件。\\n\\n"}`,
  `{"type":"text.delta","turnId":"t1","delta":"- TUI 和 WebUI 推导出同一份状态\\n- 渲染层完全不同\\n\\n"}`,
  `{"type":"text.delta","turnId":"t1","delta":"> 协议只有一套。\\n"}`,
  `{"type":"tool.start","call":{"id":"c1","turnId":"t1","name":"grep -rn attach src/","args":{},"status":"success","reversible":true}}`,
  `{"type":"todo.update","todos":[{"id":"a","label":"协议驱动 UI","status":"completed"},{"id":"b","label":"WebUI 渲染","status":"in_progress"}]}`,
  `{"type":"turn.end","turnId":"t1","reason":"completed"}`,
].join("\n") + "\n";

const session = createSession({ width: () => 720 });
for (const event of decodeNdjson<AgentEvent>(RECORDING)) session.dispatch(event);
session.settle();

const container = document.createElement("div");
document.body.appendChild(container);
mountWebUI(session, container);
flush();

console.log(container.innerHTML);
