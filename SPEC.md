# buTUI 0.1 Agent-First Spec

状态：Draft  
日期：2026-09-23  
目标读者：buTUI 设计者、buTUI 实现者、bugent / buagent 维护者

---

## 1. 定位

buTUI 不是一个通用 TUI 框架的复制品，也不是 OpenTUI 的替代品。

buTUI 的目标是：

> **面向 coding agent 的 Agent UI Runtime。**

它优先服务以下对象：

- 对话消息
- turn
- reasoning
- tool call
- tool result
- todo
- checkpoint
- undo / branch
- permission
- artifact
- context / token
- 多 agent

终端布局、ANSI、鼠标、键盘、滚动和动画只是底层能力。  
buTUI 的真正差异点在于：**agent 事件是一级 UI 对象。**

---

## 2. 核心目标

### 2.1 产品目标

让 agent 的工作过程可以被：

- 看见
- 点击
- 展开
- 回放
- 撤销
- 分支
- 比较
- 审查
- 分享给 WebUI / remote client

### 2.2 技术目标

- Bun-first
- TypeScript-first
- SolidJS 2 RC
- 默认零 native core
- 终端和 WebUI 共用业务状态与事件协议
- 允许未来替换 renderer 或增加 Rust backend
- 可测试、可回放、可远程 attach

---

## 3. 非目标

v0.1 不做：

- 通用浏览器级布局
- 完整 CSS
- 任意 HTML 渲染
- 多窗口 OS
- 视频播放
- 完整 widget 生态
- 一开始就做 Zig native core
- 把 TUI 和 WebUI 强行做成同一套组件代码

---

## 4. 设计原则

### 4.1 Agent-first

消息、工具、checkpoint、分支和权限必须是结构化节点，不是字符串行。

### 4.2 语义 hit test

点击不能只得到行号，必须得到：

```text
message:<id>
tool:<callId>
checkpoint:<id>
artifact:<id>
```

### 4.3 追加式历史

历史尽量只追加，不原地修改。  
Undo 优先创建分支或写入 undo event，而不是删除旧历史。

### 4.4 渐进增强

图片、鼠标、动画、truecolor、Kitty keyboard 都不是硬依赖。  
不支持时要有纯文本和键盘降级路径。

### 4.5 不 fork Solid 核心

使用官方 SolidJS 2 包。  
buTUI 只实现 `@solidjs/universal` 的 host ops。

---

## 5. 技术底座

### 5.1 Bun

使用：

- `Bun.stringWidth`
- `Bun.wrapAnsi`
- `Bun.markdown.ansi`
- `Bun.color`
- Bun stdin / stdout
- raw mode
- `SIGWINCH`
- Bun plugin / preload
- 可选 Bun FFI

### 5.2 SolidJS 2 RC

精确锁版本，不使用浮动的 `latest` / `next`：

```json
{
  "dependencies": {
    "solid-js": "2.0.0-rc.9",
    "@solidjs/universal": "2.0.0-rc.9",
    "@solidjs/compiler": "2.0.0-rc.9",
    "@solidjs/web": "2.0.0-rc.9"
  }
}
```

可选 JS fallback：

```json
{
  "devDependencies": {
    "@solidjs/babel-plugin": "2.0.0-rc.9"
  }
}
```

### 5.3 TUI 编译

```ts
transform(source, {
  filename: "App.tsx",
  generate: "universal",
  moduleName: "@butui/solid"
});
```

### 5.4 WebUI 编译

```ts
transform(source, {
  filename: "App.tsx",
  generate: "dom",
  moduleName: "@solidjs/web"
});
```

### 5.6 实现约束（2026-09-23 实测补充）

以下四条是 M1 落地时实测出来的硬约束，与 §5.1~§5.4 同等重要。

**5.6.1 必须用 `--conditions=browser` 运行**

