# buTUI

> 面向 coding agent 的 Agent UI Runtime。设计文档见 [SPEC.md](./SPEC.md)。

当前状态：**M1/M2 骨架 + 流式渲染 O(1) + 事件协议驱动的 agent UI +
分支式 Undo + WebUI remote attach + 图片子系统（Kitty / iTerm2 / Sixel /
半块 / 占位符）+ Artifact Canvas + 列表 / 虚拟列表 + 滚动视口已跑通**，
`bun test` 369 个用例全绿。

```
应用（你的 agent / 工具 / TUI）
  → @butui/runtime  (createTuiApp：终端 + 合帧重绘 + 事件分发)
    → @butui/solid  (13 个 host ops，Solid 自带 reconciler)
      → @butui/core (节点树 / 失效传播 / focus / 事件冒泡 / theme / ANSI 解析)
        → @butui/layout   (flex 子集 + 增量合成 + 视口窗口)
          → @butui/renderer (cell buffer + 逐行差分 + SGR 状态机)
            → @butui/terminal (raw mode / resize / 输入解码 / 能力探测)
              → 终端 ANSI

按需叠加：
  @butui/components  编辑器模型 + Input + 选择模型 + List / VirtualList + 滚动视口
  @butui/stream  增量折行 + 增量 markdown（O(delta) 定稿）
  @butui/image   Kitty / iTerm2 / Sixel / 半块 / 占位符 + 安全加载
  @butui/agent   事件协议 + Session + SPEC §10.2 组件 + Artifact Canvas
  @butui/undo    workspace 日志 + 行级 patch + 分支式 undo
  @butui/web     DOM 渲染（实验层，复用同一份 Session / 事件协议）
```

## 拿 buTUI 画 TUI

```tsx
import { createTuiApp } from "@butui/runtime";

const app = createTuiApp({
  view: runtime => (
    <box border padding={1}>
      <text>hello {runtime.size().columns}×{runtime.size().rows}</text>
    </box>
  ),
});
```

终端、备用屏、raw mode、重绘调度、resize、tab 焦点、鼠标 hit test、ctrl+c
退出全在 `createTuiApp` 里。**不需要自己调 paint** —— 任何节点变更（signal、
定时器、异步加载）都会自动合并到下一帧。

接口契约（哪些稳定、怎么演进、已知缺口）见 **[STABILITY.md](./STABILITY.md)**。

## 列表 / 虚拟列表

```tsx
import { createSelection, VirtualList } from "@butui/components";

const sel = createSelection({ count: () => filtered().length });

<VirtualList
  items={filtered()}
  selection={sel}
  height={12}
  renderItem={item => <text>{item}</text>}
  onActivate={item => open(item)}
/>
```

上下键 / Home / End / PageUp / PageDown / Ctrl+P,N 移动选择，滚轮移动选中项，
点击即选中，`Enter` 激活 —— 应用不用自己写这套。`height` 给了就裁剪 + 跟随
滚动；不给就全渲染、交给父容器滚。

**保证：`<VirtualList>` 的节点数 = 视口行数，与总条数无关。** 窗口平移时
Solid 2 的 `<Repeat count from>` 复用重叠区间的节点，所以「往下滚一行」是
建一行 + 销毁一行；10 万条的列表和 10 条的列表建一样多的节点（测试里断言
过）。这是 SPEC §5.7 那条 O(1) 在列表上的对应物。

`<List>` 是同一份实现但不裁剪（几十行的菜单）；`<VirtualList>` 只是名字更
直白。行内容请写成 `renderItem={item => ...}`，`state.selected()` 是访问器。

## 滚动视口（聊天式转录）

```tsx
import { createScrollView } from "@butui/components";

const view = createScrollView();
createTuiApp({
  view: () => <box>{lines().map(line => <text>{line}</text>)}</box>,
  scroll: view,                            // 可调用 → 直接当选项传
  stickyBottom: 1,                         // 最后一行固定（状态栏）
  afterDraw: frame => view.measure(frame), // 每帧收回真实位置
  onKey: event => view.handleKey(event),   // ↑↓ PageUp/PageDown Home End
  onMouse: event => view.handleWheel(event),
});
```

**保证：** 贴底时新内容自动跟着走（`scroll()` 返回 `"bottom"`，不需要任何
通知）；用户往回翻之后新内容**不会**把视口拽回去；滚回底部自动恢复跟随。
这是聊天式 UI 最常写错的一处，所以收进底层（SPEC §5.13）。

