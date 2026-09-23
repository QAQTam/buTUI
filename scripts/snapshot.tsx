/**
 * 把 demo 渲染成纯文本快照（README 用）。
 *
 *   bun --conditions=browser run scripts/snapshot.tsx [columns] [rows]
 */
import { type AgentEvent, AgentView, createSession, decodeNdjson } from "@butui/agent";
import { mount } from "@butui/test";

const columns = Number(process.argv[2] ?? 72);
const rows = Number(process.argv[3] ?? 24);

const RECORDING = [
  `{"type":"text.delta","turnId":"t1","delta":"先读一下 src/auth.ts 和 SPEC.md。"}`,
  `{"type":"tool.start","call":{"id":"c1","turnId":"t1","name":"read_file src/auth.ts","args":{},"status":"success","reversible":true}}`,
  `{"type":"todo.update","todos":[{"id":"x","label":"读 SPEC","status":"completed"},{"id":"y","label":"验证 Solid 2 RC universal","status":"completed"},{"id":"z","label":"验证 Bun 原生 API","status":"pending"}]}`,
  `{"type":"turn.end","turnId":"t1","reason":"completed"}`,
].join("\n") + "\n";

const session = createSession({ width: () => columns - 6 });
for (const event of decodeNdjson<AgentEvent>(RECORDING)) session.dispatch(event);
// 在响应式 root 外部连续 dispatch 之后必须显式提交
session.settle();

const app = mount(() => <AgentView session={session} />, { width: columns, height: rows });
console.log(app.text());
app.unmount();

session.dispatch({
  type: "permission.request",
  request: { id: "p1", tool: "bash", detail: "rm -rf node_modules && bun install", irreversible: true },
});
session.settle();

console.log("\n" + "─".repeat(columns) + "\n");
const withDialog = mount(() => <AgentView session={session} />, { width: columns, height: rows });
console.log(withDialog.text());
withDialog.unmount();