`solid-js@2.0.0-rc.9` 的 exports map 里 `node` / `deno` / `worker` 条件都指向
`dist/server.js`（SSR，无客户端响应式），只有 `browser` 条件指向 `dist/solid.js`。
Bun 默认命中 `node` 条件，结果是**不报错但 signal 更新毫无反应**。

已排除的方案：`bunfig.toml` 不支持 `conditions`；Bun 插件的 `onResolve` 对 bare
specifier 不生效；`.env` 中的 `BUN_OPTIONS` 时机太晚。

可用方案：

```bash
bun --conditions=browser run <entry>
BUN_OPTIONS="--conditions=browser" bun run <entry>
```

`@butui/solid` 启动时用 `import.meta.resolve("solid-js")` 检查，命中 server 构建
直接抛错，避免静默失效。

**5.6.2 `bun test` 的 preload 需要单独声明**

```toml
preload = ["@butui/solid/preload"]        # 只作用于 bun run

[test]
preload = ["@butui/solid/preload"]        # bun test 需要这一份
```

**5.6.3 Solid 2 的 signal 写入延迟到 flush**

Solid 1 的 signal 写入立即生效；Solid 2 RC 推迟到 flush。因此同一 tick 内的
「读-改-写」会丢更新：

```ts
setText(text() + "a");
setText(text() + "b");
flush();   // → "b"，第一个字符被吞
```

对 TUI 而言这就是**快速输入丢字符**。buTUI 约定：累加型状态一律使用 updater：

```ts
setText(prev => prev + "a");
```

**5.6.4 编译管线是两段式**

`@solidjs/compiler` 只做 JSX → host ops 改写，**不剥 TypeScript**。必须在
`onLoad` 里补一刀：

```ts
transform(source, { generate: "universal", moduleName: "@butui/solid" })
→ new Bun.Transpiler({ loader: "ts" }).transformSync(code)
```

另外 universal 模式下 **JSX 属性值不能是 JSX 元素/Fragment**
（`packages/compiler/src/universal/transform.rs:620,780`），
`<Box header={<Text/>}/>` 会编译失败，需要包成组件或改用 children。

**5.6.5 host ops 只有 13 个，不需要自己写 reconciler**

`@solidjs/universal` 的 `createRenderer` 已包含 `insert` / `spread` /
`reconcileArrays` / `cleanChildren` 的全部逻辑。buTUI 只需实现：

```text
createElement  createTextNode  createSentinel  replaceText  isTextNode
setProperty    insertNode      removeNode      getParentNode
getFirstChild  getNextSibling  cleanupNodes?
```

§5.5「不从 OpenTUI 复制 reconciler」因此升级为「不需要 reconciler」。

**5.6.5b Solid 2 的 store setter 改成了 draft 风格**

```ts
setStore(s => { s.lines.push(line); });   // 不是 setStore("lines", i, v)
```

旧签名会直接抛 `t is not a function`。

**5.6.6 Bun 侧缺口**

- `Bun.Image` 没有 raw pixel 出口 → Kitty / iTerm2 协议可直接用，sixel 与
  half-block 降级路径需要自带 PNG 解码（`Bun.inflateSync` 可用）
- 鼠标 SGR 解析、Kitty keyboard protocol、focus events、bracketed paste、
  终端能力探测全部需要自己实现（`@butui/terminal` 已实现）
- `Bun.Terminal`（PTY）可用于 PTY 冒烟与回放测试

---

### 5.7 流式渲染 O(1) 契约（v0.1 实现）

§9.5「动画只在需要时运行」和 §17「流式输出不整屏闪烁」在实现时收敛成一条
硬契约：

> 每条 delta 的处理成本是 `O(|delta| + W)`（W = 折行宽度），与已累积长度 N 无关。

四个环节各自定死边界，缺一不可：

