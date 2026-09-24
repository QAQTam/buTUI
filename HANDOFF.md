# buTUI Handoff

> 交接时间：2026-09-24  
> 仓库：`/home/qaqtamsy/项目/buTUI`  
> 功能基线提交：`2ac85a7 feat(mouse): hover、双击与指针捕获`
> 工作区状态：鼠标交互增强提交处干净
> 本轮能力：鼠标本地坐标 + drag 生命周期
> 当前回归：`545 pass / 0 fail`，`tsc --noEmit` 通过

## 1. 项目定位

buTUI 是面向 coding agent 的 Bun + TypeScript 终端 UI Runtime。目标不是再写一套
OpenTUI，而是提供：

- 稳定的 `createTuiApp` 应用入口；
- SolidJS 2 RC 的细粒度响应式 host renderer；
- 流式文本 / Markdown / Diff 的 O(1) 或 O(视口) 增量路径；
- agent 事件协议、Session、undo、artifact、图片等可组合层；
- 给 bugent 这类 Zig 后端复用的纯 TS 标准库接口。

设计文档：

- `SPEC.md`：总体设计、实现决策、已知取舍。
- `STABILITY.md`：稳定 API、兼容规则、明确缺口。
- `README.md`：快速开始、组件用法、实测说明。
- 本文件：接手工作必须知道的上下文与下一步。

## 2. 环境与参考源码

| 内容 | 路径 |
|---|---|
| 本仓库 | `/home/qaqtamsy/项目/buTUI` |
| Bun 源码 | `/home/qaqtamsy/项目/bun` |
| Solid 源码 | `/home/qaqtamsy/项目/solid` |
| 接入目标 | `/home/qaqtamsy/项目/bugent` |
| OpenTUI 类型参考 | `/home/qaqtamsy/.bun/install/cache/@opentui/{core,solid}@0.5.12@@@1/` |

Bun 版本：1.4.x。Solid 版本：`2.0.0-rc.9`。

## 3. 必须使用的命令

```bash
cd /home/qaqtamsy/项目/buTUI

bun --conditions=browser test
bun --conditions=browser x tsc --noEmit
```

**`--conditions=browser` 是强制项。** `solid-js@2` 的 exports map 在 node 条件下
会解析到 `dist/server.js`，表现为“代码能跑但响应式完全不更新”。`bunfig.toml`
不支持 `conditions`，插件 `onResolve` 对 bare specifier 也不生效，只能用 CLI
参数或 `BUN_OPTIONS`。

常用手工验证：

```bash
bun --conditions=browser run examples/agent-demo/src/main.tsx
bun --conditions=browser run scripts/diff-demo.tsx
bun --conditions=browser run scripts/scrollbar-demo.tsx
bun --conditions=browser run scripts/plugin-demo.tsx
bun --conditions=browser run scripts/keymap-demo.tsx
bun --conditions=browser run scripts/mouse-demo.tsx
bun --conditions=browser run scripts/scroll-demo.tsx
bun --conditions=browser run scripts/list-demo.tsx
bun --conditions=browser run scripts/stream-bench.tsx
```

真实 PTY 冒烟可参考之前的模式：

```bash
{ sleep 3; printf '\x03'; } |
  timeout 8 script -qec "stty rows 20 cols 90; bun --conditions=browser run scripts/diff-demo.tsx" /dev/null
```

## 4. 架构与包职责

```text
应用 / agent
  → @butui/runtime
    → @butui/solid
      → @butui/core
        → @butui/layout
          → @butui/renderer
            → @butui/terminal
```

| 包 | 职责 |
|---|---|
| `@butui/runtime` | `createTuiApp`：终端、合帧、事件分发、文本选择、OSC 52 |
| `@butui/core` | 节点树、`rev` 失效传播、focus、事件冒泡、theme、ANSI |
| `@butui/solid` | universal host ops、JSX 类型、编译插件、动画时钟 |
| `@butui/layout` | flex 子集、增量合成、视口窗口、文本选区提取 |
| `@butui/renderer` | cell → ANSI、逐行差分、SGR / 选区状态机 |
| `@butui/terminal` | raw mode、resize、输入解码、能力探测、OSC 52 |
| `@butui/components` | 编辑器、Input、Textarea、List、Diff、ScrollBar、弹窗等 |
| `@butui/plugins` | 通用 SlotRegistry / Plugin / 错误隔离；Solid `<Slot>` 适配 |
| `@butui/keymap` | CommandRegistry / 作用域 keymap / 冲突检测 / help；Solid `useKeymap` |
| `@butui/stream` | `LineBuffer`、MarkdownStream、DiffStream |
| `@butui/agent` | AgentEvent / UiCommand、Session、agent 组件 |
| `@butui/undo` | journal、行级 patch、undo 计划 |
| `@butui/image` | Kitty / iTerm2 / Sixel / half-block / PNG |
| `@butui/web` | 实验性 DOM 渲染，不是当前优先级 |
| `@butui/test` | headless mount、快照、事件注入 |

