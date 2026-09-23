# buTUI

> 面向 coding agent 的 Agent UI Runtime。设计文档见 [SPEC.md](./SPEC.md)。

当前状态：**M1/M2 骨架 + 流式渲染 O(1) + 事件协议驱动的 agent UI +
分支式 Undo 已跑通**，`bun test` 127 个用例全绿。

```
Solid signal / store
  → @butui/solid   (13 个 host ops，Solid 自带 reconciler)
  → @butui/core    (节点树 / 失效传播 / focus / 事件冒泡 / theme / ANSI 解析)
  → @butui/agent   (事件协议 reducer + Session + SPEC §10.2 组件)
  → @butui/undo    (workspace 日志 + 行级 patch + 分支式 undo)
  → @butui/stream  (增量折行 + 增量 markdown，O(delta) 定稿)
  → @butui/layout  (flex 子集 + 增量合成 + 视口窗口)
  → @butui/renderer(cell buffer + 逐行差分 + SGR 状态机)
  → @butui/terminal(raw mode / resize / 输入解码 / 能力探测)
  → 终端 ANSI
```

## 流式渲染 O(1)

**保证**：每条 delta 的处理成本是 `O(|delta| + W)`（W = 折行宽度），与已累积
长度 N 无关。markdown 同理。

实测（`bun --conditions=browser run scripts/stream-bench.tsx`）：

| N（已累积行数） | push | flush | paint（布局+差分） | 合计 |
|---|---|---|---|---|
| 100 | 0.010 ms | 0.011 ms | 0.029 ms | **0.051 ms** |
| 1000 | 0.004 ms | 0.004 ms | 0.012 ms | **0.020 ms** |
| 3000 | 0.002 ms | 0.003 ms | 0.008 ms | **0.014 ms** |
| 9000 | 0.003 ms | 0.004 ms | 0.013 ms | **0.021 ms** |

markdown 流：N=50 → 0.062 ms/delta，N=6000 → 0.041 ms/delta。

### 用法

```tsx
import { StreamMarkdown, createMarkdownStream } from "@butui/stream";

const source = createMarkdownStream({ width: 60 });

// 每个 SSE / 模型 delta 调一次
source.push("**结论**：");
source.push("host ops 只有 13 个。\n\n");

<StreamMarkdown source={source} semantic="message:m2" />
```

`createTextStream({ width })` 是纯文本版本。两者都提供：

| 成员 | 说明 |
|---|---|
| `lines` | 已定稿的行，**只增不改**（同一个数组引用） |
| `tail()` | 未定稿的尾巴（0~2 行） |
| `version()` | 每次变化自增，用来触发重绘 |
| `frozen` | 已冻结的行数 |
| `stats` | 各层计数器，O(1) 回归测试就靠它 |

### 为什么能 O(1)

四个环节各自定死了边界，缺一不可：

1. **增量折行（`LineBuffer`）** —— 定稿边界是「最后一个空格之前」。
   `Bun.wrapAnsi` 的 `placeWord`（`src/jsc/bindings/wrapAnsi.cpp:570`）在
   `wordLen > columns` 时会走 hard wrap 填满当前行，所以**正在增长的词会翻转
   它自己的落位决策**，连倒数第二行都不安全。只有「词边界之前」是确定性的。
2. **增量 markdown（`MarkdownStream`）** —— 块状态机逐行定稿；未闭合的
   `**bold` 只进 volatile，闭合后整段 `Bun.markdown.render` 重渲染（摊销 O(1)）。
3. **增量布局** —— `Box.frozen` + `childrenRevSum`。父容器用 O(1) 判断
   「只有最后一段内容在增长」，于是只重建尾部。
4. **视口窗口** —— 每帧只复制可视行（O(视口)），不是 O(总行数)。

### 一个反直觉的结论：不要用 `<For>` 渲染流

直觉方案是 `<For each={lines}>` 一行一个 `<text>`。实测 **Solid 的 `For` 每次
都会对数组做 O(N) 的 reconcile**：

```
N=100   → 0.09 ms/push
N=9000  → 4.40 ms/push
```

（`createStore(..., { shallow: true })` 能让它变成常数，但 shallow store 的子
数组不再被代理，`push` 根本不触发更新 —— 那是假象，别用。）

所以 `@butui/stream` 用**一个 `<stream>` 节点**：Solid 侧每次 push 只产生一次
`setProp`，布局侧只把新增行转成 cell。这才是真正的 O(1)，而且仍然是细粒度的
—— 变化被限制在一个属性上，不重建任何子树。

## 事件协议驱动的 agent UI

SPEC §13 的协议是主干：**UI 不读 agent 内部状态，只消费事件；UI 不调 agent
方法，只发命令。** 这样 WebUI / remote attach / 回放 / 测试注入都只是「换个
传输层」。