1. **增量折行**：定稿边界是「最后一个空格之前」。注意 `Bun.wrapAnsi` 的
   `placeWord`（`src/jsc/bindings/wrapAnsi.cpp:570`）在 `wordLen > columns` 时
   走 hard wrap 填满当前行，**正在增长的词会翻转它自己的落位决策**，所以
   「折出 ≥2 行就定稿前面的行」是错的。
2. **增量 markdown**：块状态机逐行定稿；未闭合的 `**bold` 只进 volatile，
   闭合后整段 `Bun.markdown.render` 重渲染（摊销 O(1)）。
3. **增量布局**：节点增加 `childrenRevSum`（子节点 rev 之和，O(1) 判断前缀
   是否未变），`Box` 增加 `frozen`（前 N 行永不再变）。父容器据此只重建尾部。
4. **视口窗口**：每帧只复制可视行。

**明确不用 `<For>` 渲染流。** 实测 Solid 的 `For` 每次都对数组做 O(N)
reconcile（N=9000 时 4.4 ms/push）。`createStore(..., { shallow: true })` 能让
它变常数，但 shallow store 的子数组不再被代理、`push` 不触发更新，是假象。

改用**单个 `<stream>` 节点** + 只增不改的 `lines` 数组：Solid 侧每次 push 只
产生一次 `setProp`，布局侧只转换新增行。这是真正的 O(1)，且仍然是细粒度的
—— 变化被限制在一个属性上，不重建任何子树。

实测（`scripts/stream-bench.tsx`）：N=100 → 0.051 ms/delta，N=9000 →
0.021 ms/delta；markdown N=50 → 0.062 ms/delta，N=6000 → 0.041 ms/delta。

**已知取舍**（markdown 流）：不支持 setext 标题（需要回溯整个段落）；
表格按块关闭时整块渲染；不识别缩进代码块。

---

### 5.8 事件协议落地（v0.1 实现）

§13 的协议已实现为 `@butui/agent`：

- `protocol.ts`：SPEC §7 数据模型 + §13 事件/命令 + **NDJSON 编解码**
  （增量解码器保留不完整行，坏行包成 `error` 事件不阻塞流）。
- `session.ts`：`reduce(state, event)` 是纯函数（原地改 draft），状态只由事件
  推导 —— 回放 / 测试注入 / remote attach 都成立。
- `components.tsx`：SPEC §10.2 组件 + 组合好的 `AgentView`，每个都带
  `message:<id>` / `tool:<callId>` / `permission:<id>:allow` 这类语义标识。

两条实现注意：

1. **流式文本不进 reducer**。`text.delta` 的字符串累积是 O(N)，放进 store 会让
   每条 delta 变成 O(N)；文本交给 `@butui/stream`，reducer 只建消息、标
   `streaming`，`turn.end` 时回填最终文本。
2. **懒创建的资源必须暴露响应性**。消息由 `tool.start` 建、stream source 由
   `text.delta` 懒建，`sourceFor()` 读普通 Map 没有响应性，`<Show>` 会一直停在
   fallback 上（表现为 markdown 以原文显示）。`@butui/agent` 用一个版本信号解决。

---

### 5.9 Undo 落地（v0.1 实现）

§8 已实现为 `@butui/undo`：

- `patch.ts`：**行级编辑脚本** `{ at, remove[], insert[] }`。可逆是结构性的
  （交换 remove/insert），应用时自带上下文校验，不需要解析 unified diff 文本。
  末尾换行必须单独记录 —— `""` → `"hello\n"` 只差一个 insert，但还原不回来。
  `reversePatch` 要把 `at` 从 before 坐标换算到 after 坐标（加上前面所有 op
  的行数增量），照抄 `at` 是错的。
- `journal.ts`：只追加的 `WorkspaceChange`（toolCallId / beforeHash / afterHash
  / reverse patch / files / reversible / todoBefore）。
- `plan.ts`：本地推导 undo 预览 + 执行。

四条实现约束：