固定页眉 / 页脚用 `stickyTop` / `stickyBottom`（取内容的前 / 后 N 行）——
`<layer>` 做不到，因为它相对父节点定位，父节点自己会被滚走。

`bun --conditions=browser run scripts/scroll-demo.tsx` 可以直接看这个行为。

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

## 图片子系统（SPEC §12）

五条路径全部落地，按 §12.1 的优先级自动选：

```tsx
import { Image, ImageLayer, createImage } from "@butui/image";

const layer = new ImageLayer();
const shot = createImage(() => "./shots/a.png", {
  layer,                 // 原生协议：图形由图层叠加
  policy: { roots: ["./shots"] },
  cols: 40,
  alt: "screenshot",
});

<Image source={shot} width={40} />
```

管线把重活全交给 `Bun.Image`，TS 只碰小图：

```text
Bun.Image 解码 + SIMD 缩放 + PNG 编码
  → decodePng（TS：PNG → RGBA）
  → 协议编码器（纯函数）
  → <image> 节点（cell 协议）或 ImageLayer（原生协议）
```

| 路径 | 协议 | 产物 | 谁画 |
|---|---|---|---|
| cell | half-block | ANSI 行（`▀` + 24bit fg/bg） | 布局 + 渲染器差分 |
| cell | 占位符 | 纯文本框 + alt | 同上，NO_COLOR 兜底 |
| 原生 | Kitty | 分块 base64 PNG | 终端，`ImageLayer` 摆放 |
| 原生 | iTerm2 | OSC 1337 | 同上 |
| 原生 | Sixel | 6×6×6 调色板 + RLE | 同上 |

**每帧成本与图片大小无关**：布局只在占位 cell 上盖一个 `graphic` id，
`ImageLayer` 扫帧聚成矩形，只有矩形所在行被重绘时才重发序列。实测无变化帧
写出 **0 字节**。

```bash
bun --conditions=browser run scripts/image-demo.tsx
```

```text
协议        box(cell)  负载        说明
kitty       40×10      24.5 KiB    320×160 PNG（真彩）
iterm2      40×10      24.5 KiB    同一张 PNG，换 OSC 1337 包装
sixel       40×10      21.5 KiB    固定调色板 + 行程编码
halfblock   40×10      —           10 行 ANSI，每 cell 两个像素
placeholder 40×10      —           纯文本
```

`quantize: true` 用 256 色调色板 PNG，同一张图 24.5 → 10.2 KiB。

安全（§12.3）：路径走白名单 + `realpath`（symlink 逃逸拦下）、MIME 只看魔数、
`maxBytes` 读前检查 + 远程流式超限中断、`maxPixels` 防解压炸弹、远程默认关闭
且需要逐次授权。**绝不把用户可控字符串交给 `new Bun.Image(path)`**（任意文件
读取原语）。

## Artifact Canvas（SPEC §11.1）

差异化的点不是「能画图」，而是把 **diff / 日志 / 表格 / JSON / 图表 / 图片**
收敛成同一个一等公民：都来自 tool result、都挂在 tool call 上、都能 pin / 展开 /
复制 / 并排比较 / 在 WebUI 打开 / 跟着回放重放。

```tsx
const layer = new ImageLayer();
<ArtifactCanvas
  artifacts={session.state.artifacts}
  session={session}                     // [open] → artifact.open 命令
  compare                               // pin 两张 → 左右并排
  renderers={{ image: artifactImageRenderer({ layer, width: 36 }) }}
/>
```

```bash
bun --conditions=browser run scripts/artifact-demo.tsx 64 60
```

```text
± diff   1 增 / 2 删 · --- a/src/auth.ts   ← tool:edit
▤ log    wrote src/auth.ts                 ← tool:edit
▦ table  5 行 · N push flush paint         ← tool:bench
▁▄█ chart 10 个数据点                       ← tool:perf
{} json  {"model":"solid-2-rc",…}          ← tool:cfg
🖼 image ./shots/stream-o1.png（image/png）
```

设计要点：

- **从 tool result 直接生成**：reducer 在 `tool.result` 时推导 artifact
  （workspace 变更 → diff，其余按内容分类）。时间戳取自 tool call 而不是
  `Date.now()`，所以回放两次状态逐字节一致。
- **内容有界**：折叠 6 行 / 展开 200 行，超出明确提示还剩多少行。
- **渲染器注入**：`@butui/agent` 不依赖 `@butui/image`（图片解码要用 Bun 内建，
  会炸掉 browser 打包）。TUI 注入 `artifactImageRenderer`，WebUI 注入 `<img>`，
  不注入就是纯文本占位。