源码约 13,900 行，测试约 8,600 行，48 个测试文件。

## 5. 已完成能力

### 5.1 基础运行时

- `createTuiApp()`：备用屏、raw mode、鼠标、paste、focus、resize、退出还原。
- 自动合帧：任何节点 `touch()` 都合并到下一帧，不需要应用调 `paint()`。
- 键盘：应用 `onKey` → `keymap` → `useKeyboard` → 内建 tab / ctrl+c → 焦点节点。
- 鼠标：语义 hit test、事件冒泡、`onMouseDown/Move/Up`。
- `stickyTop` / `stickyBottom` 和根 `<layer>` 覆盖。
- `useSize` / `useKeyboard` / `useColorDepth`。

### 5.2 流式 O(1)

- `LineBuffer`：纯文本增量折行。
- `MarkdownStream`：增量 markdown。
- `<stream>`：整段流只对应一个宿主节点。
- 视口只复制可视行。
- 回归测试 `tests/stream-o1.test.tsx` 和 `tests/stream-source.test.tsx`。

### 5.3 组件标准库

已实现：

- 编辑器：`createTextEditor` / `<Input>` / `<Textarea>`。
- 列表：`createSelection` / `<List>` / `<VirtualList>`。
- 滚动：`createScrollView` / `createScrollBar` / `createScrollBarFor` /
  `<ScrollBar>`。
- 内容：`<Markdown>` / `<Code>` / `<Diff>`。
- 选择类：`<Select>` / `<Tabs>` / `<Table>` / `<Tree>`。
- 弹窗：`<Button>` / `<Dialog>` / `<Modal>`。
- 展示：`ProgressBar` / `Spinner` / `Badge` / `Divider` / `KeyHint`。

### 5.4 鼠标文本选择 + OSC 52

`createTuiApp` 默认开启左键文本选择：

```tsx
const app = createTuiApp({
  view: () => <App />,
  selection: {
    copyOnSelect: true,
    onSelection: selection => console.log(selection?.text),
  },
});
```

保证：

- CJK / emoji 按 grapheme，边界命中宽字符会复制完整字符。
- 跨行选择、行尾补白裁剪。
- 选区只标在最终 frame 的 cell 上，不进入布局缓存。
- `selectable={false}` 可从命中节点向上阻止文本选择，供 ScrollBar 等控件使用。
- OSC 52 是 best-effort，终端可忽略，没有确认通道。

### 5.5 流式 Diff

后端负责 diff 算法，前端只消费结构化行 upsert。

```ts
{
  type: "tool.diff",
  callId: "c1",
  patch: {
    ops: [{
      op: "upsert",
      lines: [{
        id: "file:hunk:add:1:2",
        kind: "add",
        text: "const x = 1",
        newLine: 2,
        stable: false,
      }],
    }],
  },
  final: false,
}
```

规则：

- `id` 对同一逻辑行必须稳定。
- 重复 upsert 同一 id = 更新，不重复追加。
- `replaceTail` 只重算最后 N 行。
- `stable:false` 表示仍可能被后续 chunk 改写。
- `final:true` / `tool.result` / `turn.end` 自动定稿。
- 不要用数组下标或文本 hash 当 id。

前端：

- `createDiffStream()`：Map O(1) 定位，逐行版本号。
- `<Diff height lineNumbers scrollbar>`：只创建视口行，长行截断。
- context 行轻量语法高亮，add / remove 保持红绿语义。
- `ToolCard` 已自动接 `session.diffFor(callId)`。
- `scripts/diff-demo.tsx` 可观察同一行反复 upsert。

### 5.6 动画基础

- `AnimationScheduler`：进程内单例，默认 30fps，有订阅者才启动。
- `useAnimationFrame()`：Solid 访问器，支持 `enabled` 和测试注入。
- `tick()` 可手动驱动，内部会 `flush()`，确保 runtime 收到节点变更。
- `TERM=dumb` / `BUTUI_REDUCED_MOTION=1|true` 降级。
- 当前唯一消费者：Diff 的 `stable:false` 流式游标。
- 不要把 shimmer 铺到整条 markdown / 整个 diff；只做局部状态行或当前变化行。