1. **链式修改只校验最后一次的 hash**。`v1→v2→v3` 里拿 c1 的 `afterHash(v2)`
   跟磁盘比必然误报冲突；只有每个文件最后一次改动的 afterHash 该跟磁盘比，
   中间态在应用过程中用暂存内容逐级校验。
2. **revert 全有或全无**：任何冲突都导致零写入，避免半截状态。
3. **`at` 是坐标不是序号**：反向 patch 必须做坐标换算。
4. **分支可见性**：子分支能看到父分支 `fromMsgId` 之前的历史（§8.2），
   由 `visibleOnBranch()` 沿祖先链判断。

另外，`tool.result` 增加可选字段 `workspace: [{ path, before, after }]`，
由工具执行器填 —— 这样「改了什么」也走事件协议，回放时 journal 能完整重建。

---

### 5.5 禁止事项

- 不从 OpenTUI 复制 reconciler
- 不 fork `solid-js` / `@solidjs/signals`
- 不把 SolidJS 源码 vendor 进 buTUI
- 不把具体工具名硬编码进 buTUI 核心

---

## 6. 推荐架构

```text
@butui/core
  节点、属性、事件、生命周期、focus、theme

@butui/layout
  row / column / flex / fixed / absolute / scroll / measure

@butui/terminal
  raw mode、ANSI、鼠标、resize、paste、capability

@butui/renderer
  cell / line buffer、diff、paint、overlay、z-index

@butui/solid
  @solidjs/universal 适配、jsx-runtime、Bun plugin、preload

@butui/components
  Box / Text / Input / Select / ScrollBox / Overlay / Code / Diff

@butui/agent
  Message / ToolCard / TodoPanel / PermissionDialog / ArtifactCanvas

@butui/undo
  checkpoint、branch、preview、revert、conflict

@butui/web
  WebUI adapter，基于 @solidjs/web

@butui/test
  headless render、snapshot、PTY replay、event injection
```

数据流：

```text
SolidJS signal / store
  → @butui/solid host ops
  → buTUI Node tree
  → layout
  → cell / line buffer
  → renderer diff
  → terminal ANSI
```

---

## 7. Agent 数据模型

### 7.1 Message

```ts
interface AgentMessage {
  id: string;
  msgid: number;
  turnId: string;
  role: "system" | "user" | "assistant" | "tool";
  origin: "system" | "user" | "assistant" | "tool" | "inject";
  createdAt: number;
  parentId?: string;
  branchId: string;
}
```

### 7.2 Turn

```ts
interface Turn {
  id: string;
  branchId: string;
  startMsgId: number;
  endMsgId?: number;
  status: "running" | "completed" | "aborted" | "failed";
}
```

### 7.3 ToolCall

```ts
interface AgentToolCall {
  id: string;
  turnId: string;
  name: string;
  args: unknown;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  reversible: boolean;
}
```

### 7.4 Checkpoint

```ts
interface Checkpoint {
  id: string;
  branchId: string;
  msgid: number;
  kind: "conversation" | "workspace" | "todo" | "full";
  createdAt: number;
}
```

### 7.5 Branch

```ts
interface Branch {
  id: string;
  parentBranchId?: string;
  fromMsgId?: number;
  createdAt: number;
  label?: string;
}
```

### 7.6 Artifact

```ts
interface Artifact {
  id: string;
  kind: "image" | "diff" | "log" | "table" | "json" | "file" | "chart";
  source: string;
  mime?: string;
  createdAt: number;
  toolCallId?: string;
}
```

---

## 8. Undo Spec

### 8.1 Undo 不是普通 Ctrl+Z

需要区分：

| 操作 | 语义 |
|---|---|
| Undo this action | 只撤销某个工具动作 |
| Undo to here | 回退到某个 message / checkpoint |
| Fork from here | 保留历史，创建新分支 |
| Retry from here | 从某点创建分支并重新执行 |
| Revert workspace | 只回退文件变更 |
| Invalidate grant | 只失效权限授权 |

### 8.2 分支式 Undo

推荐模型：