```ts
import { createSession, decodeNdjson, encodeNdjson, AgentView } from "@butui/agent";

const session = createSession({
  width: () => 80,
  onCommand: command => transport.write(encodeNdjson(command)),   // UI → Agent
});

// Agent → UI（NDJSON over stdio / WebSocket / 测试注入）
for (const event of decodeNdjson(chunk)) session.dispatch(event);

<AgentView session={session} />
```

数据模型（Message / Turn / ToolCall / Checkpoint / Branch / Artifact）严格对齐
SPEC §7；`reduce(state, event)` 是纯函数，所以**同一串事件必然推导出同一状态**。

内置组件（SPEC §10.2）：`MessageList` / `MessageView` / `ToolCard` /
`TodoPanel` / `PermissionDialog` / `AskUserForm` / `CheckpointMarker` /
`UndoPreviewPanel` / `BranchTree` / `StatusBar`，以及组合好的 `AgentView`。

每个组件都把语义标识打在根节点上（SPEC §4.2），所以鼠标点击拿到的是
`message:<id>` / `tool:<callId>` / `checkpoint:<id>`，不是行号：

```
tests/agent-replay.test.tsx
  同一段录制回放两次 → 逐字节相同的界面
  语义标识覆盖 message / tool / todo / permission / undo / status
```

## 分支式 Undo（SPEC §8）

Undo 不是 Ctrl+Z。buTUI 自己持有工作区变更日志，所以**预览是本地算出来的**，
不需要 agent 告诉 UI「会影响什么」：

```ts
// 工具执行器报告它改了什么（走事件协议，因此可回放）
session.dispatch({
  type: "tool.result",
  callId: "c1",
  result: { status: "success", workspace: [{ path: "src/auth.ts", before, after }] },
});

// 点击消息 → 预览
const plan = session.requestUndoPreview(messageId, fs.read);
// → Messages: 2 条 / Files: 2 个 / Todo: 回滚 / Irreversible: npm publish / Conflicts: 1 个

// 确认
session.undo(messageId, "branch", fs);   // 只切分支，不动工作区
session.undo(messageId, "revert", fs);   // 反向 patch 工作区
```

四个硬保证：

1. **不删历史**（§8.2）。`branch` 模式从目标之后开新分支，原分支完整保留；
   `visibleMessages()` 按祖先链 + `fromMsgId` 过滤出当前分支可见的消息。
2. **冲突就不写**（§8.4）。revert 是全有或全无：任何文件与记录的 `afterHash`
   对不上，一个文件都不写，并抛 `revert.conflict`。
3. **链式修改只校验最后一次**。`v1→v2→v3` 里拿 c1 的 `afterHash(v2)` 比当前
   内容必然误报；只有每个文件最后一次改动的 hash 该跟磁盘比，中间态在应用
   过程中用暂存内容逐级校验。
4. **不可逆操作显式列出**（§8.5）。`git push` / `npm publish` / `curl -X POST`
   / `rm -rf` 会被识别，撤销时跳过并提示，而不是假装撤销成功。

patch 用的是**编辑脚本**而不是 unified diff 文本：

```ts
{ at, remove: string[], insert: string[] }   // 可逆是结构性的，应用时自带上下文校验
```

`tests/undo-patch.test.ts` 用 300 轮随机文本验证两个方向都能精确还原。

## 快速开始

```bash
bun install

bun test

# agent demo（需要真实终端）
bun --conditions=browser run examples/agent-demo/src/main.ts

# 流式基准
bun --conditions=browser run scripts/stream-bench.tsx

# 纯文本快照
bun --conditions=browser run scripts/snapshot.tsx 72 22
```

Demo 操作：打字 → `Enter` 发送 → `Tab` 切焦点 → 鼠标点消息展开 action bar →
点 `[u] undo` 看预览 → `Ctrl+U` 对最后一条消息做 undo 预览 →
权限弹窗按 `y`/`n` → `Ctrl+C` 退出。

Demo 的工作区是**内存实现**，但走的是完全一样的 journal / diff / patch 路径。

## 包

| 包 | 职责 |
|---|---|
| `@butui/core` | 节点树、`rev` 失效传播、`childrenRevSum`、focus、事件冒泡、theme、ANSI 解析 |
| `@butui/solid` | `@solidjs/universal` host ops、JSX 类型、Bun 编译插件 |
| `@butui/agent` | 事件协议（NDJSON）、Session reducer、SPEC §10.2 组件 |
| `@butui/undo` | 工作区变更日志、行级 patch、undo 预览与执行（SPEC §8） |
| `@butui/stream` | 增量折行、增量 markdown、Solid 绑定与组件 |
| `@butui/layout` | flex 子集 → cell 网格，带 `frozen` 的增量合成与视口窗口 |
| `@butui/renderer` | cell → ANSI，逐行差分 + SGR 状态机 |
| `@butui/terminal` | raw mode、备用屏、输入解码、能力探测 |
| `@butui/test` | headless render、快照、事件注入 |

## 必须知道的坑

### 1. `--conditions=browser` 是强制的