- **独立面板**：不在对话流里；demo 里是宽终端（≥100 列）下的右侧栏。
- **两套渲染共用纯函数**：diff 解析 / 表格对齐 / sparkline 在 `artifact-model.ts`，
  TUI 渲染成 cell，WebUI 渲染成 DOM，语义标识完全一致。

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
`UndoPreviewPanel` / `BranchTree` / `StatusBar` / `ReasoningLine` /
`ContextMeter`，以及组合好的 `AgentView`。

用量走 `{ type: "usage" }` 事件 → `session.state.usage`（`input`/`output`/
`cached` 是会话累计，`contextTokens`/`contextWindow` 是最近一次报告的上下文
占用）；思考走 `session.reasoningFor(turnId)`，**turn 结束就丢**（思考是临时
产物，不该撑爆上下文）。两者都见 SPEC §5.14。

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

## TUI / WebUI 共享协议，不共享组件

SPEC §2.2 的主张是「终端和 WebUI 共用业务状态与事件协议」，§3 又明确把
「把 TUI 和 WebUI 强行做成同一套组件代码」列为非目标。`@butui/web` 验证了这条：

```
                 ┌─────────────────┐
   AgentEvent ──▶│  @butui/agent   │◀── UiCommand
                 │  Session/reducer│
                 └────────┬────────┘
                          │ 同一份状态
              ┌───────────┴───────────┐
              ▼                       ▼
      @butui/solid (cell)     @butui/web (DOM)
      generate: universal     generate: dom
```

同一个 Session 挂两套渲染，`tests/web-ui.test.tsx` 直接断言两边暴露的语义标识
一致（`message:m1` / `tool:c1` / `todo:panel` / `status:bar`）。

编译上靠**路径区分目标**：

```ts
Bun.plugin(butui({
  targets: [
    { include: /packages\/web\/.*\.tsx$/, generate: "dom", moduleName: "@solidjs/web" },
    // 其余回落 universal + @butui/solid
  ],
}));
```

WebUI 的 `.tsx` 文件要加 `/** @jsxImportSource @solidjs/web */`，否则会被
根 tsconfig 的 `jsxImportSource: "@butui/solid"` 类型检查成 `box`/`text`。

### Remote attach demo

```bash
bun run web          # → http://localhost:3210
```

服务端只做两件事：跑 agent、把事件写成 NDJSON 流；它不认识任何 UI。浏览器侧
不到 30 行：建 Session、连流、把 UiCommand POST 回去。多个客户端连同一个流会
收到同一份事件（`tests/web-remote.test.ts` 真的起服务 + 连流 + POST 命令验证）。

```ts
const response = await fetch("/events");
const reader = response.body!.getReader();
const decode = createNdjsonDecoder<AgentEvent>();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  for (const event of decode(text.decode(value, { stream: true }))) session.dispatch(event);
}
```

## 快速开始