```text
原分支
  user
  assistant
  tool
  assistant
  checkpoint

Undo to assistant#2
  → 创建 new branch
  → 原分支保留
  → 新分支从 assistant#2 之后开始
```

不要直接删除历史。

### 8.3 点击消息后的交互

```text
点击消息
  → 选中消息
  → 显示 MessageActionBar

MessageActionBar:
  Undo
  Fork
  Retry
  Copy
  Inspect
```

点击 Undo 后必须进入预览：

```text
Undo Preview
  Messages: 4 条将被移出当前分支
  Files: 3 个文件将被反向 patch
  Todo: 2 项状态将回滚
  Irreversible: npm publish
  Conflicts: 1 个文件已被外部修改

[确认] [取消]
```

### 8.4 Workspace Undo

每个修改工作区的工具调用记录：

```text
toolCallId
beforeHash
afterHash
patch
files
reversible
```

执行顺序：

1. 检查文件当前 hash；
2. 如果与 afterHash 不一致，报告 conflict；
3. 按逆序应用 reverse patch；
4. 写 undo event；
5. 重新计算 todo 和 UI 状态。

### 8.5 不可逆操作

标记为不可逆：

- `git push`
- `npm publish`
- `curl POST`
- 远程 API 写入
- 外部进程副作用
- 用户明确的 destructive 操作

UI 必须显示：

```text
该操作无法撤销
```

### 8.6 事件

```ts
type UndoEvent =
  | { type: "checkpoint.create"; checkpoint: Checkpoint }
  | { type: "undo.preview"; target: string; effects: UndoEffect[] }
  | { type: "undo.apply"; target: string; mode: "branch" | "revert" }
  | { type: "branch.create"; from: string; branchId: string }
  | { type: "branch.switch"; branchId: string }
  | { type: "revert.conflict"; files: string[] };
```

---

## 9. 基础能力

### 9.1 布局

P0：

- Row
- Column
- Spacer
- Fixed
- Flex grow / shrink
- Padding / margin / gap
- Border
- Absolute
- Overflow hidden
- ScrollBox

P1：

- Grid
- Sticky header / footer
- SplitPane
- 自动文本高度
- VirtualList

### 9.2 文本

- ANSI 感知宽度
- CJK / emoji / grapheme
- ANSI 感知折行
- ANSI 感知截断
- 行号
- 代码高亮
- Markdown
- Diff
- 超链接
- 选中与复制

### 9.3 终端

- raw mode
- 备用屏
- 光标管理
- resize
- 16 / 256 / truecolor
- SGR 鼠标
- 滚轮
- bracketed paste
- focus events
- Kitty keyboard protocol
- capability detection
- `NO_COLOR` / `TERM=dumb` 降级

### 9.4 交互

- focus tree
- Tab / Shift+Tab
- 键盘事件冒泡
- 全局快捷键
- modal focus trap
- mouse hit test
- 点击、拖拽、滚轮
- overlay / portal
- z-index
- selection

### 9.5 动画

- timeline
- tween
- spring
- easing
- sequence
- stagger
- reduced motion
- 只在需要时启动帧循环

---

## 10. 组件清单

### 10.1 基础组件

- Box
- Row
- Column
- Spacer
- Center
- ScrollBox
- SplitPane
- Tabs
- Text
- Paragraph
- Markdown
- Code
- Diff
- Input
- Textarea
- Select
- MultiSelect
- Checkbox
- Radio
- Form
- Overlay
- Portal
- Dialog
- Toast
- Tooltip
- Popover
- List
- VirtualList
- Table
- Tree
- ProgressBar
- Spinner
- StatusBar
- Badge

### 10.2 Agent 组件

