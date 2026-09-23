/**
 * 流式 diff 冒烟 / 手工观察。
 *
 *   bun --conditions=browser run scripts/diff-demo.tsx
 */
import { Diff } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { createDiffStream, type DiffLine } from "@butui/stream";

const source = createDiffStream({ id: "demo", path: "src/math.ts", language: "ts" });

const patches: DiffLine[][] = [
  [
    { id: "h1", kind: "hunk", text: "@@ -1,3 +1,4 @@", stable: false },
    { id: "c1", kind: "context", text: "export function add(a, b) {", oldLine: 1, newLine: 1 },
  ],
  [
    { id: "a1", kind: "add", text: "  const result = a + b;", newLine: 2, stable: false },
  ],
  [
    { id: "a1", kind: "add", text: "  const result = a + b; // streaming…", newLine: 2, stable: false },
  ],
  [
    { id: "a1", kind: "add", text: "  const result = a + b;", newLine: 2, stable: true },
    { id: "c2", kind: "context", text: "  return result;", oldLine: 2, newLine: 3 },
    { id: "r1", kind: "remove", text: "}", oldLine: 3 },
    { id: "a2", kind: "add", text: "}", newLine: 4 },
  ],
];

const app = createTuiApp({
  view: () => (
    <box border="round" borderColor="accent" padding={1} gap={1}>
      <row gap={1}>
        <text bold color="accent">stream diff</text>
        <text color="muted">src/math.ts</text>
      </row>
      <Diff source={source} height={5} lineNumbers language="ts" scrollbar />
      <text color="muted">↑↓ / PgUp / PgDn 滚动 · Ctrl+C 退出</text>
    </box>
  ),
  onQuit: () => app.dispose(),
});

let index = 0;
const timer = setInterval(() => {
  if (index < patches.length) {
    source.upsert(patches[index++]!);
    return;
  }
  source.flush();
  clearInterval(timer);
}, 450);