```bash
bun install

bun test

# agent demo（需要真实终端）
bun --conditions=browser run examples/agent-demo/src/main.tsx

# 流式基准
bun --conditions=browser run scripts/stream-bench.tsx

# 图片子系统自检（不需要真终端）
bun --conditions=browser run scripts/image-demo.tsx

# Artifact Canvas 快照
bun --conditions=browser run scripts/artifact-demo.tsx 64 60

# WebUI（remote attach demo）
bun run web

# 把 WebUI 渲染成 HTML
bun --conditions=browser run scripts/web-snapshot.tsx

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
| `@butui/runtime` | `createTuiApp`：终端、合帧重绘、事件分发 —— 应用作者的唯一入口 |
| `@butui/components` | `createTextEditor`、`<Input>`、`createSelection`、`<List>` / `<VirtualList>`、`createScrollView` |
| `@butui/agent` | 事件协议（NDJSON）、Session reducer、SPEC §10.2 组件、Artifact Canvas |
| `@butui/undo` | 工作区变更日志、行级 patch、undo 预览与执行（SPEC §8） |
| `@butui/web` | WebUI：ANSI→HTML、DOM 组件、`mountWebUI`（复用同一个 Session） |
| `@butui/stream` | 增量折行、增量 markdown、Solid 绑定与组件 |
| `@butui/image` | 协议探测、PNG 编解码、Kitty/iTerm2/Sixel/半块/占位符、安全加载、图形图层 |
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

同一个坑的另一副面孔：**`<Repeat>` 的行内容必须走访问器**。`<Repeat count from>`
只在 `count` / `from` 变化时重跑 mapping，`items` 换了但长度没变时它一行都不
重建 —— 写成 `renderItem(items[i])`（创建时快照）会让「同长度的过滤结果」显示
成上一批数据。`<List>` 内部读的是 `items()[index]`，见 SPEC §5.12。

### 6. 读 store 必须在 setter **内部**

Solid 2 的写入延迟到 flush，所以「先 `setState` 再读 `state`」拿到的是旧快照：

```ts
setState(s => { s.calls.push(call); });
const call = state.calls.find(...);        // ← 查不到！
```

`@butui/agent` 里 `tool.result` 要把 workspace 变更记到对应的 tool call 上，
第一版就是在 setter 外面查的，结果 journal 里的 `turnId` 全是空串。

### 7. Solid 2 的 `createEffect` 需要**两个**参数

```ts
createEffect(() => signal(), value => doWork(value));
```

单参数在 prod 构建里会抛 `undefined is not an object (evaluating 't.effect')`，
而且会让整个响应式 root `[REACTIVITY_HALTED]`。

### 8. 在响应式 root 外部批量注入事件后要 `settle()`

```ts
for (const event of events) session.dispatch(event);
// 此时 state 还是空的 —— 写入延迟到 flush
session.settle();          // 提交
```

回放、快照、测试注入都属于这种场景。

### 9. `Bun.deflateSync` / `inflateSync` 默认是 **raw deflate**

`bun-types` 文档说 `windowBits: 15` 会输出带 zlib 头的流，但 1.4.2 实测参数被
忽略，永远输出 raw deflate；`Bun.inflateSync` 反过来默认按 raw 解，喂 zlib 流
会报 `invalid stored block lengths`。要跟外部格式（PNG 的 IDAT 就是 zlib 流）
对齐就得自己拼/拆：

```ts
// 压缩：0x78 0x9c + raw deflate + Adler-32 大端
const zlib = zlibCompress(raw);            // @butui/image

// 解压：显式 zlib 模式
Bun.inflateSync(zlibStream, { windowBits: 15 });
```

### 10. 增量布局的 `frozen` 需要 `frozenToken` 兜底

父容器复用子节点「已冻结前缀」时，必须能 O(1) 确认那段前缀真的没变。`<stream>`
用 `lines` 数组本身当凭证；`<image>` 声明 `frozen: 0`（图片是全有全无的叶子）。
少了这个凭证，「先布局 → 改属性 → 再布局」会稳定读到上一帧内容。

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
| 图片解码 / 缩放 / 编码 | `Bun.Image`（**无 raw pixel 出口** → 编码成 PNG 后自己解析） |
| PNG 的 zlib 层 | `Bun.deflateSync` / `Bun.inflateSync`（注意默认是 raw deflate，见坑 9） |
| CRC32 | `Bun.hash.crc32`（PNG 块校验） |
| PTY | `Bun.Terminal` + `Bun.spawn({ terminal })` |
| raw mode / resize | `process.stdin.setRawMode` / `SIGWINCH` |
| grapheme 切分 | `Intl.Segmenter` |

## markdown 流式渲染的明确取舍

- **不支持 setext 标题**（`===` / `---` 下划线式）：它需要回溯整个段落，与
  流式语义冲突。请用 `#`；裸 `---` 按分隔线处理。
- **表格按块关闭时整块渲染**：块内成本 O(块) 而非 O(1)。表格通常很短。
- **缩进代码块（4 空格）不识别**：请用围栏。

## 还没做

- `@butui/components` 继续长（现在有 Input / List / VirtualList / 滚动视口；
  Select / Table / Tree 待做）
- CommandPalette / ToolGraph / AgentTimeline（§10.2 剩余组件；命令面板用
  `<Input onKey={e => sel.handleKey(e)}>` + `<List>` 组合就够，不必再包一层）
- 编辑器还缺选区 / 剪贴板历史 / 撤销栈；列表只支持单列 + 固定行高
- Artifact Canvas：artifact 的持久化（现在只在 Session 内存里）、WebUI 侧的服务端图片路由
- 图片子系统：半块图的终端背景透出、Kitty 图片随滚动的位置缓存
- 动画、Kitty keyboard protocol 的发送侧
- `flexShrink` 没实现：row 里只有显式 `truncate` / `wrap={false}` 的 text 会让位
- `markdown` / `code` / `image` 三个 intrinsic element 目前只有类型，没有实现