### 5.7 精确 ScrollBar

纯几何模型：

```text
maxTop     = max(0, total - viewport)
thumbSize  = max(1, min(track, floor(track * viewport / total)))
thumbRange = track - thumbSize
thumbStart = round(thumbRange * top / maxTop)
top        = round(maxTop * thumbStart / thumbRange)
```

API：

```tsx
const view = createScrollView();
const bar = createScrollBarFor(view);

<row>
  <box flexGrow={1}>…</box>
  <ScrollBar model={bar} />
</row>
```

也支持任意滚动源：

```tsx
const bar = createScrollBar({
  top: () => offset(),
  total: () => rows.length,
  viewport: () => height,
  track: () => height,
  onScroll: setOffset,
});
```

保证：

- 端点精确：`top=0 → thumbStart=0`，`top=maxTop → thumbStart=thumbRange`。
- 拖拽保留 `grabOffset`。
- 点击轨道默认居中 thumb；`jump(y, "start")` 精确到顶部。
- 每行轨道就是局部坐标，不扫描 frame / 不依赖节点 bbox。
- `<Diff scrollbar>` 已接入。
- 当前仅垂直轴。

### 5.8 通用插件 / Slot

参考 OpenTUI 的 `Plugin` / `SlotRegistry` 接口，但保持纯 Bun/TS、零 native。

- `@butui/plugins`：`Plugin` / `SlotRegistry` / `createSlotRegistry`。
- `@butui/plugins/solid`：`createSolidSlotRegistry` / `createSlot` / `<Slot>`。
- `@butui/plugins/loader`：manifest / JSON+TS 配置 / 动态 import / 工厂插件 /
  直接依赖自动发现 / capability 门控。
- 排序：`order` → 注册顺序 → `id`。
- 模式：`append` / `replace` / `single_winner`。
- 生命周期：`setup`（可返回 cleanup）→ `dispose`。
- 错误隔离：load / setup / render / dispose 失败进错误缓存，单插件失败不影响其它插件。
- `createSlotRegistry(host, key, context)` 同一 key 必须复用同一个 context 对象。
- manifest 支持 `butui.plugin.json` 或 `package.json#butui`；模块支持 default /
  named `plugin` / 工厂函数。
- `discoverPlugins()` 默认只发现 dependencies / optionalDependencies；支持
  `extraDirs` 与 `includeAllInstalled`。
- `allowedCapabilities` 在动态 import 前拦截未授权能力；`requireCapabilities`
  可要求 manifest。**不是沙箱。**
- 已有 `scripts/plugin-demo.tsx`、`scripts/plugins/` 和
  `tests/plugins.test.ts` / `tests/plugin-slot.test.tsx` /
  `tests/plugin-loader.test.ts`。

### 5.9 命令 / Keymap

- `@butui/keymap`：`CommandRegistry` / `createKeymap`。
- `@butui/keymap/solid`：`useKeymap`。
- runtime `keymap` 选项顺序：`onKey` → `keymap` → `useKeyboard` → 内建 →
  焦点节点。
- scope 深度 → priority → 注册顺序。
- `when()` 支持 binding 与 command 两级；失败继续下一条。
- 冲突检测、help 列表、同步 / 异步命令错误隔离已实现。
- 单键解析支持 `ctrl/alt/shift/meta` 和 `esc/return/space/pgup/pgdn/del/ins`。
- 当前不支持多键 chord。
- 已有 `scripts/keymap-demo.tsx`、`tests/keymap.test.ts` /
  `tests/keymap-runtime.test.tsx`。

### 5.10 鼠标交互增强

- 原生事件：press / release / move / wheel（SGR 1006）。
- runtime hit test → 节点冒泡；`onMouseDown/Up/Move/Click/Wheel`。
- 新增合成 `onMouseEnter` / `onMouseLeave`，只在命中节点变化时触发且不冒泡。
- 新增 `localX` / `localY`：相对目标节点左上角，捕获 / drag 可为负。
- 新增 `clickCount`、`onDoubleClick`、`onContextMenu`（右键）。
- 新增 `onDragStart` / `onDrag` / `onDragEnd`，超过 `dragThreshold` 后触发，
  target 固定为按下节点。
- `mouseMotion: "hover"` 开启 1003；默认 `"drag"`。
- `app.captureMouse(node)` / `releaseMouse()` / `capturedMouse()`；Solid 提供
  `useMouseCapture()`。release 自动解除捕获。
