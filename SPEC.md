# buTUI 0.1 TUI Runtime Spec

状态：Draft  
日期：2026-09-24
目标读者：buTUI 设计者、buTUI 实现者、TUI 应用与 agent UI 维护者

---

## 1. 定位

buTUI 是 Bun + TypeScript 的通用 TUI Runtime。接口设计参考 OpenTUI，但不复制
其 Zig / FFI 架构；默认零 native core，优先复用 Bun 与 SolidJS 2 RC。

核心目标是提供可组合的终端 UI 基础能力：

- `createTuiApp` 应用入口与响应式渲染；
- 布局、ANSI、鼠标、键盘、滚动、动画和文本选择；
- 可复用组件、插件 / Slot、Keymap 等应用层接口；
- 流式文本、Markdown、Diff 等长内容增量路径。

Coding agent UI 是 buTUI 的上层用例，而不是核心边界。agent 事件协议、Session、
undo、artifact 等仍由 `@butui/agent` 提供，应用也可以完全不使用这些层。

---

## 2. 核心目标

### 2.1 产品目标

让 TUI 应用可以用一致的 Bun / TypeScript 接口构建交互：

- 稳定布局与合帧渲染
- 鼠标、键盘、焦点与文本选择
- 可复用组件、插件和命令系统
- 流式长内容与可测试的 headless 渲染
- 可选的 agent 工作流：消息、工具、撤销、分支、审查

Agent UI 的完整工作过程应能被看见、点击、展开、回放、撤销、分支、比较并分享
给 WebUI / remote client，但这些能力建立在通用 runtime 之上。

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

### 4.1 通用原语优先

布局、事件、焦点、滚动、鼠标和插件接口保持通用，不把 agent 概念写进核心。
Agent 上层仍应把消息、工具、checkpoint、分支和权限建成结构化节点，而不是
字符串行。

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

- `Bun.Image` 没有 raw pixel 出口 → 见 §12.4：用「Bun.Image 解码缩放 →
  `.png()` → 自带 PNG 解析」绕开，重活仍然在 Bun 的 SIMD 内核里
- 鼠标 SGR 解析、Kitty keyboard protocol、focus events、bracketed paste、
  终端能力探测全部需要自己实现（`@butui/terminal` 已实现）
- `Bun.Terminal`（PTY）可用于 PTY 冒烟与回放测试

**5.6.7 `Bun.deflateSync` / `Bun.inflateSync` 默认是 raw deflate**

`bun-types` 里 `windowBits` 的文档说 `9..15` 出 zlib 头、`-9..-15` 出 raw
deflate，但 1.4.2 实测：

```ts
Bun.deflateSync(data, { windowBits: 15 })   // 头仍然是 cb48 = raw deflate，参数被忽略
Bun.inflateSync(zlibStream)                 // 报 "invalid stored block lengths"
Bun.inflateSync(zlibStream, { windowBits: 15 })  // 正确
```

所以任何要跟外部格式对齐的地方（PNG 的 IDAT 就是 zlib 流）都得自己拼/拆：

- 压缩：`0x78 0x9c` + raw deflate + Adler-32 大端（`@butui/image` 的
  `zlibCompress`）
- 解压：显式 `{ windowBits: 15 }`；先做头校验，不合法再退回 `-15`

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

`frozen` 的成立前提是「那段前缀真的没变」，而父容器没法在 O(1) 里验证它。
所以 `Box` 上还有一个 `frozenToken`：父容器只在 token 一致时才复用旧行。

- `<stream>` 用 `lines` 数组本身当 token —— 同一个数组只增不改；换数组就是
  全量重建，旧前缀一行都不能信
- `<image>` 直接声明 `frozen: 0` —— 图片是全有全无的叶子，重渲染时每一行
  都可能变（换图、resize、协议降级）

这条约束是 2026-09-23 做图片子系统时踩出来的：少了它，「先布局 → 改属性 →
再布局」会稳定地读到上一帧的内容，而且只在**布局过一次**之后才复现。
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

### 5.10 WebUI 落地（v0.1 实现）

§2.2 的「终端和 WebUI 共用业务状态与事件协议」与 §3 的「不把 TUI 和 WebUI
强行做成同一套组件代码」由 `@butui/web` 验证：

- **共享**：`@butui/agent` 的 Session / reducer / NDJSON 协议。
- **不共享**：渲染层。TUI 是 `generate: "universal"` + cell 网格；WebUI 是
  `generate: "dom"` + `@solidjs/web`。
- 两边在根节点打同样的语义标识，`tests/web-ui.test.tsx` 直接断言集合一致。

三个实现细节：

1. **编译目标靠路径区分**。`@butui/solid/plugin` 的 `targets` 选项按顺序匹配
   文件路径，未命中回落 universal。同一个仓库里两种 renderer 共存。
2. **WebUI 的 .tsx 要加 `/** @jsxImportSource @solidjs/web */`**，否则会被根
   tsconfig 的 `jsxImportSource` 按 TUI 的 intrinsic elements 类型检查。
3. **流式 markdown 在 DOM 侧也用命令式 append**：`StreamSource.lines` 是只增
   不改的数组，DOM 节点一旦创建就不该重建。每次只追加新增行，尾部单独更新
   —— 与 TUI 侧 `measureStreamNode` 是同一个思路，产物从 cell 变成 DOM。

Remote attach（§16 v0.3）也一并跑通：服务端只发 NDJSON 事件、不认识 UI；
浏览器侧建 Session、连流、把 UiCommand POST 回去。`tests/web-remote.test.ts`
真的起服务、连流、POST 命令、断言事件到达。

---

### 5.11 应用运行时（v0.1 实现）

buTUI 的定位是**底层**：应用（agent / 工具 / 自己的 TUI）不该自己糊终端、
渲染器、重绘调度、resize、focus 循环。这些收敛成 `@butui/runtime` 的
`createTuiApp`，应用只写「视图 + 键位策略」。

**关键改动：core 增加变更通知。** `touch()` 现在会通知订阅者
（`onMutation`），运行时订阅一次，之后任何节点变更都自动合并到下一帧：

```text
signal / 定时器 / 异步图片加载
  → setProp / replaceText / insertNode
  → touch()  → onMutation
  → queueMicrotask(flush + layout + draw)
```

没有它，每个 app 都要手写 `schedulePaint`，并且在每个可能改状态的地方记得
调用 —— demo 里曾经有 6 处，漏一处就是「界面不刷新」这种最难查的 bug。
有了它，「忘了重绘」这个 bug 类别直接消失。

**事件顺序是契约的一部分**（固定下来，不随实现漂）：

```text
键   onKey(应用级) → keymap → useKeyboard → ctrl+c / tab 焦点 → 焦点节点(冒泡)
鼠标 hit test 命中节点 → 冒泡；没有节点处理才走 onMouse
```

鼠标这条顺序让「语义动作分发」和「组件自己的点击」不用互相打架：
组件声明了 `onClick` 就归组件，没声明才落到应用级。

**默认 `scroll: "bottom"`** —— 内容超出视口时贴底。这是聊天式转录的正确行为，
也是 SPEC §17「只复制可视窗口」的另一半。固定布局传 `scroll: () => "top"`。

顺带补齐了一个 JSX 类型的洞：`<text>` 之前没有 `focusable` / `onKey` 等交互
属性，逼着作者为了「能 Tab 到」多包一层 `<box>`。列表项 / 菜单行 / 按钮都是
text，现在 `TextProps` 与 `BoxProps` 的交互属性完全对齐。

**焦点可观察（v0.1 补齐）。** 组件拿不到 root，所以「我是不是焦点」过去只能由
应用自己维护一份 signal（demo 就这么干的）。现在拆成三层：

