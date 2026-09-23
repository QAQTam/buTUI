/**
 * Artifact Canvas 快照（SPEC §11.1）。
 *
 *   bun --conditions=browser run scripts/artifact-demo.tsx [columns] [rows]
 *
 * 全部内容都来自事件流：先 dispatch 一串 `tool.result`，reducer 自己从
 * tool result 推导 artifact（diff / 表格 / chart / JSON / 日志），再把画布
 * 渲染成纯文本。图片 artifact 走注入的渲染器，不注入时退化成文本占位。
 */
import { type AgentEvent, ArtifactCanvas, createSession } from "@butui/agent";
import { mount } from "@butui/test";

const columns = Number(process.argv[2] ?? 64);
const rows = Number(process.argv[3] ?? 40);

const RECORDING: AgentEvent[] = [
  {
    type: "tool.start",
    call: { id: "edit", turnId: "t1", name: "edit_file", args: {}, status: "success", reversible: true },
  },
  {
    type: "tool.result",
    callId: "edit",
    result: {
      status: "success",
      output: "wrote src/auth.ts",
      workspace: [
        {
          path: "src/auth.ts",
          before: "export function login() {\n  // TODO: extract\n  return token;\n}\n",
          after: "export function login() {\n  return extract() ?? token;\n}\n",
        },
      ],
    },
  },
  {
    type: "tool.start",
    call: { id: "bench", turnId: "t1", name: "bench", args: {}, status: "success", reversible: true },
  },
  {
    type: "tool.result",
    callId: "bench",
    result: {
      status: "success",
      output: [
        "N\tpush\tflush\tpaint",
        "100\t0.006\t0.008\t0.022",
        "1000\t0.003\t0.004\t0.010",
        "3000\t0.003\t0.003\t0.010",
        "9000\t0.005\t0.005\t0.015",
      ].join("\n"),
    },
  },
  {
    type: "tool.start",
    call: { id: "perf", turnId: "t1", name: "chart", args: {}, status: "success", reversible: true },
  },
  {
    type: "tool.result",
    callId: "perf",
    result: { status: "success", output: "12\n18\n9\n27\n31\n24\n38\n44\n36\n51" },
  },
  {
    type: "tool.start",
    call: { id: "cfg", turnId: "t1", name: "read_config", args: {}, status: "success", reversible: true },
  },
  {
    type: "tool.result",
    callId: "cfg",
    result: {
      status: "success",
      output: JSON.stringify({ model: "solid-2-rc", hostOps: 13, conditions: ["browser"], image: { kitty: true } }),
    },
  },
  {
    type: "artifact.add",
    artifact: {
      id: "shot-1",
      kind: "image",
      source: "./shots/stream-o1.png",
      mime: "image/png",
      createdAt: 0,
    },
  },
];

const session = createSession({ width: () => columns });
for (const event of RECORDING) session.dispatch(event);
session.settle();

console.log(`# artifact canvas（${columns}×${rows}）`);
console.log(`# 共 ${session.state.artifacts.length} 个 artifact：${session.state.artifacts.map(a => a.kind).join(" / ")}\n`);

const app = mount(
  () => <ArtifactCanvas artifacts={session.state.artifacts} session={session} compare />,
  { width: columns, height: rows }
);
console.log(app.text());
app.unmount();