- 文本选择仍默认接管左键拖拽；控件用 `selectable={false}`。
- 已有 `scripts/mouse-demo.tsx`、`tests/mouse-interaction.test.tsx`。

## 6. 稳定接口入口

| 入口 | 文件 |
|---|---|
| `createTuiApp` / `TuiApp` / 文本选择 | `packages/runtime/src/index.ts` |
| `AgentEvent` / `tool.diff` 线协议 | `packages/agent/src/protocol.ts` |
| Session / `diffFor()` | `packages/agent/src/session.ts` |
| `DiffStream` / `DiffPatch` | `packages/stream/src/diff.ts` |
| `<Diff>` | `packages/components/src/diff.tsx` |
| ScrollBar 几何模型 | `packages/components/src/scrollbar.ts` |
| `<ScrollBar>` | `packages/components/src/scrollbar.tsx` |
| Plugin / SlotRegistry | `packages/plugins/src/{types,registry}.ts` |
| Plugin loader / manifest / config / discovery | `packages/plugins/src/{loader,manifest,config,discovery}.ts` |
| Solid `<Slot>` | `packages/plugins/src/solid.tsx` |
| CommandRegistry / Keymap | `packages/keymap/src/{commands,keymap,keys}.ts` |
| Solid `useKeymap` | `packages/keymap/src/solid.ts` |
| 鼠标捕获 / 双击 / hover | `packages/runtime/src/index.ts`、`packages/core/src/{events,dispatch}.ts` |
| Solid `useMouseCapture` | `packages/solid/src/app-context.ts` |
| 动画调度 | `packages/solid/src/animation.ts` |
| 布局 / Frame / selectionText | `packages/layout/src/index.ts` |
| 渲染器 | `packages/renderer/src/index.ts` |
| 终端输入 / OSC 52 | `packages/terminal/src/{input,index}.ts` |

## 7. bugent 接入状态

**已按用户决策跳过 bugent 联合调测。** 当前主线是做通用 TUI 能力，对标
OpenTUI 的接口设计，但保持 Bun + TypeScript、默认零 native core。

`@butui/agent` 仍作为上层用例保留；除非用户重新指定，不再优先投入 bugent
bridge、真实 tool event 对接或 bugent 快捷键迁移。

## 8. 关键坑

### Solid 2 RC

1. **`--conditions=browser` 必带**。
2. **signal 写入延迟到 flush**。需要同步读的值放局部变量，signal 只当版本号。
3. **`createEffect` 必须两个参数**：compute + effect。
4. **cleanup 必须从 effect 返回**；在 effect 体里调 `onCleanup` 不会执行。
5. **`createContext` 返回 provider 函数本身**；默认值用 `null`，`children` 必须是
   getter。
6. **不要用 `<For>` 渲染流式行数组**；用单个 `<stream>` / `<Repeat>`。
7. **universal JSX 属性值不能是 JSX 元素 / Fragment**。
8. **循环响应式依赖会 `[REACTIVITY_HALTED]`**。

### 终端 / 渲染

9. `Bun.color` 只产前景序列；背景要 `38;` → `48;`。
10. `Bun.deflateSync` 是 raw deflate；PNG IDAT 需要 zlib。
11. `Bun.Image` 没有 raw pixel 出口，需要转 PNG 后解析。
12. SGR mouse motion 是 `b=32+button`，不能只认 `buttonCode===3`。
13. OSC 52 没有 ACK；tmux 需要 passthrough。
14. 文本选择与控件拖拽冲突时，用 `selectable={false}`，不要靠坐标白名单。

### Diff / 动画

15. Diff line id 必须稳定；下标 / hash 都会导致全量重建。
16. `replaceTail` 只适合尾部重算；任意 splice 会让虚拟列表和滚动锚点失效。
17. 动画只更新变化行；整屏 shimmer 会破坏流式差分价值。
18. `<Diff>` 行必须固定 1 行并 `truncate`，不能折行。
19. ScrollBar 的轨道局部坐标来自每个轨道行；不需要也不应该扫描整帧找 bbox。

### 包边界

20. `@butui/agent` 不能静态依赖 `@butui/image`，browser 打包会碰 Bun builtin。
21. `bun test` 的 preload 要写在 `[test].preload`，顶层 `preload` 只影响
    `bun run`。
22. `@butui/web` 是实验层；当前 WebUI 尚未消费 `tool.diff`。

## 9. 测试与验收

当前：

```text
545 pass / 0 fail
54 test files
tsc --noEmit pass
```