```text
core     焦点变化时通知（onFocusChange）
runtime  转成响应式信号，并用 Solid context 提供给整棵视图树
组件     ref 拿自己的节点 → useFocus()(node) → O(1) 且响应式
```

`@butui/solid` 里的 `provideFocusScope` 有个细节：`children` 必须是 **getter**。
Solid 的 provider 在自己的 root 里延迟读取 `props.children`，直接传值会让子树在
上下文生效前就创建完，`useFocus()` 全部拿到 null（这个坑是实测出来的，见
`packages/solid/src/focus-context.ts`）。

顺带补了 `ref`：`applyRef` 一直都在 host ops 里，但 JSX 类型没暴露它，
所以「组件拿自己的节点」这条路之前是走不通的。

**输入模型（v0.1 补齐）。** `@butui/components` 提供 `createTextEditor`（纯逻辑）
+ `<Input>`（渲染）。编辑器覆盖光标移动、插入删除、词跳转、`ctrl+a/e/u/k/w`、
`↑↓` 历史、多行、粘贴；`<Input>` 负责光标样式与水平滚动。

两个实测教训：

1. **编辑器内部不能直接读写 signal。** 第一次实现「读 `value()` → 算新值 →
   写 signal」，连续输入直接丢字符 —— 正是 §5.6.3 的延迟写入。改成
   「真值放局部变量、signal 只当版本号、访问器读真值」之后才对。
   这条同样适用于运行时自己的 `focusedId()`。
2. **`Bun.color` 只产前景序列。** `resolveColor` 一直把它当背景用，于是
   `bg="..."` 实际画的是前景色（看着有颜色，完全不是想要的效果）。现在
   `resolveColor(value, depth, "bg")` 会把 `38;` 换成 `48;`。

稳定性的完整契约见 **`STABILITY.md`**（哪些是稳定层、兼容规则、已知缺口）。

---

### 5.12 列表与虚拟化落地（v0.1 实现）

§10.1 的 `List` / `VirtualList` 由 `@butui/components` 提供，拆成纯逻辑
（`createSelection` / `followScroll`）和视图（`<List>` / `<VirtualList>`）。

**为什么两者是同一份实现。** 只差「窗口开多大」：`List` 渲染全部条目、靠外层
裁剪（几十行的菜单）；`VirtualList` 只渲染可见的 `viewport` 行（上万条的历史 /
文件树）。渲染路径都用 Solid 2 的 `<Repeat count from>` —— 它在窗口整体平移时
**复用重叠区间的节点**，所以往下滚一行是「建一行 + 销毁一行」，与总条数无关。
`<For>` 做不到这点（每次都是全量 reconcile），流式渲染那边已经踩过一次。

三条实测出来的约束：

1. **不能按「创建时快照」渲染行。** `<Repeat>` 只在 `count` / `from` 变化时重跑
   mapping；`items` 换了但长度没变时它一行都不重建。所以行内容必须读
   `items()[index]` 这种**访问器**，让 Solid 自己追依赖 —— 写成
   `renderItem(items[i])` 会让「同长度的过滤结果」显示成上一批数据（命令面板
   输入一个字符就撞上）。
2. **窗口顶部是组件自己的状态，不是从选中项推出来的。** 用户滚开之后，只要
   不动选中项，窗口就不该被弹回去。`followScroll(selected, count, viewport, top)`
   是个纯函数：只在选中项跑出窗口时移动，其余原样返回。
3. **选中态是访问器不是布尔值。** 行节点只创建一次，`state.selected()` 让
   「移动一格」只重算两行的文本节点。

**顺手补掉的两个底层缺陷**（列表逼出来的，但都不是列表专属）：

- **容器背景铺不满自己的盒子。** 布局层给容器补空白时用的是「默认样式」的
  cell，于是 `<box bg="accent">` 只有文字那一截是彩色的，右边补的空白又变回
  默认背景 —— 选中行整行高亮、状态栏、modal 遮罩全做不出来。现在容器自己撑
  出来的空白（对齐、gap、显式高度填充、row 列补齐）带**自己的 sgr**。
  这顺手暴露了增量布局的一个洞：快路径只重测子节点，但每行最后都要过一遍父
  节点自己的装饰，而装饰里现在含父节点的 SGR。所以缓存里加了一份「自身样式
  + 内衬」指纹（`selfKey`），不一致就放弃快路径 —— 否则「改自己的背景 + 最后
  一个子节点变化」这一帧会复用带着旧样式的行。
- **滚轮方向被解码后丢掉。** `MouseEvent` 没有方向字段，解码器里写着
  `button = (b & 1) === 0 ? "none" : "none"` —— 两个分支同一个值，等于滚不动。
  现在 `MouseEvent.wheel: "up" | "down" | "left" | "right"`（`action ===
  "wheel"` 时有值）。同一段代码里鼠标修饰键位也修了：鼠标用 4/8/16
  （shift/meta/ctrl），不是键盘那套 1/2/4，原来 shift 会被认成 ctrl。

**多行输入（`<Textarea>`）。** 软换行是纯函数 `wrapText(text, width)`：按
grapheme 切、按 `Bun.stringWidth` 算宽度，产出「视觉行 + 它在源文本里的
`[start, end)` + 逻辑行号」。光标定位（`locateCursor`）与垂直滚动都建立在这张
映射上，组件里不存第二份文本。垂直滚动由光标驱动（跑出视口才动窗口）。

顺带修了编辑器一个语义错误：**多行模式下 ↑↓ 原来走的是「翻历史」**。现在
多行走 `moveVertical`（保持列位置，短行夹到行尾），单行才翻历史。

**选择模型的两个扩展**（写 `<Select>` / `<Tree>` 时补的）：

- `isSelectable(i)`：↑↓ 跳过不可选项（分隔线 / 分组标题 / disabled），
  Home/End 落在第一个 / 最后一个可选项上，初始下标会吸附到最近的可用项。
- `<List activateOnClick>`：点击是否等同于 Enter。默认只选中（列表语义），
  `<Select>` / `<Tree>` 打开它（菜单 / 树语义）。

**命令面板形态（`<Input>` + `<List>`）不需要新 API。** `<Input onKey>` 先于
编辑器，`onKey={e => selection.handleKey(e)}` 就够：方向键被列表消费，字符照常
进编辑器。这是「组件组合」而不是「再造一个 CommandPalette 组件」。

---

### 5.13 滚动视口（v0.1 实现）

聊天式转录的正确行为：**默认贴底，用户往回翻之后新内容不许把视口拽回去**。
这是所有聊天 UI 都要处理、又几乎每个应用都写错一次的东西，所以收进
`@butui/components` 的 `createScrollView()`：

```tsx
const view = createScrollView();
createTuiApp({
  view: () => <box>{lines().map(line => <text>{line}</text>)}</box>,
  scroll: view,                            // 可调用 → 直接当选项传
  stickyBottom: 1,                         // 最后一行固定（状态栏）
  afterDraw: frame => view.measure(frame), // 收回真实位置
  onKey: event => view.handleKey(event),   // ↑↓ PageUp/PageDown Home End
  onMouse: event => view.handleWheel(event),
});
```

四条设计要点：

1. **「跟随」是一个状态，不是一个偏移。** 贴底时 `scroll()` 返回 `"bottom"`
   而不是数字，于是内容变长时**不需要任何通知**就继续贴底 —— 这正是
   `layout()` 支持 `"bottom"` 的意义。往上滚才切成具体偏移。
2. **模型只存意图，真实位置由布局回报。** 布局会把 `scrollTop` 夹进
   `[0, total - height]`，`Frame.top` 是夹取后的真值；`measure()` 每帧把它收
   回来，滚过头下一帧自愈（画出来的本来就是夹取后的那一屏，不用补重绘）。