- `StreamText`
- `ReasoningLine`
- `ToolCard`
- `BashProgress`
- `FoldableOutput`
- `DiffView`
- `TodoPanel`
- `PermissionDialog`
- `AskUserForm`
- `ContextMeter`
- `SessionTree`
- `AgentTimeline`
- `ArtifactCanvas`
- `CommandPalette`
- `ToolGraph`
- `CheckpointMarker`
- `MessageActions`
- `UndoActionBar`
- `UndoPreview`
- `BranchTree`
- `BranchSwitcher`
- `RevertConflictDialog`

---

## 11. 差异化能力

图片不是绝对独有能力。  
buTUI 的差异应该是：

> 把图片、diff、日志、表格和 agent 事件统一成 Artifact Canvas，并与回放、undo、权限、上下文和 WebUI 联动。

### 11.1 Artifact Canvas

- 图片
- 截图
- 图表
- diff
- 日志
- 表格
- JSON
- 文件树
- 代码片段

能力：

- pin / unpin
- 并排比较
- 从 tool result 直接生成
- 点击展开
- 复制路径
- WebUI 打开
- 关联 tool call / message

### 11.2 Agent Timeline / Flight Recorder

记录：

- user input
- model request
- reasoning
- text delta
- tool call
- tool result
- permission decision
- todo update
- context compaction

支持：

- 时间线
- 回放
- 跳步
- 查看当时上下文
- 比较分支
- 导出事件流

### 11.3 Context Inspector

- context window 占用
- prefix cache 命中
- 发送了哪些消息
- 哪些内容被截断
- compaction 前后差异
- token / cost 估算

### 11.4 Permission / Sandbox Map

```text
workspace
  read: pass
  write: workspace-write
  network: ask-per-call
  process: sandboxed
```

支持：

- 查看规则
- 查看本次 grant
- 显示真实失败原因
- 显示哪些工具在裸奔

### 11.5 Multi-Agent Lanes

- 主 agent
- 子 agent
- 并行工具
- 状态
- 消息归属
- 冲突和等待关系

### 11.6 Branching Sessions

- 从任意消息 fork
- 保留原会话
- 并排比较回答
- 回放不同分支

### 11.7 Remote Attach

```text
bugent attach <session>
```

本地 TUI 只是 client，agent 可运行在：

- 本机
- 远程服务器
- 容器
- sandbox

### 11.8 Semantic Zoom

```text
一行摘要
  → 结构化卡片
    → 完整工具输出
      → 原始 JSON / 文件 / artifact
```

---

## 12. 图片子系统

### 12.1 协议优先级

1. Kitty graphics protocol
2. iTerm2 inline image
3. Sixel
4. Unicode half-block / ANSI fallback
5. 纯文本占位符

### 12.2 API

```tsx
<Image
  src={path()}
  fit="contain"
  width={40}
  alt="screenshot"
/>

<ArtifactCanvas artifacts={artifacts()} />
```

### 12.3 安全

- 只允许白名单路径或明确授权的 URL
- 限制 MIME
- 限制大小
- 不把图片内容拼进 shell
- 不信任 terminal escape
- 远程图片默认需要授权

---

## 13. 事件协议

### 13.1 Agent → UI

```ts
type AgentEvent =
  | { type: "turn.start"; turnId: string }
  | { type: "text.delta"; turnId: string; delta: string }
  | { type: "reasoning.delta"; turnId: string; delta: string }
  | { type: "tool.start"; call: ToolCall }
  | { type: "tool.progress"; callId: string; chunk: string }
  | { type: "tool.result"; callId: string; result: ToolResult }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "ask_user.request"; questions: AskUserQuestion[] }
  | { type: "todo.update"; todos: Todo[] }
  | { type: "artifact.add"; artifact: Artifact }
  | { type: "checkpoint.create"; checkpoint: Checkpoint }
  | { type: "undo.preview"; target: string; effects: UndoEffect[] }
  | { type: "undo.apply"; target: string; mode: "branch" | "revert" }
  | { type: "branch.create"; from: string; branchId: string }
  | { type: "branch.switch"; branchId: string }
  | { type: "turn.end"; turnId: string; reason: string }
  | { type: "error"; message: string };
```