重点回归：

- `tests/stream-o1.test.tsx`
- `tests/text-selection.test.tsx`
- `tests/diff-stream.test.ts`
- `tests/diff.test.tsx`
- `tests/agent-diff.test.tsx`
- `tests/scrollbar.test.tsx`
- `tests/animation.test.tsx`
- `tests/plugins.test.ts`
- `tests/plugin-slot.test.tsx`
- `tests/plugin-loader.test.ts`
- `tests/keymap.test.ts`
- `tests/keymap-runtime.test.tsx`
- `tests/mouse-interaction.test.tsx`
- `tests/solid-cleanup-contract.test.tsx`

提交前至少跑：

```bash
bun --conditions=browser test
bun --conditions=browser x tsc --noEmit
git diff --check
```

涉及鼠标 / 终端输出时，再跑一次真实 PTY 冒烟。

## 10. 已知缺口

- 插件已有 manifest / 配置 / 直接依赖发现 / capability 门控；无运行时沙箱 /
  权限审批 / 跨进程隔离。
- 鼠标已有 hover / 双击 / 右键 / pointer capture / local 坐标 / drag 生命周期；
  无 pointerId、多指针、OSC 22 指针形状、惯性。
- Keymap 只有单键；无多键 chord、前缀超时、用户自定义绑定持久化。
- Diff 没有 word-level diff、任意位置删除、hunk 折叠、“滚开后有新行”提示。
- ScrollBar 只有垂直轴；无自动隐藏、hover 展开、水平轴、惯性。
- 动画只有共享时钟和 Diff 游标；无 tween / spring / timeline / shimmer。
- 编辑器模型没有内部选区、剪贴板历史、撤销栈。
- 列表只支持单列 + 固定行高，变高行不支持。
- `flexShrink` 未实现。
- 文本选择是视口坐标，滚动后不保持内容锚点，也不会拖到边缘自动滚。
- WebUI 是实验层，尚未渲染 `tool.diff`。
- Kitty keyboard protocol 发送侧未实现。

## 11. 推荐下一步

按通用 TUI 收益排序：

1. **鼠标组件适配**：把 `localX/localY + drag` 接进 ScrollBar / slider / split
   pane；再考虑 OSC 22 指针形状与惯性。
2. **Keymap 扩展**：多键 chord、前缀超时、用户自定义绑定持久化、Command Palette。
3. **插件运行时约束 / 审批**：capability 目前只是 import 前门控，下一步做权限
   审批 UI 或 worker 隔离。
4. **Portal / Dynamic / Toast / Tooltip**：补齐 OpenTUI 已有的通用组件接口。
5. **Timeline / tween / spring**：建立在现有 `AnimationScheduler` 上。
6. **ScrollBar 扩展**：水平轴、自动隐藏或 hover，只有在真实 UI 需要时做。
7. **自定义 renderable / component catalogue**：保持 Bun/TS 的 tag→节点映射，
   不照搬 OpenTUI 的 Zig Renderable 类层次。
8. **WebUI diff**：等 WebUI 重新成为优先级再做。

## 12. 协作约定

- 用户使用中文，偏好简洁、有明确观点。
- “可以 / 继续 / 看你”表示授权自主决策。
- 每完成一个可独立验收的能力就提交一次 git。
- 当前提交身份使用：

```bash
git -c user.name=AnyBuddy -c user.email=anybuddy@local commit
```

- 新组件完成后同步：
  - `packages/components/src/index.ts`
  - `SPEC.md`
  - `STABILITY.md`
  - `README.md`
  - 对应测试
- 不要把 bash/read_file/edit_file/todo_write/ask_user 等具体工具硬编码进核心。
- 保持默认零 native core；优先 Bun 主线 API 和纯 TS。

## 13. 接手检查清单

```text
[ ] git status 干净
[ ] bun --conditions=browser test 全绿
[ ] bun --conditions=browser x tsc --noEmit 通过
[ ] 需要真终端时跑 agent-demo / diff-demo / scrollbar-demo
[ ] 修改流式路径时看 stream-o1
[ ] 修改鼠标时看 selection + scrollbar 回归
[ ] 修改 agent 协议时看 agent-protocol + agent-replay
[ ] 修改插件 / Slot 时看 plugins + plugin-slot + plugin-loader
[ ] 修改命令 / Keymap 时看 keymap + keymap-runtime + input
[ ] 修改鼠标时看 mouse-interaction + text-selection + scrollbar
[ ] 完成后更新 README / SPEC / STABILITY
```