3. **`top` / `total` 是「滚动区内」的坐标系。** 有了固定页眉 / 页脚之后，
   `maxTop === total - height` 依然成立，所以调用方不用知道固定区有几行。
4. **滚到底 = 重新跟随。** 用户自己滚回底部，跟随自动恢复，不用应用再调一次。

**`stickyTop` / `stickyBottom`（runtime 选项）。** `<layer>` 只能相对**父节点**
定位，父节点自己也会被滚走 —— 所以「固定页眉 + 可滚转录 + 固定页脚」必须在
视口这一层做。语义是**取内容的前 / 后 N 行**，所以页眉页脚要放在 flow 的头尾。
`Frame.top` 报的是滚动区内的行号，`scroll` 选项收的也是同一个坐标系。

**顺手补掉的两个底层缺陷：**

- **`truncate` / `wrap={false}` 只有类型没有实现。** 状态栏一超宽就折成两行，
  行高变得不可预测（`stickyBottom: 1` 立刻错位 —— demo 里就是这么发现的）。
  现在 `truncate` 截断并补 `…`，`wrap={false}` 直接截断，都是单行。
- **row 里超长的 text 会把兄弟节点挤出去。** `truncate` 的节点现在**最后**参与
  第一轮测量：先让别的兄弟拿走自己要的宽度，剩下的才归它。否则
  `<row><text truncate>长文本</text><text>右对齐</text></row>` 里右边那个直接
  消失。
- **空文本节点会吃掉一个字符的宽度。** `<Show>` 关掉、`{cond && "x"}` 为假时
  都会留下一个 `""` 的文本节点：它画不出东西，却仍然占一份 gap 和宽度预算。
  表现是「同一行里其它文字莫名少一个字符」（写 `<Select>` 时撞出来的：
  `feature` 显示成 `featur`）。现在 `inFlow` 直接把它当不存在。
- **空的条件渲染会留空行。** `<box gap={1}>` 里几个 `<Show>` 一关，屏幕上就
  凭空多出几行空白 —— 因为 gap 是按「子节点个数」算的，而关掉的 Show 仍然
  留下了一个空盒子。现在只有**真正有内容的**子节点才占 gap（`<spacer/>` 这种
  「没有行但有宽度」的例外单独判）。AgentView 里 6 个条件面板曾经一次贡献
  6 行空白。

---

### 5.14 用量与思考落地（v0.1 实现）

**`usage` 事件（§11.3 Context Inspector 的数据面）。** 协议里原本只有
`tool.result.workspace` 那种「顺带捎一段数据」的口子，没有 token 用量的位置，
而 §11.3 要画上下文占用条。现在补成正式事件：

```ts
interface Usage {
  input: number; output: number; cached?: number;   // 本次调用的增量
  contextTokens?: number; contextWindow?: number;   // 当前上下文占用 / 窗口上限
}
```

两组数**刻意分开**，因为不能互相推导：`input/output` 累加是会话总账（计费），
`contextTokens/contextWindow` 是最近一次请求的规模（画条）。拿累计值除窗口会
立刻超过 100%。`mergeUsage()` 把这两条规则写死在一处，`Session` 直接用它。

`<ContextMeter usage={...}>` 画 `██████░░░░ 32k/128k`，超过 70% / 90% 转
warning / danger；没有 `contextWindow` 时只报数不画比例（不假装知道）。

**思考流不落库，但要有地方拿。** `reasoning.delta` 之前只把状态标成 running，
文本直接丢掉 —— 于是 UI 根本没法显示「它在想什么」。现在 `Session` 给每个
turn 建一个**纯文本流**（不是 markdown：思考里全是半截句子，按 markdown 解析
只会闪）：

```tsx
<Show when={session.reasoningFor(message.turnId)}>
  {source => <ReasoningLine text={source().tail()} streaming={message.streaming} />}
</Show>
```

`turn.end` 时整个源被丢掉，`<Show>` 自动收起 —— 思考是临时产物，留着只会撑爆
上下文和拖慢渲染（§7 的取舍）。折叠态读 `source.tail()` 是 O(1)。

**顺手修掉的两个一直没被发现的 bug：**

- **`turn.end` 会把所有流一起封掉。** 之前是 `for (const [id, source] of sources)
  source.flush()` —— 于是「A 轮结束」会把还在流的 B 轮一起封死，B 的下一个
  delta 直接抛 `stream 已经 flush，不能再 push`（demo 里真实崩过一次：greet
  的 turn 还没结束，用户就发了下一条）。现在只定稿**这个 turn 的**流，并且
  turn 结束之后迟到的 delta 直接忽略（协议违规不该把 UI 打崩）。
- **`streaming` 标记从来没亮过。**
  `text.delta` 走的是「只建消息 + 推进流」的快路径，绕过了 reducer —— 而
  `message.streaming = true` 是 reducer 推导的。结果是 `MessageView` 的
  「streaming…」和 `<Show when={message.streaming}>` 从来没显示过。快路径现在补
  一次 `reduce()`（消息查找是幂等的），并把这条写进了回归测试。

---

### 5.18 鼠标文本选择与 OSC 52（v0.1 实现）

文本选择是 agent TUI 的刚需：用户要复制命令输出、代码块、错误栈和模型回答。
它不能逼每个应用自己维护一份「屏幕坐标 → 字符偏移」映射，也不能破坏流式
渲染的 O(1) 契约。

**分层：**

```text
terminal    SGR 1006 press / move / release；OSC 52 编码
runtime     锚点 / 焦点、拖拽状态、松开时定稿与自动复制
layout      selectionText() 提取；在最终帧复制出的 cell 上打 selected
renderer    只在选中 run 前后开关反显，并参与逐行差分
```

**1. 选择是帧视图状态，不是布局状态。** `LayoutContext.selection` 只影响
`layout()` 最后复制可视窗口那一步；`measureNode()`、`Box.frozen` 与节点 `rev`
完全不知道选区。于是拖拽选择不会让任何布局缓存失效，流式追加仍然只处理
delta，选区成本只与可视选中区域有关。

**2. 坐标按显示列处理。** `selectionText(frame, range)`：

- 锚点 / 焦点按 `(y, x)` 阅读顺序归一化；
- 同一行取闭区间，跨行首行到行尾、中间全行、末行到焦点；
- 宽字符边界落在任一 cell 都复制完整 grapheme；
- frame 为铺满终端补的尾部空白不会进入剪贴板。

**3. 反显是 renderer 的 run 状态。** cell 只带 `selected?: boolean`；renderer
在 run 开始发 `SGR 7`、结束发 `SGR 27`，并把这个字段纳入行差分。不会把选区
编码成颜色，也不要求 layout 理解终端样式。

**4. 松开才定稿。** 拖动过程只更新高亮，`onSelection` 不会随 mouse-move
高频触发；松开后默认写 OSC 52，`copyOnSelect: false` 可关闭，应用也可以调用
`app.copySelection()` / `app.clearSelection()`。

**5. OSC 52 是 best-effort。** UTF-8 先 base64，默认 `ESC ] 52 ; c ; … BEL`；
tmux 环境下自动包 passthrough。协议没有确认通道，终端可以忽略，因此 API
只表示「已尝试」，严格剪贴板需求由应用在 `onSelection` 中接平台实现。

**顺手修掉的真实输入 bug：** SGR 鼠标按住左键移动是 `b=32+button`，旧解码器
只认 `buttonCode===3` 为 move，于是真实拖拽被当成连续 press。现在按 motion
bit（32）判定，并保留 held button；这也让 `<Box onMouseMove>` 一类事件终于
有正确来源。

