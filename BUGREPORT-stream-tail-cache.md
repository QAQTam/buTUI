# Bug Report: stream tail 定稿时会丢尾字符/残留旧 tail

## Metadata

- Repo: `buTUI`
- Base revision: `f20d4423dd74c9c603842150c41a2b213e397e55`
- Environment: Bun `1.4.2`, SolidJS `2.0.0-rc.9`, Linux x64
- Severity: High for streaming text correctness
- Affected area: `@butui/layout` + `@butui/stream` integration
- Consumer that exposed it: bugent's experimental `StreamText` entry

## Summary

当 `<stream>` 的最后一行从 volatile `tail` 进入 committed `lines` 时，布局缓存会保留旧 tail 对应的 cells，导致：

1. 该行最后新增的字符丢失；
2. 旧 tail 可能残留，表现为重复行；
3. 文本在“正在流式显示”到“已定稿”的边界上不稳定。

典型用户可见现象：

```text
- 「看下这个项目是干嘛的
```

在收到最后的 `」\n` 后，界面仍然显示：

```text
- 「看下这个项目是干嘛的
```

而不是：

```text
- 「看下这个项目是干嘛的」
```

## Minimal Reproduction

```tsx
import { mount } from "@butui/test";
import { StreamText, createTextStream } from "@butui/stream";

const source = createTextStream({ width: 80 });
const app = mount(() => <StreamText source={source} />, {
  width: 80,
  height: 10,
});

source.push("- 「看下这个项目是干嘛的");
app.flush();
// 此时 tail 正确显示无右引号

source.push("」\n");
app.flush();

const text = app.text();
// Expected:
// text.includes("- 「看下这个项目是干嘛的」")
//
// Actual before fix:
// text === "- 「看下这个项目是干嘛的"
```

Regression test added at:

```text
tests/stream-source.test.tsx
> 尾部行定稿后不会重复，也不会丢掉结尾字符
```

## Root Cause

`packages/layout/src/index.ts` 的 `measureStreamNode()` 曾直接复用 `entry.cells` 作为对外输出数组：

```ts
const out = entry.cells;
out.length = entry.converted;
for (const line of entry.tailCells) out.push(line);
```

这破坏了缓存语义：

- `entry.cells` 本应只保存 committed lines；
- 但 tail cells 被写回了同一个数组；
- 下一帧 committed line 增加时，旧 tail 已经混入 `entry.cells`；
- 随后 `out.length = entry.converted` 又会按 committed 数量截断，导致新 committed line 被截掉，旧 tail 留下。

时序：

```text
Frame 1:
  committed = []
  tail      = ["...没有右引号"]
  entry.cells becomes ["...没有右引号"]

Frame 2:
  committed = ["...有右引号"]
  entry.cells pushes committed at end
    -> ["...没有右引号", "...有右引号"]

  out.length = 1
    -> ["...没有右引号"]

  最终新定稿内容丢失，旧 tail 残留。
```

## Proposed Fix

把 committed cells 与对外 render view 分离：

```ts
interface StreamCache {
  converted: number;
  cells: Line[];   // 只存 committed lines
  render: Line[];  // committed cells + 当前 tail
  tailText: string | undefined;
  tailCells: Line[];
  // ...
}
```

每次测量：

```ts
entry.render.length = entry.cells.length;

for (let i = entry.converted; i < lines.length; i++) {
  const line = toCells(lines[i].text, node, "", semantic);
  entry.cells.push(line);
  entry.render.push(line);
}

for (const line of entry.tailCells) entry.render.push(line);

return {
  lines: entry.render,
  frozen: entry.cells.length,
  // ...
};
```

核心不变量：

```text
entry.cells 永远只包含 committed lines。
entry.render 可以包含 committed + tail。
tail 永远不能写回 entry.cells。
```

## Impact

This is not limited to one app. Any consumer of:

- `<StreamText>`
- `<StreamMarkdown>`
- `createTextStream()`
- `createMarkdownStream()`

that streams a line in chunks and then terminates it with `\n` can hit the
tail-to-committed transition.

The bug is especially visible for:

- closing quotes / brackets;
- Markdown list item endings;
- punctuation added in the last chunk;
- code fences;
- diff line terminators.

## Verification

After the fix:

```bash
bun --conditions=browser test
# 611 pass / 0 fail

bun --conditions=browser x tsc --noEmit
# clean
```

The new regression test asserts:

- the closing `」` is present after `\n`;
- the line appears exactly once;
- no stale tail remains.

## v0.2 Design Recommendation

For v0.2, make the stream cache contract explicit rather than relying on an
implicitly shared array:

1. Define separate concepts:
   - `committedCells`
   - `renderCells`
   - `tailCells`
2. Add an invariant checker in development:
   - `renderCells.length === committedCells.length + tailCells.length`
   - `renderCells.slice(0, committedCells.length) === committedCells`
3. Add a randomized/property test:
   - feed arbitrary text one grapheme/chunk at a time;
   - compare `committed + tail` against `Bun.wrapAnsi(fullText)` at every step;
   - explicitly include lines that end with punctuation in a later chunk.
4. Treat `StreamSource.lines` as committed-only and `tail()` as the only
   volatile segment in the public contract.
5. Document that `lines` is append-only and must never be used as scratch space
   for tail cells.

## Secondary Test Observation

The inertia tests were also environment-sensitive:

```text
TERM=dumb
```

made `prefersReducedMotion()` return true, so motion tests failed unless they
explicitly passed:

```ts
reducedMotion: false
```

That is a test isolation issue, not part of the layout bug, but it should be
fixed to keep CI independent of terminal environment.