### 13.2 UI → Agent

```ts
type UiCommand =
  | { type: "user.submit"; text: string }
  | { type: "cancel" }
  | { type: "permission.respond"; id: string; allow: boolean }
  | { type: "ask_user.respond"; id: string; answers: unknown[] }
  | { type: "mode.set"; mode: SandboxMode }
  | { type: "session.fork"; msgid: number }
  | { type: "undo.preview"; target: string }
  | { type: "undo.apply"; target: string; mode: "branch" | "revert" }
  | { type: "branch.switch"; branchId: string }
  | { type: "artifact.open"; id: string };
```

---

## 14. 扩展点

必须有：

- 自定义 renderable
- 自定义 component
- tool renderer registry
- theme tokens
- keymap
- layout primitives
- plugin API
- JSX intrinsic elements

不能把：

```text
bash
read_file
edit_file
todo_write
ask_user
```

硬编码进 buTUI 核心。

---

## 15. 测试与观测

需要：

- headless renderer
- snapshot 测试
- event injection
- 确定性动画时钟
- PTY 冒烟
- ANSI capture / replay
- resize / mouse / paste 模拟
- 图片协议 mock
- 性能基准
- 内存边界测试
- undo / branch / replay 回归测试

---

## 16. 版本路线

### v0.1

- Bun-first
- TypeScript
- SolidJS 2 RC
- 无 native core
- 无图片协议也能工作
- 基础布局、文本、输入、滚动、overlay
- Message / ToolCard / Todo / Permission / AskUser
- 语义 hit test
- 基础 undo preview / branch

### v0.2

- Checkpoint
- Workspace reverse patch
- Agent Timeline
- Context Inspector
- Kitty / iTerm2 / Sixel
- Artifact Canvas

### v0.3

- WebUI adapter
- Remote attach
- Multi-agent lanes
- Branch compare

### v1.0

- 可选 Rust core
- 插件生态
- 第三方组件
- 稳定事件协议

---

## 17. MVP 验收标准

- `bun test` 全绿
- 80×24 和 200×50 都能正常布局
- 长会话不无限增长
- CJK / emoji / ANSI 不错位
- 鼠标点击权限弹窗可用
- 点击消息返回语义节点，不是行号
- Undo Preview 能列出影响范围
- Undo 后能创建分支而不是破坏原历史
- Workspace revert 能检测冲突
- 流式输出不整屏闪烁
- 动画只在需要时运行
- 无图片协议时能优雅降级
- 终端 resize 不崩溃
- WebUI 可以复用事件协议

---

## 18. 需要设计同事回答的问题

1. buTUI 是通用框架，还是 agent UI kit？
2. 第一版是否只做 Bun + TypeScript？
3. 是否直接采用 SolidJS 2 RC？
4. 是否使用 `@solidjs/compiler` 的 universal 模式？
5. 布局是自己写，还是引入 Yoga？
6. TUI 和 WebUI 共享状态还是共享组件？
7. 图片协议支持哪几种？
8. 是否支持 remote attach？
9. 事件协议是 JSON-RPC、NDJSON，还是自定义？
10. Undo 是分支式还是原地截断？
11. Workspace undo 用 patch 还是 snapshot？
12. 是否允许未来替换成 Rust core？

---

## 19. 推荐的第一版边界

第一版不要试图做成“通用 OpenTUI 替代品”。

第一版应该做成：

> **一个能让 bugent / buagent 写出 agent-first、可点击、可 undo、可分支、可回放、可测试的终端 UI Runtime。**

最小闭环：

```text
Message 语义节点
  + ToolCard
  + TodoPanel
  + PermissionDialog
  + AskUserForm
  + CheckpointMarker
  + UndoPreview
  + BranchTree
  + 语义 hit test
  + 事件协议
```

图片、WebUI、remote attach、多 agent 都可以晚一步。