**明确取舍：** 选区坐标是当前视口，不是内容锚点；拖到屏幕边缘不会自动滚动；
resize 会清除。稳定锚点需要应用把语义节点 / 文本保存到 `onSelection`。

---

### 5.19 流式 Diff（v0.1 实现）

模型按 SSE chunk 输出到 tool call 时，**不能把半截 unified diff 丢给前端解析**。
后端负责 diff 算法；线协议只发结构化的行级修订：

```ts
type DiffPatchOp =
  | { op: "upsert"; lines: DiffLine[] }
  | { op: "replaceTail"; lines: DiffLine[] };

interface DiffLine {
  id: string;                 // 同一逻辑行跨修订稳定
  kind: "meta" | "file" | "hunk" | "context" | "add" | "remove";
  text: string;               // 不含 +/-/@@ 前缀
  oldLine?: number;
  newLine?: number;
  stable?: boolean;           // false = 仍可能被后续 chunk 改写
}
```

Agent 事件：

```ts
{ type: "tool.diff", callId, patch, final?: boolean }
```

**为什么是 upsert 而不是 unified diff 文本。** chunk 可能落在任意 token 中间，
后端每拿到更多上下文都会重算“当前这一行”；如果前端只能追加文本，就必须维护
解析器、行号映射、hunk 回滚，而且每块都可能 O(N) 重排。稳定 id 的 upsert 把
这件事变成 O(1) 行定位 + 一次行更新。

推荐 id 由后端生成，例如 `fileId:hunkId:kind:oldLine:newLine`；如果行号在流式
早期还不知道，就用后端自己的逻辑行 token id。**不要用数组下标或文本 hash 当
id** —— 前者在插入后漂移，后者会在每个 chunk 都变成新行。

**为什么只允许 replaceTail。** 正常 diff 是 append-only；只有尾部 hunk 的上下文
还没稳定时才需要重算最后 N 行。允许任意位置 splice 会让虚拟列表索引、选中区、
滚动锚点全部失效。真正重排时应该新建一个 DiffStream，而不是原地改历史。

**前端粒度：**

- `DiffStream.count()` 只负责结构版本；
- 每一行有自己的版本号，`<Diff>` 只读视口行的版本；
- 只创建视口内的 `<row>`；长行 `truncate`，绝不折行改变行高；
- context 行可以逐行语法高亮，add / remove 保持红绿语义；
- `stable:false` 显示流式游标；`final:true` / `tool.result` / `turn.end`
  自动定稿。

**动画边界。** 动画只允许落在仍在变化的行；新增共享 `AnimationScheduler`
（30fps、有订阅者才启动、全部退订即停）、`useAnimationFrame`、tween / spring /
timeline。`<Diff>` 的游标只在 `stable:false` 时订阅，定稿后自动停止；拖动惯性
和 `<Shimmer>` 也复用同一调度器。`TERM=dumb` 或
`BUTUI_REDUCED_MOTION=1|true` 不启动。不要把 shimmer 铺到整个 diff 或整条
markdown —— 那会让每帧产生大面积样式变化，和 §17「流式输出不整屏闪烁」冲突。

**已知边界：** 没有 word-level diff、任意位置删除、hunk 折叠或“滚开时有新行”
提示；后端要把重算范围限制在尾部。

---

### 5.20 精确 ScrollBar（v0.1 实现）

ScrollBar 的职责不是“画一根线”，而是把 `[0, maxTop]` 的滚动空间准确映射到
有限轨道 cell。所有映射先归一到整数：

```text
maxTop     = max(0, total - viewport)
thumbSize  = max(1, min(track, floor(track * viewport / total)))
thumbRange = track - thumbSize
thumbStart = round(thumbRange * top / maxTop)
top        = round(maxTop * thumbStart / thumbRange)
```

端点必须精确：`top=0 → thumbStart=0`，`top=maxTop → thumbStart=thumbRange`。
内容不溢出时 `overflow=false`，thumb 覆盖整条轨道，不进入拖动状态。

**测量坐标来自轨道 cell 本身，不靠全局矩形。** `<ScrollBar>` 每一行轨道都是
独立节点，鼠标落在第 N 行就是局部 `y=N`；因此不需要扫描 frame、计算节点 bbox
或猜终端绝对位置。resize 后 `track` / `viewport` 变化，几何模型直接重算。

交互：

- thumb 内按下 → 记录 `grabOffset`，拖动保持鼠标相对 thumb 的位置；
- 轨道其他位置按下 → 默认把 thumb 中心对齐到该行，随后继续拖动；
- `jump(y, "start")` 可把点击行作为 thumb 顶部，用于精确跳转；
- 拖到端点精确得到 `0 / maxTop`。

**和文本选择共存。** 左键拖动同时被全局文本选择监听，所以 scrollbar 声明
`selectable={false}`；runtime 的 hit test 从目标向上继承这个属性，命中
scrollbar 时不启动文本选择。

**跨区域拖动。** 按下 thumb / 轨道后捕获 scrollbar 节点；后续 `onDrag` 使用
相对轨道的 `localY` 更新位置，因此指针移出 scrollbar 矩形后拖动仍继续。
释放时读取 `dragend.velocityY`，默认通过 `startDragInertia()` 继续滚动；
`inertia={false}` 可关闭。

`createScrollBarFor(view)` 是 `createScrollView()` 的直连适配器；`<Diff
scrollbar>` 也使用同一模型，因此根转录、列表、diff 的 thumb 比例与拖动语义
完全一致。

**已知边界：** 目前只实现垂直 scrollbar；没有自动隐藏、hover 展开、水平轴、
触控惯性或轨道纹理。

---

### 5.21 通用插件 / Slot（v0.1 实现）

插件层参考 OpenTUI 的 `Plugin` / `SlotRegistry` 接口命名，但不引入它的 Zig
运行时：`@butui/plugins` 是纯 TypeScript，宿主可以是任何稳定对象，Solid
适配单独放在 `@butui/plugins/solid`。

```text
应用壳
  createSolidSlotRegistry(host, context)
  createSlot(registry) → <Header name="header" … />

插件
  { id, order?, setup?, dispose?, slots: { header(ctx, props) { … } } }
```

解析顺序固定为 `order` → 注册顺序 → `id`。Slot 有三种合成模式：

- `append`：先 fallback，再按顺序追加所有插件贡献；
- `replace`：有插件贡献时隐藏 fallback；
- `single_winner`：只取第一个插件，贡献为空时回退。

注册表提供 `register / unregister / updateOrder / clear / batch / subscribe /
onPluginError`。每个插件有独立错误边界：`setup` 失败不会留下半注册状态；
render / dispose 失败会进入错误缓存并通知监听器，但不会阻止其它插件。
`setup` 返回的函数作为插件自己的 cleanup，在 `dispose` 前执行。

`createSlotRegistry(host, key, context)` 以 host + key 复用实例；同一个 key
传不同 context 对象会抛错，避免两份注册表看似相同却互不通知。

插件包通过 manifest 声明入口：

```json
{
  "entry": "./src/index.ts",
  "id": "my-plugin",
  "order": 10
}
```

manifest 可放在 `butui.plugin.json`，也可写在 `package.json` 的 `"butui"`
字段。应用配置支持 JSON / TS：

```ts
export default {
  plugins: [
    "some-package",
    { module: "./local-plugin.tsx", id: "local:one", options: { mode: "safe" } },
  ],
};
```

`@butui/plugins/loader` 负责：解析相对路径 / 包名、读取最近 manifest、动态
`import()`、识别 default / named `plugin` / 工厂导出、应用配置覆盖、注册到
SlotRegistry，并返回只卸载本次加载项的 `dispose()`。任何单条模块的解析、
import、工厂或注册错误都记为 `phase:"load"`，后续插件继续加载。