`solid-js@2.0.0-rc.9` 的 exports map 里 `node` / `deno` / `worker` 条件都指向
`dist/server.js`（SSR，无客户端响应式），只有 `browser` 指向 `dist/solid.js`。
Bun 默认命中 `node` 条件 → **不报错但 signal 更新毫无反应**。

已排除：`bunfig.toml` 不支持 `conditions`；Bun 插件 `onResolve` 对 bare
specifier 不生效；`.env` 里的 `BUN_OPTIONS` 时机太晚。

```bash
bun --conditions=browser run src/main.ts
BUN_OPTIONS="--conditions=browser" bun run src/main.ts
```

`@butui/solid` 启动时用 `import.meta.resolve("solid-js")` 检查，命中 server
构建直接抛错。

### 2. `bun test` 的 preload 要单独配

```toml
preload = ["@butui/solid/preload"]        # 只作用于 bun run

[test]
preload = ["@butui/solid/preload"]        # bun test 需要这一份
```

### 3. Solid 2 的 signal 写入延迟到 flush

```ts
setText(text() + "a");
setText(text() + "b");
flush();   // → "b"，第一个字符被吞
```

对 TUI 就是**快速输入丢字符**。累加型状态一律用 updater：`setText(p => p + "a")`。
`tests/solid-signal-contract.test.ts` 钉住了这组行为。

### 4. Solid 2 的 store setter 是 draft 风格

```ts
setStore(s => { s.lines.push(line); });   // 不是 setStore("lines", i, v)
```

### 5. 非响应式的 getter 会让 `<Show>` 卡死

懒创建的资源（比如「消息先建、stream source 后建」）如果用普通 Map 存，
`<Show when={getSource(id)}>` 永远停在第一次求值的结果上。要么把资源放进
store，要么配一个版本信号让调用方建立依赖（`@butui/agent` 用的是后者）。

### 6. 读 store 必须在 setter **内部**

Solid 2 的写入延迟到 flush，所以「先 `setState` 再读 `state`」拿到的是旧快照：

```ts
setState(s => { s.calls.push(call); });
const call = state.calls.find(...);        // ← 查不到！
```

`@butui/agent` 里 `tool.result` 要把 workspace 变更记到对应的 tool call 上，
第一版就是在 setter 外面查的，结果 journal 里的 `turnId` 全是空串。

### 7. 在响应式 root 外部批量注入事件后要 `settle()`

```ts
for (const event of events) session.dispatch(event);
// 此时 state 还是空的 —— 写入延迟到 flush
session.settle();          // 提交
```

回放、快照、测试注入都属于这种场景。

## 编译管线

`@butui/solid/plugin` 实现 SPEC §5.3：

```ts
Bun.plugin(onLoad)
  → @solidjs/compiler.transform({ generate: "universal", moduleName: "@butui/solid" })
  → Bun.Transpiler({ loader: "ts" })   // 编译器不剥 TypeScript，要补一刀
```

已知限制：universal 模式下 **JSX 属性值不能是 JSX 元素/Fragment**
（`packages/compiler/src/universal/transform.rs:620,780`）。

## 依赖的 Bun 主线 API

| 能力 | API |
|---|---|
| 显示宽度（CJK / emoji / ANSI） | `Bun.stringWidth` |
| ANSI 感知折行 | `Bun.wrapAnsi(s, cols, { hard, wordWrap, trim })` |
| ANSI 感知截断 | `Bun.sliceAnsi` |
| Markdown → 终端 | `Bun.markdown.ansi(s, { columns, colors })` |
| Markdown → 语义节点 | `Bun.markdown.render(s, callbacks)`（22 个元素回调） |
| 颜色 | `Bun.color(x, "ansi-256" \| "ansi-16m")` |
| 图片解码 / 缩放 | `Bun.Image`（**无 raw pixel 出口**，sixel/half-block 要自带解码） |
| PTY | `Bun.Terminal` + `Bun.spawn({ terminal })` |
| raw mode / resize | `process.stdin.setRawMode` / `SIGWINCH` |
| grapheme 切分 | `Intl.Segmenter` |

## markdown 流式渲染的明确取舍

- **不支持 setext 标题**（`===` / `---` 下划线式）：它需要回溯整个段落，与
  流式语义冲突。请用 `#`；裸 `---` 按分隔线处理。
- **表格按块关闭时整块渲染**：块内成本 O(块) 而非 O(1)。表格通常很短。
- **缩进代码块（4 空格）不识别**：请用围栏。

## 还没做

- `@butui/undo`：checkpoint / branch / revert 的**执行**（SPEC §8）——
  协议与展示已经就位，缺的是 workspace patch / conflict 检测
- `@butui/web`：复用同一套事件协议（§13 已就绪，只差 DOM adapter）
- 事件协议（SPEC §13 NDJSON）与 `@butui/web` adapter
- 图片子系统（SPEC §12）：Kitty / iTerm2 好做，sixel 需要补 PNG 解码
- 虚拟列表、动画、Kitty keyboard protocol 的发送侧
- `markdown` / `code` / `image` 三个 intrinsic element 目前只有类型，没有实现
