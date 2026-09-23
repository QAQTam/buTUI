/**
 * 把 demo 渲染成纯文本快照（README 用）。
 *
 *   bun --conditions=browser run scripts/snapshot.tsx
 */
import { flush } from "solid-js";
import { mount } from "@butui/test";
import { App } from "../examples/agent-demo/src/app.tsx";
import { setPermission, setSize } from "../examples/agent-demo/src/state.ts";

const columns = Number(process.argv[2] ?? 72);
const rows = Number(process.argv[3] ?? 22);

setSize({ columns, rows });
flush();

const app = mount(() => <App />, { width: columns, height: rows });
console.log(app.text());
app.unmount();

setPermission({
  id: "snap",
  tool: "bash",
  detail: "rm -rf node_modules && bun install",
  irreversible: true,
});
flush();

const withDialog = mount(() => <App />, { width: columns, height: rows });
console.log("\n" + "─".repeat(columns) + "\n");
console.log(withDialog.text());
withDialog.unmount();