自动发现：

```ts
const discovered = await discoverPlugins({ cwd });
const loaded = await loadPlugins({ registry, host, context, entries: discovered.entries });
```

- 默认只扫描项目 `dependencies` / `optionalDependencies` 中带 manifest 的包；
- `extraDirs` 可加入本地插件包；
- `includeAllInstalled: true` 才扫描全部 node_modules；
- scoped package 与排序（manifest order → id/module）都支持。

能力声明：

```json
{
  "entry": "./src/index.ts",
  "capabilities": ["slots", "fs:read"]
}
```

loader 在动态 `import()` 前检查 `allowedCapabilities` / 单条 config 的
`capabilities` 白名单；不满足时拒绝加载，插件代码不会执行。
`requireCapabilities: true` 可进一步要求每个插件必须有 manifest。

**能力声明是加载同意门，不是沙箱。** 插件仍在应用进程内执行，不能据此加载
不可信代码；运行时权限审批与跨进程隔离不在 v0.1。

**与 OpenTUI 的边界：** 不实现 `createRuntimePlugin` 那类 native module
rewrite —— buTUI 默认零 native core，不需要替换 Zig ABI 模块。

---

### 5.22 Keymap / Command Registry（v0.1 实现）

命令和快捷键分离：`CommandRegistry` 只负责命令生命周期与执行，`Keymap` 只
负责当前 scope 下哪个按键触发哪个 command。

```ts
const keymap = createKeymap();
keymap.bindCommand(
  { id: "save", title: "保存", run: () => save() },
  ["ctrl+s", "ctrl+shift+s"]
);
```

runtime 的按键顺序扩展为：

```text
onKey → keymap → useKeyboard → 内建 ctrl+c / tab → 焦点节点
```

分派规则：

- binding 先按 scope 深度，再按 `priority`，最后按注册顺序；
- `scope` 通过 `pushScope()` / `popScope()` 管理；
- binding / command 的 `when()` 返回 false 时继续尝试下一条；
- 命中并成功执行命令后调用 `preventDefault()` 并返回 true；
- 命令同步抛错或异步 rejection 进入 `onError`，不炸按键分发；
- `conflicts()` 检测同一 sequence + scope 的多条无条件绑定；
- `help()` 返回可直接渲染的快捷键帮助列表。

按键解析支持 `ctrl/alt/shift/meta` 和 `esc/return/space/pgup/pgdn/del/ins`
别名。**当前只支持单键**；多键 chord 明确抛错，不静默误解。

`@butui/keymap/solid` 提供 `useKeymap()`，用于组件或插件临时挂载 keymap。

---

### 5.23 鼠标交互（v0.1 实现）

终端输入层解码 SGR press / release / move / wheel 与修饰键；runtime 做 hit
test 后向目标节点冒泡。

事件：

- `onMouseDown` / `onMouseUp` / `onMouseMove` / `onWheel`
- `onClick`：press 没有更具体 handler 时回退
- `onDoubleClick`：runtime 按时间 + 坐标 + 节点 + button 合成 `clickCount: 2`
- `onContextMenu`：右键 press 优先派发
- `onMouseEnter` / `onMouseLeave`：合成事件，只在命中节点变化时触发且不冒泡
- `onDragStart` / `onDrag` / `onDragEnd`：左键移动超过 `dragThreshold` 后触发，
  target 固定为按下时节点；默认阈值 1 cell
- `velocityX` / `velocityY`：只在 `dragend` 上有值，单位 cell/ms；runtime 用
  最近 100ms 的指针采样计算，并可夹取最大速度
- `localX` / `localY`：相对目标节点左上角；捕获 / drag 时允许为负或超出尺寸

hover 需要终端持续上报无按键移动，因此 `mouseMotion` 有两个模式：

```text
"drag"   1000 + 1002 + 1006，默认，事件量低
"hover"  额外开 1003，支持无按键 hover，事件量高
```

指针捕获：

```ts
app.captureMouse(node);
app.releaseMouse();
app.capturedMouse();
```

捕获后 press / move / release / wheel 都发给捕获节点；release 自动解除。组件
里用 `@butui/solid` 的 `useMouseCapture()`。这解决「拖出原目标矩形后收不到
move」的问题，Slider / SplitPane 已据此实现。

文本选择仍默认接管左键拖拽；控件用 `selectable={false}` 退出选择竞争。

鼠标指针通过 OSC 22 渐进增强：

```tsx
<box cursor="pointer" onClick={() => open()}>打开</box>
<Input editor={editor} cursor="text" />
```

- `MousePointerStyle` 与 CSS / OpenTUI 名称对齐，底层提供 `osc22(shape)`。
- 节点 `cursor` 优先；未声明时，`onClick` / `onMouseDown` 等交互链自动使用
  `pointer`。
- capture 期间保持捕获节点的形状，release / stop / dispose 恢复 `default`。
- `mousePointer: false` 可关闭；默认 `mouseMotion: "drag"` 只在按键事件更新，
  无按键 hover 需要 `"hover"`。
- 相同形状去重，不重复写控制序列；终端不支持时忽略。

拖动惯性由 `@butui/solid` 的 `startDragInertia()` 提供：

```ts
const inertia = startDragInertia({
  velocityX: event.velocityX,
  velocityY: event.velocityY,
  onStep: (dx, dy) => moveBy(dx, dy),
});
```

- 使用共享 `AnimationScheduler`，指数衰减到阈值后自动退订。
- 位移按整数 cell 输出，内部保留小数余量，不丢慢速尾段。
- `TERM=dumb` / `BUTUI_REDUCED_MOTION=1|true` 默认不启动。
- `<ScrollBar>` / `<Slider>` 默认接入，`inertia={false}` 可关闭；SplitPane
  不做惯性，避免面板尺寸难以精确停下。

**已知边界：** 还没有 DOM 式 pointerId / 多指针、hover 的 `mouseover/out`
冒泡语义和跨终端窗口的 capture。

---

### 5.24 Slider（v0.1 实现）

`createSlider()` 是纯模型，`<Slider>` 只负责画轨道和接鼠标 / 键盘。

```ts
const slider = createSlider({
  value: () => value(),
  min: 0,
  max: 100,
  step: 10,
  onChange: setValue,
});
```

- `sliderValueAt(localX, track, min, max, step)` 做比例、step 和端点夹取；
- 鼠标走 `localX + capture + onDrag`，拖出矩形后继续更新；
- 释放时按 `dragend.velocityX` 默认启动惯性；`inertia={false}` 可关闭；
- 键盘支持左右 / 上下 / PageUp / PageDown / Home / End；
- 组件宽度只影响显示，不影响模型的值域；
- 和 ScrollBar 共用「本地坐标 + capture + drag」的交互模式。

---

### 5.25 SplitPane（v0.1 实现）

`createSplitPane()` 把总尺寸、分隔条占位和主窗格比例归一成整数几何：

```ts
const split = createSplitPane({
  orientation: "horizontal", // 默认，左右分栏
  ratio,
  onChange: setRatio,
  minFirst: 8,
  minSecond: 8,
});
```

```text
available = max(0, size - separator)
first     = clamp(round(available * ratio), minFirst, maxFirst)
second    = available - first
```

- `splitPaneGeometry()` 是纯函数；端点、最小尺寸和分隔条占位都精确。
- `<SplitPane>` 用两个 `flexGrow` 窗格 + 固定分隔条，嵌套时跟随父容器尺寸。
- 鼠标按下分隔条后，根节点持有 pointer capture；`onDrag` 使用相对根节点的
  `localX / localY`，因此分隔条自身移动不会改变坐标原点。
- 键盘支持方向键、PageUp/PageDown、Home/End；分隔条可获得焦点。
- `selectable={false}` 只声明在分隔条，两侧内容仍可参与全局文本选择。
- `size` 默认取终端对应轴；组件不在终端全尺寸时，应用需传入实际 cell 数。
- 当前没有折叠、嵌套拖动约束或双击复位。

---

### 5.26 动画原语与 Shimmer（v0.1 实现）

动画层不引入 CSS 模型，统一建立在共享 `AnimationScheduler` 上：

- `createTween()`：数值 / 颜色插值，duration、delay、easing。
- `createSpring()`：阻尼弹簧，固定小步长积分，避免 30fps 下高刚度发散。
- `createTimeline()`：并行 step；`sequenceSteps()` / `staggerSteps()` 生成串行 /
  错峰布局。
- 三者均支持注入 scheduler，完成 / cancel 后自动退订，并遵守 reduced-motion。

`<Shimmer>` 只负责状态文本的高亮扫过，不改变文本宽度或行数：

```tsx
<Shimmer
  text="thinking..."
  active={streaming()}
  granularity="word" // line | word | cell
  highlightWidth={6}
/>
```

- 默认 `word`；`cell` 只用于单行窄状态文本。
- 高亮按到移动中心的距离计算 intensity，再插值 base / highlight 颜色。
- `stable:false` 当前行可动画；稳定后应停止订阅并冻结。
- Diff / Markdown 不整段 shimmer；`ReasoningLine` 只在 streaming 时动画前缀。
- `reducedMotion` / `BUTUI_REDUCED_MOTION=1|true` 下静态显示。

---

### 5.17 应用上下文（v0.1 实现）

组件要能问「现在多宽 / 什么色深 / 我想订一个全局键」，但既不该认识 runtime，
也不该让应用一路传 props。`@butui/solid` 因此多了一层**应用上下文**
（和焦点上下文同构，provider 由 runtime 装）：

```text
runtime   provideAppScope({ size, colorDepth, requestPaint, onKey })
组件      useSize() / useColorDepth() / useKeyboard(fn)
```

`useSize()` 是响应式的（resize 后自动更新），`useKeyboard` 返回 `true` 就消费
这个键。**按键顺序固定**：应用 `onKey` → `keymap` → 组件 `useKeyboard` →
内建（ctrl+c / tab）→ 焦点节点 —— 应用永远第一优先级，组件只能在应用没要的
前提下抢键。

没有 runtime 上下文时两个 hook 都安全退化（`0x0` / `truecolor` / 不订阅），
所以组件单独渲染、写文档示例都不会炸。

顺带对齐了一条一致性：**resize 现在也会立刻 `flush()`**（和 `send()` 一样），
于是「resize 之后马上读 `frame()`」拿到的是一致的状态，而不是「尺寸变了但
文本还是旧的」。

---

### 5.16 Markdown / Code 落地（v0.1 实现）

JSX 里原本声明了 `input` / `markdown` / `code` 三个 intrinsic element，但布局层
根本没实现它们 —— 写 `<markdown>` 会被当成一个空盒子静默渲染。这是**类型在
撒谎**，比缺功能更糟。现在：

- **intrinsic 只留布局原语**：`box` / `row` / `column` / `text` / `spacer` /
  `scrollbox` / `layer` / `stream` / `image`。`input` / `markdown` / `code`
  从类型里删掉。
- **内容渲染器一律是组件**：`<Input>` / `<Textarea>` / `<Markdown>` / `<Code>`。
  理由：intrinsic 必须是「布局层认识的东西」；markdown 和代码高亮是**内容**
  的事，塞进布局层只会让布局层认识 markdown 语法。

**`<Markdown>` 复用流式引擎。** 静态 markdown 和流式 markdown 走同一个
`createMarkdownStream`：块解析 + 行内样式一次做完，交给 `<stream>` 节点。于是
「历史消息」和「正在流式的消息」画出来完全一样 —— 不会出现「流式时一种样子、
定稿后另一种样子」。`width` 必须由调用方给（折行宽度决定块结构，而组件拿不到
自己的列宽）。

**`<Code>` 的高亮是可替换的。** 默认实现是逐行、无跨行状态的扫描器
（`tokenizeLine`）：注释 / 字符串 / 数字 / 关键字 / 类型 / 函数 / 运算符各一色，
`#` 注释按语言开关。

不引 tree-sitter（opentui 走的路）是刻意的：那是原生依赖 + wasm 资产 + 每种
语言一份 grammar，与 §2.2「默认零 native core」冲突；而 TUI 里的代码块通常就
几十行、只求「一眼分得清」，逐行扫描还额外带来两个好处 —— **语法错误不会让
整块失色**、**流式到达的每一行都能立刻上色**（跨行状态做不到这点）。
需要更准的时候，`<Code highlight={...}>` 直接换实现。

---

### 5.15 弹窗与遮罩落地（v0.1 实现）

TUI 里「模态框」有三件事必须一起解决，缺一件就是错的：**画在视口上（不被
滚走）**、**盖住该盖的（不该盖的别盖）**、**焦点锁在里面（关掉能还回去）**。

**1. 根 `<layer>` 合成在视口之上。** 之前 `compositeLayers` 在 `measureNode`
里就把 layer 合进了父节点的行，然后视口再切片 —— 于是根上的 layer 会跟着内容
一起滚走。现在根的 layer 跳过那一步，改在 `layout()` 切完视口后合成：

```text
measureNode(root) → 不合成根的 layer
layout() 切片视口 → compositeLayers(root) → 合成到最终帧
```

（子节点里的 layer 行为不变：相对父节点定位，父节点滚它就滚。）

**2. layer 默认是透明的。** 合成时**没有样式的空白 cell 不覆盖**下面的内容，
所以「居中的模态框」不会把整屏抹成空白。要让一块区域不透明，给它 `bg` ——
容器背景会填满自己的盒子（§5.12 的那个修复正好是这里的地基）。遮罩就是
`<box width="100%" height="100%" bg="bg">`。

**3. 焦点 trap 进组件层。** `core` 一直有 `trapFocus(root, scope)`，但组件拿
不到 root。现在 `FocusScope` 多了 `trap(node)`（runtime 与 `@butui/test` 都
实现），于是 `<Dialog>` 能自己：

```text
挂载   scope.trap(node)  → Tab 只在对话框里循环，焦点落在第一个可聚焦子节点
卸载   释放            → 焦点回到打开它之前的那个节点
```

「权限弹窗关掉，输入框还是刚才那个」于是变成自动的，而不是每个应用自己记账。

**4. 顺手撞出来的 Solid 2 契约：effect 的清理函数只能靠返回值。**
`createEffect(compute, effect)` 里调 `onCleanup(fn)` 注册的清理**卸载时不会
跑**（Solid 1 会跑）。`<Dialog>` 的 trap 因此一直没释放（焦点锁死），
`<Spinner>` 的定时器一直没清（卸载后还在跑）。正确写法：

```ts
createEffect(() => dep(), () => {
  const release = scope.trap(node);
  return () => release();      // ← 只有返回值会被调用
});
```

这条写进了 `tests/solid-cleanup-contract.test.tsx` 与 README 的「必须知道的坑」。

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

@butui/runtime
  createTuiApp：终端 + 合帧重绘 + 事件分发 —— 应用作者的唯一入口

@butui/image
  协议探测、PNG 编解码、Kitty/iTerm2/Sixel/半块/占位符、安全加载、图形图层

@butui/components
  createTextEditor / <Input> / List / ScrollBar / Slider 等

@butui/plugins
  通用 SlotRegistry / Plugin / manifest / 配置 / 动态加载 / capability 门控

@butui/keymap
  CommandRegistry / 作用域 keymap / 冲突检测 / help

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
- ~~SplitPane~~ ✅ 见 §5.25
- 自动文本高度
- VirtualList
- ~~精确 ScrollBar~~ ✅ 见 §5.20

### 9.2 文本

- ANSI 感知宽度
- CJK / emoji / grapheme
- ANSI 感知折行
- ANSI 感知截断
- 行号
- 代码高亮
- Markdown
- ~~Diff~~ ✅ 见 §5.19
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
- OSC 52 剪贴板（tmux passthrough）
- OSC 22 鼠标指针形状（tmux passthrough）
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
- ~~selection~~ ✅ 见 §5.18

### 9.5 动画

- ~~timeline~~ ✅ 见 §5.26
- ~~tween~~ ✅ 见 §5.26
- ~~spring~~ ✅ 见 §5.26
- ~~easing~~ ✅ 见 §5.26
- ~~sequence~~ ✅ `sequenceSteps()`
- ~~stagger~~ ✅ `staggerSteps()`
- ~~reduced motion~~ ✅
- ~~只在需要时启动帧循环~~ ✅ 共享 `AnimationScheduler`，见 §5.19

---

## 10. 组件清单

### 10.1 基础组件

- Box
- Row
- Column
- Spacer
- Center
- ScrollBox
- ScrollBar
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

已实现（v0.1）：

- 布局原语 `Box` / `Row` / `Column` / `Spacer` / `Text`（`@butui/solid` 的
  intrinsic elements，不是包装组件）
- `ScrollBox`：`<box overflow="scroll" scrollOffset={n}>`（布局层实现）
- `Input` / `Textarea`：`createTextEditor` + `<Input>`（单行）/ `<Textarea>`
  （多行：软换行 + 垂直滚动 + 行号；OSC 22 鼠标指针默认 `text`）
- `List` / `VirtualList`：`createSelection` + `<List>` / `<VirtualList>`
  （见 §5.12）
- `Overlay` / `Portal` / `Dialog`：`<Modal>` / `<Dialog>`（根 layer + 焦点
  trap，见 §5.15）
- `Button`：`<Button>`（Enter / 空格 / 点击，焦点态自亮）
- `ProgressBar` / `Spinner` / `Badge` / `Divider` / `KeyHint` / `Shimmer`：展示组件
- `Select` / `Tabs`：`<Select>`（↑↓ + Enter）与 `<Tabs>`（←→ 立即切换）
- `Table`：列宽显式给或按内容算，支持左 / 中 / 右对齐
- `Tree`：受控展开（`expanded` + `onToggle`），←→ 展开收起、→ 进子节点
- `Markdown`：`<Markdown source width>`，走**和流式同一套引擎**（§5.7）
- `Code`：`<Code source language lineNumbers highlightLines>`，轻量逐行高亮，
  分词器可替换（见 §5.16）
- `Diff`：`<Diff source={DiffStream} height lineNumbers>`，只渲染视口行，
  支持稳定 id upsert、尾行替换和 `stable:false` 流式游标（见 §5.19）
- `ScrollBar`：`createScrollBar` / `createScrollBarFor` / `<ScrollBar>`，
  精确整数映射、轨道点击和保留 grabOffset 的拖动（见 §5.20）
- `SplitPane`：`createSplitPane` / `splitPaneGeometry` / `<SplitPane>`，
  水平 / 垂直分栏、pointer capture、键盘微调（见 §5.25）

### 10.2 Agent 组件

已实现（v0.1）：

- `StreamText` / `StreamMarkdown`（`@butui/stream`，O(1) 追加）
- `ReasoningLine`（思考流：`session.reasoningFor(turnId)`，turn 结束即丢）
- `ContextMeter`（上下文占用条 + `formatTokens`）
- `ToolCard`
- `TodoPanel`
- `PermissionDialog`
- `AskUserForm`
- `CheckpointMarker`
- `MessageView` / `MessageActions` / `MessageList`
- `UndoPreviewPanel` / `RevertConflictDialog`
- `BranchTree`
- `StatusBar`
- `AgentView`（把上面这些装成最小闭环）
- `ArtifactCanvas` / `ArtifactView`（SPEC §11.1）

待做：

- `BashProgress`
- `FoldableOutput`（通用折叠；ToolCard 已接流式 Diff）
- `SessionTree`
- `AgentTimeline`
- `CommandPalette`
- `ToolGraph`
- `BranchSwitcher`（现在只有 BranchTree）

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

#### 11.1.1 落地（v0.1 实现）

`@butui/agent` 里分成两层，边界是「能不能离开终端」：

```text
artifact-model.ts   纯函数：分类 / unified diff / 表格对齐 / sparkline / 摘要
artifacts.tsx       组件：ArtifactView / ArtifactCanvas（cell 网格）
packages/web/src    DOM 版 ArtifactPanel（复用同一批纯函数）
```

**从 tool result 直接生成。** `reducer` 在 `tool.result` 时调
`artifactsFromToolResult`：workspace 变更 → 每个文件一条 diff artifact；
其余输出按内容分类（JSON / diff / 表格 / 日志）。分类是**保守**的 —— 拿不准
就当 `log`，因为 log 的渲染是「原样显示」，永远不会骗人。时间戳取自 tool call
而不是 `Date.now()`，所以回放两次得到的状态逐字节一致（SPEC §15）。

**内容渲染必须有界。** 折叠态 6 行，展开态 200 行，超出部分明确提示还剩多少行。
一个 50MB 的日志 artifact 不能把布局拖死。

**渲染器注入。** `@butui/agent` **不依赖** `@butui/image`：图片解码要用 Bun
内建（`inflateSync`）和 `Bun.Image`，而同一份组件树还要能进 WebUI 的 browser
打包 —— 静态依赖会让 `Bun.build({ target: "browser" })` 直接报
「Browser build cannot import Bun builtin」。所以：

| 场景 | 注入的东西 |
|---|---|
| TUI | `artifactImageRenderer({ layer })` → Kitty / iTerm2 / Sixel / 半块 |
| WebUI | `<img src>`，浏览器自己解码 |
| 不注入 | 纯文本占位符（路径 + MIME），永远不炸 |

**并排比较。** pin 两张且 `compare` 打开时，两张卡在 `<row>` 里各占 `flexGrow=1`。

**它是独立面板，不在对话流里。** SPEC §19 的 AgentView 最小闭环是「消息 +
tool card + todo + 权限 + undo preview + 状态栏」；artifact 面板是 §11 的差异
化能力，由调用方决定放在哪（demo 里是宽终端下的右侧栏）。

```tsx
const layer = new ImageLayer();
<ArtifactCanvas
  artifacts={session.state.artifacts}
  session={session}                      // [open] → artifact.open 命令
  compare
  renderers={{ image: artifactImageRenderer({ layer, width: 36 }) }}
/>
```

`scripts/artifact-demo.tsx` 是纯文本快照，六种 kind 都能看：

```text
± diff   1 增 / 2 删 · --- a/src/auth.ts   ← tool:edit
▤ log    wrote src/auth.ts                 ← tool:edit
▦ table  5 行 · N push flush paint         ← tool:bench
▁▄█ chart 10 个数据点                       ← tool:perf
{} json  {"model":"solid-2-rc",…}          ← tool:cfg
🖼 image ./shots/stream-o1.png（image/png）
```

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

### 12.4 图片子系统落地（v0.1 实现）

`@butui/image` 已实现 §12.1 的五条路径。核心边界是**谁做什么**：

```text
Bun.Image（原生解码 + SIMD 重采样 + PNG 编码）
  → decodePng（TS：PNG → RGBA，只处理小图）
  → 协议编码器（TS：纯函数，字符串进字符串出）
  → <image> 节点（cell 协议）或 ImageLayer（原生协议）
```

**为什么是这条管线。** `Bun.Image` 没有 raw pixel 出口（§5.6.6），但它有
编码出口。于是：`new Bun.Image(bytes).resize(320,160).png()` 拿回一张小 PNG，
再由 ~200 行的 TS 解码器转成 RGBA。好处是重活（JPEG 解码、1/8 IDCT 降采样、
lanczos3）全在 Bun 的 C 侧，TS 只碰几十 KB 的小图。

**两条渲染路径。** 这是整个子系统最关键的分层：

| 路径 | 协议 | 产物 | 谁画 |
|---|---|---|---|
| cell | half-block / 占位符 | ANSI 行（`▀` + 24bit fg/bg） | 普通布局 + 渲染器差分 |
| 原生 | Kitty / iTerm2 / Sixel | 占位 cell + 图形序列 | 终端，`ImageLayer` 负责摆放 |

原生协议走 `Cell.graphic` 标记：布局只在占位 cell 上盖一个图片 id，
`ImageLayer` 扫帧把同一 id 的 cell 聚成矩形，**只在矩形所在行被重绘或矩形移动时**
才重发图形序列。实测无变化帧写出 0 字节 —— 图片不参与逐帧重传。

**协议选择**（`pickProtocol`）只看环境变量，不发查询序列（查询会跟输入解码器
抢字节）：Kitty（`KITTY_WINDOW_ID` / `*kitty*` / ghostty / konsole≥22.04）>
iTerm2（iTerm / WezTerm / VS Code / `LC_TERMINAL`）> Sixel（`*sixel*` /
mintty / foot / contour / VTE≥3.79）> half-block > 占位符。tmux / screen 之下
原生协议一律降级（需要 `allow-passthrough` 才透传）。

**几何**：`CELL_ASPECT = 2`（一个 cell 高 = 两个 cell 宽），所有换算先折算到
「正方形像素」再算比例，否则 contain/cover 会把图拉长一倍。`contain` 居中留白，
`cover` 放大后中心裁剪（裁剪在 RGBA 上做，因为 Bun.Image 没有 crop）。

**API**：

```tsx
const shot = createImage(() => "./shots/a.png", { policy, layer, cols: 40 });
<Image source={shot} width={40} alt="screenshot" />

// 或一步到位
const image = await renderImageFrom(path, { protocol, cols, depth, fit });
```

`createImage` 用 `createEffect(compute, effect)`（§5.6.3 的两参数形式）跟踪
source，加载中 / 失败时自动退化成纯文本占位符 —— 图片画不出来不该让 TUI 挂掉。

**安全**（对应 §12.3 五条）：路径走 `roots` 白名单 + `realpath`（symlink 逃逸
会被拦下）；MIME 只看魔数不看扩展名；`maxBytes` 在读取前检查、远程流式读取时
超限即中断；`maxPixels` 交给 `Bun.Image` 做解压炸弹防护；远程默认关闭，开启后
还要过 `authorizeRemote` 逐次授权。**绝不把用户可控字符串交给
`new Bun.Image(path)`** —— 那是任意文件读取原语。

**实测数字**（`scripts/image-demo.tsx`，96×48 测试图 → 40×10 cell）：

```text
协议        box(cell)  负载        说明
kitty       40×10      24.5 KiB    320×160 PNG（真彩）
iterm2      40×10      24.5 KiB    同一张 PNG，换 OSC 1337 包装
sixel       40×10      21.5 KiB    6×6×6 固定调色板 + 行程编码
halfblock   40×10      —           10 行 ANSI，每 cell 两个像素
placeholder 40×10      —           纯文本，NO_COLOR 兜底
```

`quantize: true` 打开 256 色调色板 PNG，同一张图 24.5 → 10.2 KiB（约 2.4×）。
对照片/截图收益明显，对平滑渐变反而可能变大 —— 用之前先量。

**已知取舍**：

- Sixel 用固定 6×6×6 调色板（确定性优先，不引入 k-means）；照片偏色，照片
  该走 Kitty / iTerm2
- iTerm2 协议**没有删除指令**，图片是画在 cell 上的，所以它依赖「占位 cell
  始终空白 + 重绘时重发」；Kitty 有 `a=d` 可以精确删除
- PNG 解码不支持 Adam7 交错（Bun 的编码器不产出；遇到会明确报错而不是画花屏）
- 半块图把 alpha 混到背景色上，不做终端背景透出
- 图片渲染是**一次性**成本（几十 ms），不进每帧路径；每帧只做 O(图片数 × 视口 cell)
  的矩形扫描

---

## 13. 事件协议

### 13.1 Agent → UI

```ts
type AgentEvent =
  | { type: "turn.start"; turnId: string }
  | { type: "text.delta"; turnId: string; delta: string }
  | { type: "reasoning.delta"; turnId: string; delta: string }
  | { type: "usage"; usage: Usage }
  | { type: "tool.start"; call: ToolCall }
  | { type: "tool.progress"; callId: string; chunk: string }
  | { type: "tool.diff"; callId: string; patch: DiffPatch; final?: boolean }
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

### 14.1 Plugin / Slot API（v0.1 实现）

- 核心协议：`@butui/plugins`
- Solid 适配：`@butui/plugins/solid`
- manifest / 配置 / 动态加载：`@butui/plugins/loader`
- 应用壳声明 Slot；插件以 `{ id, order, setup, dispose, slots }` 注册。
- 三种合成模式：`append` / `replace` / `single_winner`。
- 注册表支持 batch、响应式订阅、错误缓存和错误监听。
- loader 支持 JSON / TS 配置、包 manifest、相对路径 / 包名、工厂插件和
  统一 dispose。
- `discoverPlugins()` 默认扫描直接依赖；`extraDirs` / `includeAllInstalled`
  控制额外目录和全量 node_modules。
- manifest 可声明 capabilities；loader 在 import 前做白名单门控，严格模式
  可要求 manifest。声明不是运行时沙箱。
- 插件之间必须有错误隔离；单个插件抛错不能让整屏失效。
- 插件 API 不硬编码任何工具名；工具卡片、状态栏、帮助面板都只是 Slot 的
  普通消费者。

当前不做的：

- native runtime module rewrite；
- 运行时沙箱、权限审批 UI；
- 跨进程插件隔离。

### 14.2 Keymap / Command Registry（v0.1 实现）

- `CommandRegistry`：命令注册、when、同步 / 异步错误隔离、订阅。
- `Keymap`：scope 栈、priority、binding/command `when`、冲突检测、help。
- runtime 支持结构类型 `keymap` 选项，顺序在 `onKey` 之后、`useKeyboard`
  之前。
- `@butui/keymap/solid` 提供 `useKeymap()`。
- 当前只支持单键，多键 chord 是下一步。

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
- ~~Kitty / iTerm2 / Sixel~~ ✅ 已提前到 v0.1（§12.4）
- ~~Artifact Canvas~~ ✅ 已提前到 v0.1（§11.1.1）

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

## 18. 仍需回答的问题

1. ~~通用框架，还是 agent UI kit？~~ 已定：通用 TUI Runtime，agent UI 是上层用例。
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

第一版不追求 OpenTUI 的完整 feature parity，也不复制其 Zig renderable 层次。

第一版应该做成：

> **一个稳定的 Bun + TypeScript 通用 TUI Runtime，agent UI 作为可组合的上层用例。**

通用最小闭环：

```text
createTuiApp
  + layout / renderer / terminal
  + mouse / keyboard / focus / selection
  + components / ScrollBar / Slider / SplitPane
  + plugins / slots / keymap
  + headless test
```

Agent 上层示例：

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
