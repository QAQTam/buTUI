# 稳定接口契约

> buTUI 的定位是**底层**：应用（agent / 工具 / 自己的 TUI）依赖这份契约，
> 我们负责渲染、布局、输入、增量更新这些脏活。
>
> 这份文档回答一个问题：**「我拿 buTUI 画 TUI，哪些东西可以放心依赖？」**

## 0. 十行起步

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

`createTuiApp` 负责：备用屏、raw mode、鼠标 / paste / focus 开关、root 节点、
`render()`、合帧重绘、resize 重排、键盘 → 焦点节点、鼠标 → hit test、tab 循环
焦点、ctrl+c 退出与终端还原。

**不需要自己调 paint。** 任何节点变更（signal、定时器、异步图片加载）都会通知
运行时并合并到下一帧。这是 §2 里唯一一条最重要的保证。

## 1. 稳定 / 实验 / 内部

| 层 | 包 | 状态 |
|---|---|---|
| 应用运行时 | `@butui/runtime` | **稳定**（v0.1 冻结） |
| 节点 / 事件 / 焦点 / 主题 | `@butui/core` | **稳定** |
| JSX 与编译 | `@butui/solid` | **稳定**（含 `AnimationScheduler` / `useAnimationFrame` / tween / spring / timeline） |
| 布局 | `@butui/layout` | **稳定**（`Cell` / `Line` / `Frame` / `layout`） |
| 渲染 | `@butui/renderer` | **稳定**（`Renderer` / `plainText` / `paintLine`） |
| 终端 | `@butui/terminal` | **稳定**（`TerminalSession` / 输入解码 / 能力探测 / `osc22` / `osc52`） |
| 基础组件 | `@butui/components` | **稳定**（编辑器 / 选择 / 列表 / 滚动 / ScrollBar / Slider / SplitPane / CommandPalette / Diff / 弹窗 / 展示组件） |
| 插件 / Slot | `@butui/plugins` | **稳定**（`Plugin` / `SlotRegistry`；Solid 适配在 `@butui/plugins/solid`；loader 在 `@butui/plugins/loader`） |
| 命令 / Keymap | `@butui/keymap` | **稳定**（`CommandRegistry` / `Keymap`；Solid 适配在 `@butui/keymap/solid`） |
| 流式文本 | `@butui/stream` | **稳定**（`StreamSource` / `DiffStream` / `<stream>`） |
| 图片 | `@butui/image` | **稳定**（`createImage` / `ImageLayer` / `renderImage`） |
| Agent 协议与组件 | `@butui/agent` | **稳定**（`AgentEvent` / `UiCommand` / `Session` / `tool.diff`） |
| Undo | `@butui/undo` | **稳定**（journal / patch / plan） |
| WebUI | `@butui/web` | 实验（DOM 渲染，接口可能动） |
| 测试基建 | `@butui/test` | **仅测试用**，不保证兼容 |

「稳定」= 按 §3 的兼容规则演进。除此之外的 `packages/*/src/**` 内部模块、
布局缓存策略、`Box.frozen` 的具体取值都不属于契约。

## 2. 运行时契约

`createTuiApp(options)` 返回 `TuiApp`：

```ts
interface TuiApp {
  readonly root: Node;
  size(): TuiSize;                  // 响应式：resize 后读到新值
  colorDepth(): ColorDepth;
  start(): void;                    // autoStart 默认 true
  stop(): void;                     // 幂等，还原终端
  paint(): RenderStats;             // 立刻画一帧（一般不用调）
  requestPaint(): void;             // 请求一帧，微任务合并
  send(event: ButuiEvent): number;  // 自定义输入源 / 测试注入
  frame(): Frame;                   // 当前布局（现算，不是「上一帧」）
  selection(): TextSelectionSnapshot | null; // 当前鼠标选区
  selectedText(): string;
  clearSelection(): void;
  copySelection(): boolean;         // 再写一次 OSC 52
  focusedId(): number | null;       // 响应式焦点
  isFocused(node?: Node): boolean;  // O(1)
  focus(node?: Node): void;
  dispose(): void;                  // stop + 解绑所有订阅
}
```

**保证：**

1. **自动重绘。** 任何 `touch()`（= 任何节点变更）都会合并到下一帧，同一 tick
   内多次变更只画一次。异步变更不需要任何手动通知。
2. **事件顺序固定**：`onKey`（应用级，返回 `true` 即消费）→ `keymap` →
   `useKeyboard` → 内建（ctrl+c、tab/shift+tab）→ 焦点节点（向上冒泡）。
   鼠标：hit test 命中节点 → 冒泡；**没有节点处理**才走 `onMouse`。
3. **resize 一定会整屏重画**（不是差分），`size()` 在重排前更新。
4. **`dispose()` 之后不再写终端**，所有订阅解除。
5. **默认 `scroll: "bottom"`**：内容超出视口时贴底（聊天式）。固定布局传
   `scroll: () => "top"`。
6. **`afterDraw`** 的返回值会拼在同一批写入里（原生图片协议挂这里）。
7. **`send()` 结束前会 `flush()`**：事件引发的 signal 写入立刻落到节点树上，
   所以「send 之后读 `frame()`」永远是一致的。真正的**绘制**仍在微任务里合并。
8. **`frame()` 是现算的当前布局**（布局层按 rev 缓存，很便宜），不是「上一次
   画出来的帧」—— 测试和 hit test 拿到的都是最新状态。
9. **文本选择默认开启且不进入布局缓存。** 左键拖拽只给最终帧的 cell 打
   `selected` 标记，不 `touch()` 节点；松开时默认写 OSC 52。`selection: false`
   可完全关闭。OSC 52 是 best-effort，不保证终端接受。

**不保证：** 一帧内的重绘次数上限；`paint()` 之外的时序细节；`root` 的子结构。

## 3. 兼容规则

- **只增不改**：新增可选字段、新增事件 / 命令类型、新增组件属性 —— 都是小版本。
- **不改语义**：已有字段的含义、事件的顺序、`AgentEvent` 的 reducer 结果不变。
- **破坏性变更**：删字段 / 改语义 / 改默认值 → 大版本，并写进 `CHANGELOG`。
- **协议兼容**：`AgentEvent` / `UiCommand` 是 NDJSON 上的线协议，按「未知字段
  忽略、未知类型跳过」设计（`decodeNdjson` 对坏行不阻塞）。
- **包边界**：`@butui/*` 的 `index.ts` 导出面就是契约；深路径导入
  （`@butui/core/src/...`）不受支持。

## 4. 应用作者会用到的具体 API

### 4.1 视图与组件

`<box>` `<row>` `<column>` `<text>` `<spacer>` `<scrollbox>` `<input>`
`<layer>` `<stream>` `<image>` —— 类型见 `@butui/solid` 的
`types/jsx-runtime.d.ts`（`jsxImportSource` 指向 `@butui/solid`）。

通用属性：`width/height`（数字或 `"50%"`）、`padding/margin`、`gap`、`border`、
`flexGrow`、`align/justify`、`overflow`、`semantic`、`focusable`、`disabled`、
`onClick/onKey/onPaste/onWheel/onFocus/onBlur`。
`<text>` 与 `<box>` 的交互属性**完全对齐**（列表项可以直接 Tab 到）。

### 4.2 事件与焦点

```ts
import { createModifiers, dispatchEvent, focusNext, focusPrev, focusNode,
         focusedNode, getFocusState, trapFocus, isFocusable } from "@butui/core";
```

`semantic` 是 hit test 的返回值（`message:m1` / `tool:c1` / 你自己的
`artifact:<id>`）。鼠标事件自动带上 `event.semantic`，handler 不用自己算。

### 4.3 主题与颜色

`<text color="accent">` 里的 token 由 `@butui/core` 的 theme 解析；终端色深由
运行时探测（`NO_COLOR` / `TERM` / `COLORTERM`），应用不用管。

### 4.4 流式文本

```ts
import { createMarkdownStream, StreamMarkdown } from "@butui/stream";
const source = createMarkdownStream({ width: 60 });
source.push(delta);
```

契约：`source.lines` 只增不改（同一个数组引用）；每条 delta 的成本是
`O(|delta| + W)`，与已累积长度无关（SPEC §5.7）。

### 4.5 图片

```ts
import { ImageLayer, artifactImageRenderer, createImage } from "@butui/image";
const layer = new ImageLayer();
createTuiApp({ ..., afterDraw: (frame, stats) => layer.render(frame, stats.changed) });
```

### 4.6 焦点可观察（组件知道自己是不是焦点）

```tsx
import { type Node } from "@butui/core";
import { useFocus } from "@butui/solid";
import { createSignal } from "solid-js";

function Item(props: { label: string }) {
  const [node, setNode] = createSignal<Node>();
  const isFocused = useFocus();
  return <text ref={setNode} focusable color={isFocused(node()) ? "accent" : "muted"}>{props.label}</text>;
}
```

- `ref` 拿到自己的节点（这是唯一途径，`ref` 已加进所有元素的 JSX 类型）
- `useFocus()` 返回 `(node?) => boolean`，O(1) 且响应式；焦点变化自动重绘
- 没有运行时上下文时安全退化成 `false`（组件不会炸）
- 需要在运行时之外驱动（测试）时，`@butui/test` 的 `mount` 也提供同样的上下文

### 4.7 输入：`createTextEditor` + `<Input>`

```tsx
const editor = createTextEditor({ onSubmit: value => session.submit(value) });
<Input editor={editor} placeholder="说点什么…" autoFocus />
```

编辑器（纯逻辑，可单测）覆盖：光标移动（按 **grapheme**，emoji / CJK 不会被
劈开）、插入 / 退格 / 删除、词跳转、`ctrl+a/e/u/k/w`、`↑↓` 历史、多行模式、
粘贴。`<Input>` 负责画：光标（bar / block）、水平滚动（光标永远可见）、占位符。

`<Input>` 的按键优先级：`props.onKey`（返回 true 即消费）→ 编辑器。

多行输入用 `<Textarea editor={editor} height={5} lineNumbers />`（同一个编辑器
模型，`multiline: true`）。它做软换行（按 grapheme + 显示宽度）、垂直滚动跟随
光标、可选行号；**多行模式下 ↑↓ 是上下移动光标**，单行模式才是翻历史。

### 4.8 列表与选择：`createSelection` + `<List>` / `<VirtualList>`

```tsx
const sel = createSelection({ count: () => filtered().length, onChange: i => preview(i) });

<List
  items={filtered()}
  selection={sel}
  height={12}                 // 给高度 = 裁剪 + 跟随滚动
  renderItem={item => <text>{item}</text>}
  onActivate={item => open(item)}
/>
```

- `createSelection` 是纯逻辑：`index()` / `count()` / `setIndex` / `move` /
  `home` / `end` / `page` / `handleKey` / `follow`。认 `↑↓ Home End
  PageUp/PageDown Ctrl+P/N`（`vim: true` 再加 `j/k`）。`Enter` 不归它管。
- `count` 可以是**访问器** —— 过滤结果一变，索引自动跟着夹取，不用手动同步。
- `<List>` 渲染全部条目（几十行的菜单）；`<VirtualList>` 只渲染可见窗口
  （上万条也行，行数恒定）。**不传 `height` 就没有视口**：退化成全渲染 +
  交给父容器滚动。
- 行内容请写成 `renderItem={item => ...}`（`item` 是访问器读出来的当前值）；
  `state.selected()` 是**访问器**，不是布尔值。
- 滚轮移动选中项（`wheelStep`，默认 1）；点击某行即选中，默认顺带把焦点交给
  列表（`focusOnClick={false}` 关掉）。

**命令面板不需要新组件**：`<Input>` 聚焦时 `onKey={e => sel.handleKey(e)}`
就让方向键归列表、字符归编辑器（`onKey` 先于编辑器）。

### 4.9 应用上下文：`useSize` / `useKeyboard` / `useColorDepth`

```tsx
import { useColorDepth, useKeyboard, useSize } from "@butui/solid";

const size = useSize();        // 响应式 { columns, rows }；无 runtime 时 0x0
const depth = useColorDepth(); // truecolor / 256 / 16 / none
useKeyboard(event => {         // 全局按键；返回 true 即消费；卸载自动退订
  if (event.name === "escape") return close();
}, { enabled: () => isOpen() });
```

按键顺序是契约：**应用 `onKey` → `keymap` → 组件 `useKeyboard` → 内建
（ctrl+c / tab）→ 焦点节点**。应用永远第一优先级。

### 4.10 内容渲染：`<Markdown>` / `<Code>`

```tsx
<Markdown source={message.text} width={72} />
<Code source={diff} language="ts" lineNumbers highlightLines={[3, 4]} />
```

- `<Markdown>` 走的是**和流式同一套引擎**，所以历史消息和流式消息长得一样。
  `width` 要自己给（折行宽度决定块结构）。
- `<Code>` 默认用内置的逐行高亮（无跨行状态），`highlight={...}` 可换成自己的
  分词器；`maxLines` 截断、`highlightLines` 标改动行。

**JSX intrinsic 只包含布局原语**（`box` / `row` / `column` / `text` / `spacer` /
`scrollbox` / `layer` / `stream` / `image`）。内容渲染一律走组件 —— 以前
`<input>` / `<markdown>` / `<code>` 只有类型没有实现，写下去会静默变成空盒子，
现在从类型里删掉了。

### 4.11 选择类与结构化展示

```tsx
<Select options={[{ value: "a", label: "A", description: "…" }]} value={v()} onChange={setV} />
<Tabs items={[{ value: "chat", label: "对话" }, { value: "diff", label: "改动", badge: "3" }]}
      value={tab()} onChange={setTab} />
<Table columns={[{ key: "file", title: "文件", width: 20 },
                 { key: "add", title: "+", width: 4, align: "right" }]}
       rows={rows} />
<Tree nodes={files} expanded={open()} onToggle={toggle} onActivate={openFile} />
```

- `<Select>`：竖排选项，↑↓ 移动、Enter / 点击确认；`heading` / `disabled`
  项照常显示但跳过（不参与键盘导航）。`value` 变化会同步高亮。
- `<Tabs>`：横排分段控件，←→ **立即**切换（不用再按 Enter）。
- `<Table>`：列宽显式给或按内容算；`align` 用 left / center / right。
  不画竖线（终端里浪费列宽，复制出来也难看）。
- `<Tree>`：**受控**展开（`expanded` + `onToggle`），←→ 展开收起 / 进出子节点，
  Enter 在叶子上触发 `onActivate`。内部就是「按展开状态拍平 + `<List>`」，
  所以虚拟化、滚动跟随、鼠标点击全都复用。

### 4.12 弹窗与基础展示组件

```tsx
<Button tone="success" onPress={allow}>允许</Button>

// Modal 挂在**视图根部**（顶层 <box> 的兄弟节点）
<Modal open={asking()} title="允许执行？" onDismiss={deny}>
  <text>rm -rf node_modules</text>
  <row gap={2}>
    <Button tone="success" onPress={allow}>允许</Button>
    <Button tone="danger" onPress={deny}>拒绝</Button>
  </row>
</Modal>
```

- `<Button>`：可聚焦，Enter / 空格 / 点击触发；`plain` 只做焦点高亮。
- `<Dialog>`：带边框标题的卡片，**自动 trap 焦点**，Esc 触发 `onDismiss`。
  关掉之后焦点回到打开它之前的那个节点。
- `<Modal>`：`<layer>` + 遮罩 + 居中。**必须在视图根部** —— `<layer>` 相对
  父节点定位，父节点会被滚走；只有根上的 layer 合成在视口之上。
- 展示组件：`ProgressBar`（含 `indeterminate` + `phase`）、`Spinner`
  （受控 `frame` 或自走）、`Badge`、`Divider`、`KeyHint`。颜色一律走主题
  token，语义色用 `tone`。

### 4.13 滚动视口：`createScrollView`

```tsx
const view = createScrollView();
createTuiApp({
  view: () => <box>{lines().map(line => <text>{line}</text>)}</box>,
  scroll: view,                            // 可调用 → 直接当选项传
  stickyBottom: 1,                         // 最后一行固定（状态栏）
  afterDraw: frame => view.measure(frame),
  onKey: event => view.handleKey(event),
  onMouse: event => view.handleWheel(event),
});
```

**保证：** 贴底时新内容自动跟着走（`scroll()` 返回 `"bottom"`，不需要任何
通知）；用户往回翻之后新内容**不会**把视口拽回去；滚回底部自动恢复跟随。
`handleKey` 认 `↑↓ PageUp/PageDown Home End`（Ctrl/Alt/Meta 组合一律放行，
交给编辑器）；`handleWheel` 认上下滚轮。

- `view.measure(frame)` 每帧收一次真实位置（布局夹取后的 `top`）。**必须接**，
  否则模型不知道内容有多长。
- `view.top() / total() / height() / maxTop() / following() / atBottom()` 都是
  响应式的，可以直接写进视图（状态栏 / 「↓ 新消息」提示）。
- `frame().top` 与 `scroll` 选项是**同一个坐标系**（滚动区内的行号），固定
  页眉页脚不会破坏 `maxTop === total - height`。

**固定页眉 / 页脚**用 `createTuiApp({ stickyTop, stickyBottom })`：取内容的
前 / 后 N 行固定在视口两端。注意 `<layer>` 做不到这件事 —— 它相对父节点定位，
父节点自己会被滚走。

### 4.14 鼠标文本选择与剪贴板

`createTuiApp` 默认提供全局文本选择，不需要组件配合：

```tsx
const app = createTuiApp({
  view: () => <App />,
  selection: {
    copyOnSelect: true,                    // 默认
    onSelection: selection => {
      if (selection) console.log(selection.text);
    },
  },
});

app.selectedText();
app.copySelection();
app.clearSelection();
```

- 左键按下开始，`move` 更新，松开定稿；CJK / emoji 边界落在任一 cell 都会
  复制完整 grapheme。
- 跨行首行到行尾、中间全行、末行到焦点；frame 为填满终端补的尾部空白不会
  进入剪贴板。
- `onSelection` 只在定稿 / 清除时调用，不会为每个 mouse-move 高频触发。
- `selection: false` 完全关闭；`enabled: () => false` 可动态暂停。
- 默认 `copyOnSelect: true` 写 OSC 52（tmux 下自动 passthrough）。
- 任何节点可声明 `selectable={false}`；命中该节点 / 子树时不启动文本选择，
  用于 scrollbar、按钮等需要自己接管拖拽的控件。
- 选择是**当前视口坐标**，不是内容锚点。resize 会清除；滚动 / 内容重排后
  选区仍指向新的同一屏幕位置。需要跨滚动稳定锚点时，应用要在
  `onSelection` 里保存语义节点与文本。

### 4.15 Agent 协议

```ts
import { createSession, decodeNdjson, encodeNdjson } from "@butui/agent";
session.dispatch(event);       // AgentEvent
session.send(command);         // UiCommand
```

UI 不读 agent 内部状态、不调 agent 方法 —— 只消费事件、只发命令。所以回放 /
remote attach / 多套渲染都是「换个传输层」。

**用量与思考：**

- `{ type: "usage", usage }` → `session.state.usage`：`input`/`output`/`cached`
  是**会话累计**，`contextTokens`/`contextWindow` 是**最近一次**报告的上下文
  占用与窗口上限（两者不能互相推导）。`<ContextMeter>` 直接吃这个对象。
- `session.reasoningFor(turnId)` → 该 turn 的思考流（`StreamSource`）。
  **思考不落库**：`turn.end` 之后源就被丢掉，`<Show>` 自动收起。折叠态读
  `source.tail()` 就是「正在想的那一行」。
- `message.streaming` 在 `text.delta` 期间为 `true`，`turn.end` 转 `false`。

### 4.16 流式 Diff：`DiffStream` + `<Diff>` + `tool.diff`

后端负责 diff 算法，前端只消费行级 patch：

```ts
session.dispatch({
  type: "tool.diff",
  callId: "c1",
  patch: {
    ops: [{
      op: "upsert",
      lines: [{ id: "a1", kind: "add", text: "const x", newLine: 1, stable: false }],
    }],
  },
});

<Diff source={session.diffFor("c1")!} height={12} lineNumbers />
```

契约：

- `DiffLine.id` 必须在同一逻辑行的所有修订中稳定；重复 upsert 同一 id 是
  **更新**，不是追加。
- `upsert` 是正常路径，O(1) 定位；`replaceTail` 只用于修正最后 N 行。
  v0.1 不支持任意位置删除 / splice。
- `stable: false` 只标仍可能变化的那一行；`final:true`、`tool.result`、
  `turn.end` 会自动定稿。
- `<Diff height>` 只创建视口行；长行固定 `truncate`，一行只占一个 cell row。
- 行更新使用逐行版本信号；改一行不会重新计算整个 diff 的文本 / token。
- `highlight` 只对 context 行做轻量语法高亮；add / remove 始终保持红绿语义。

### 4.17 动画：`AnimationScheduler` / `useAnimationFrame` / tween / spring / timeline / inertia

```tsx
const time = useAnimationFrame({ enabled: () => source.streaming() });
const opacity = createTween({ from: 0, to: 1, duration: 240 });
const position = createSpring({ from: 0, to: 10 });
const timeline = createTimeline({ steps: staggerSteps(3, { interval: 80, duration: 240, onUpdate }) });
const inertia = startDragInertia({
  velocityX: event.velocityX,
  velocityY: event.velocityY,
  onStep: (dx, dy) => moveBy(dx, dy),
});
```

- 进程内共享调度器默认 30fps，只有存在订阅者时才启动；全部退订后停止。
- `tick(time)` 可手动驱动，测试和未来的 runtime render clock 不依赖墙钟。
- `createTween()` 支持数值 / 颜色；`createSpring()` 使用固定小步长积分。
- `createTimeline()` 支持并行 step，`sequenceSteps()` / `staggerSteps()` 生成
  串行 / 错峰布局。
- `startDragInertia()` 做指数衰减，输出整数 cell 位移，自动在低速停止。
- `TERM=dumb` 或 `BUTUI_REDUCED_MOTION=1|true` 时默认不启动动画；
  `<Diff>`、`<Shimmer>`、`<ScrollBar>`、`<Slider>` 已按这个规则降级。
- 动画只应更新仍在变化的少量行。不要把 shimmer 铺到完整 diff / markdown，
  否则每帧都会制造大量样式变化和重绘。

### 4.18 精确 ScrollBar：`createScrollBar` / `<ScrollBar>`

```tsx
const view = createScrollView();
const bar = createScrollBarFor(view);

<row>
  <box flexGrow={1}>…</box>
  <ScrollBar model={bar} />
</row>
```

- `scrollBarGeometry()` 是纯函数：整数轨道、thumb 至少 1 格、端点精确。
- `topForThumb()` / `topAtTrack()` 提供双向映射和轨道点击定位。
- `createScrollBar()` 拖动保留 `grabOffset`；`jump(y, "start")` 可精确到轨道行。
- `<ScrollBar>` 按下后捕获自身节点，`onDrag` 用 `localY` 更新，拖出轨道矩形
  仍继续。
- 释放时默认按 `dragend.velocityY` 继续滚动；`inertia={false}` 可关闭。
- ScrollBar 声明 `selectable={false}`。runtime 会从命中节点向上继承该属性，
  不启动全局文本选择，因此拖拽不会被选区吃掉。
- `<Diff scrollbar>` 与 `createScrollBarFor(view)` 使用同一几何模型。

### 4.19 插件与 Slot：`SlotRegistry` / `<Slot>`

```tsx
import { createSlot, createSolidSlotRegistry } from "@butui/plugins/solid";

const registry = createSolidSlotRegistry<Slots, Ctx>(host, context);
const Header = createSlot(registry);

registry.register({
  id: "my-plugin",
  order: 10,
  slots: { header: (ctx, props) => <text>{props.title}</text> },
});
```

- `@butui/plugins` 是 renderer-agnostic 的核心注册表；`@butui/plugins/solid`
  才依赖 Solid。
- 插件排序稳定为 `order` → 注册顺序 → `id`；`updateOrder()` 会触发通知。
- Slot 模式为 `append` / `replace` / `single_winner`。
- `register()` 返回只卸载本次注册的函数；同一 id 重注册后旧 disposer 不会
  误删新插件。
- `setup` 可返回 cleanup，卸载顺序是 cleanup → `dispose`。
- 插件错误通过 `onPluginError` / `getPluginErrors()` 观测；每个贡献有独立
  错误边界，单个插件失败不会影响兄弟插件。
- `createSlotRegistry(host, key, context)` 要求同一 key 使用同一个 context
  对象；违反时直接抛错。
- `@butui/plugins/loader` 提供 `readPluginManifest` / `findPluginManifest` /
  `readPluginConfig` / `normalizePluginEntries` / `discoverPlugins` /
  `loadPlugins`。
- manifest 支持 `butui.plugin.json` 或 `package.json#butui`；配置支持 JSON / TS。
- `discoverPlugins()` 默认只扫描直接依赖，`extraDirs` 加本地目录，
  `includeAllInstalled` 才扫描全部 node_modules。
- manifest 的 `capabilities` 是加载同意门：不满足 `allowedCapabilities` 时
  在动态 import 前拒绝；`requireCapabilities: true` 要求必须有 manifest。
  **它不是沙箱**，插件仍在应用进程内执行。
- `loadPlugins()` 的模块导出支持默认导出、命名 `plugin` 和工厂函数；工厂收到
  `{ id, module, path, cwd, options, context, manifest? }`。
- loader 单条失败记 `phase:"load"` 并继续；返回的 `dispose()` 只卸载本次成功
  加载的插件。
- 当前没有运行时沙箱、权限审批或跨进程隔离；应用必须提供配置 / 条目。

### 4.20 命令与 Keymap：`CommandRegistry` / `Keymap`

```ts
const keymap = createKeymap();
keymap.bindCommand(
  { id: "save", title: "保存", run: () => save() },
  "ctrl+s",
  { scope: "editor", priority: 10 }
);
```

- `CommandRegistry.register()` 返回 disposer；重复 id 抛错。
- `CommandRegistry.execute()` 找不到或 `when()` 为 false 时返回 false；同步
  抛错 / 异步 rejection 进入 `onError`。
- `Keymap` 分派顺序：scope 深度 → priority → 注册顺序。
- `pushScope()` / `popScope()` 管理作用域；binding / command 都有 `when()`。
- 命中后调用 `event.preventDefault()` 并返回 true。
- `conflicts()` 只报告同一 sequence + scope 的多条无条件绑定。
- `help()` 返回按键、scope、命令 id / title / description。
- 多键 chord 用空格分隔；前缀会消费按键并等待 `chordTimeout`。
- `g` / `g g` 可共存，`flushPending()` 提交精确短绑定，`pendingSequence()` 可
  给状态栏 / 帮助 UI 显示当前前缀。
- `parseKeySequence()` 负责多键序列；`parseKeyStroke()` 只接受单键。
- `@butui/keymap/solid` 的 `useKeymap()` 把 keymap 接到组件级全局按键。

### 4.21 鼠标交互

```tsx
<box
  onMouseEnter={() => setHover(true)}
  onMouseLeave={() => setHover(false)}
  onMouseDown={event => app.captureMouse(node())}
  onMouseMove={event => update(event)}
  onMouseUp={() => app.releaseMouse()}
  onDoubleClick={() => open()}
  onContextMenu={() => menu()}
  onDragStart={event => begin(event)}
  onDrag={event => update(event.localX, event.localY)}
  onDragEnd={event => end(event)}
/>
```

- `MouseEvent.action` 支持
  `press / release / move / wheel / enter / leave / dragstart / drag / dragend`。
- `localX / localY` 是相对目标节点左上角的坐标；捕获 / drag 时允许为负或
  超出节点尺寸。
- `clickCount` 由 runtime 合成；默认双击间隔 400ms，可用 `mouse.doubleClickMs`
  和 `mouse.now` 覆盖 / 注入。
- 右键 press 优先 `onContextMenu`；双击优先 `onDoubleClick`，没有对应 handler
  时回退 `onClick`。
- `onMouseEnter / onMouseLeave` 不冒泡；默认 `mouseMotion: "drag"` 下不会产生
  无按键 hover，需要传 `"hover"` 开启终端 1003。
- `onDragStart / onDrag / onDragEnd` 在移动超过 `mouse.dragThreshold` 后触发；
  target 固定为按下节点，release 时结束。
- `onDragEnd` 的 `velocityX / velocityY` 是最近窗口速度，单位 cell/ms；可用
  `mouse.velocityWindowMs` / `mouse.maxVelocity` 调整。
- `startDragInertia()` 把速度衰减成整数 cell 位移；`<ScrollBar>` / `<Slider>`
  默认接入，`inertia={false}` 可关闭，SplitPane 不默认启用。
- `captureMouse(node)` 后鼠标事件发给捕获节点，release 自动解除；组件使用
  `useMouseCapture()`。
- 节点 `cursor?: MousePointerStyle` 通过 OSC 22 切换鼠标指针；未声明时，
  `onClick` / `onMouseDown` 等交互链自动使用 `pointer`。
- 相同形状去重；capture 期间保持捕获节点形状，release / stop / dispose 恢复
  `default`。`mousePointer: false` 可关闭，终端不支持时忽略。
- `<Input>` / `<Textarea>` 默认 `cursor="text"`。
- 文本选择默认接管左键拖拽；控件用 `selectable={false}` 退出竞争。
- 当前没有 pointerId / 多指针；惯性只接 ScrollBar / Slider。

### 4.22 Slider：`createSlider` / `<Slider>`

```tsx
const slider = createSlider({
  value: () => value(),
  min: 0,
  max: 100,
  step: 10,
  onChange: setValue,
});
<Slider model={slider} width={31} showValue />;
```

- `sliderValueAt()` 是纯函数：比例、step、端点都精确。
- `beginDrag` / `drag` / `endDrag` 管理拖动状态；鼠标使用 `localX + capture`。
- 释放时默认按 `dragend.velocityX` 继续移动；`inertia={false}` 可关闭。
- 键盘支持左右 / 上下 / PageUp / PageDown / Home / End。
- 组件宽度只影响显示，不影响模型值域。
- 当前是单行水平 slider；没有垂直轴、双 thumb 或刻度组件。

### 4.23 SplitPane：`createSplitPane` / `<SplitPane>`

```tsx
const split = createSplitPane({
  orientation: "horizontal",
  ratio,
  onChange: setRatio,
  minFirst: 8,
  minSecond: 8,
});

<SplitPane model={split} first={<box>左侧</box>} second={<box>右侧</box>} />;
```

- `splitPaneGeometry(size, ratio, options)` 先扣掉分隔条，再返回精确的
  `first / second` cell 数；端点会落在 `minFirst / maxFirst`。
- `orientation: "horizontal"` 是左右分栏，`"vertical"` 是上下分栏。
- `beginDrag / drag / endDrag` 管理拖动；鼠标捕获根节点，`drag()` 使用相对根
  节点的本地坐标，因此分隔条移动不会改变坐标原点。
- 键盘支持该方向的方向键、PageUp / PageDown、Home / End；分隔条可聚焦。
- 分隔条 `selectable={false}`，但两侧内容仍可参与全局文本选择。
- `size` 默认取终端对应轴。组件嵌在 padding / border / 兄弟节点容器里时，应用
  应传实际 cell 数；窗格本身用 `flexGrow` 跟随父容器。
- 当前没有折叠、嵌套约束或双击复位。

### 4.24 Shimmer：`<Shimmer>`

```tsx
<Shimmer
  text="thinking..."
  active={streaming()}
  granularity="word"
  highlightWidth={6}
/>
```

- `granularity` 为 `line | word | cell`；默认 `word`，`cell` 仅用于窄状态行。
- `phase` 是受控 0..1；不传时订阅共享动画时钟。
- 只改颜色，不改变文本宽度、换行或布局。
- `reducedMotion` / `BUTUI_REDUCED_MOTION=1|true` 时静态显示。
- 不要把 Shimmer 铺到完整 Markdown / Diff；`ReasoningLine` 只在 streaming 时
  动画前缀。

### 4.25 Command Palette：`<CommandPalette>`

```tsx
<CommandPalette
  registry={registry}
  open={open()}
  onDismiss={() => setOpen(false)}
/>
```

- 结果直接来自 `CommandRegistry.list()`；`when() === false` 默认不展示。
- `filterCommands()` / `commandScore()` 可按 title / id / description 搜索。
- 输入框自动聚焦，↑↓ / PageUp/PageDown / Home/End / Ctrl+P/N 选择。
- Enter 执行并关闭，Esc 关闭，鼠标点击结果执行。
- 命令错误由 `CommandRegistry.onError` 隔离；组件不吞错误。

## 5. 已知缺口（不要依赖，也不建议自己绕）

- **列表只有单列 + 固定行高**：`itemHeight` 是常数，变高行（折行文本、展开的
  卡片）不支持；`MultiSelect` 还没做。
- **编辑器模型没有内部选区 / 剪贴板历史 / 撤销栈**：只有光标与历史。全局鼠标
  选区是 runtime 能力，不修改编辑器模型。
- **文本选择是视口坐标且不会自动滚动**：拖到屏幕边缘不会继续滚，滚动 /
  内容重排后选区指向同一屏幕位置；需要稳定内容锚点时要由应用保存。
- **OSC 52 没有确认通道**：终端可忽略；严格剪贴板需求要接平台实现。
- **流式 Diff 不支持任意位置删除 / splice**：后端应把重算限制在尾部；需要完整
  重排时新建一个 `DiffStream`。目前也没有 word-level diff、折叠 hunk 和
  “视口外有新行”提示。
- **动画已有共享时钟、tween / spring / timeline、Diff 游标、拖动惯性和
  Shimmer**：还缺更完整的 stagger 编排、滚动回弹策略和动画调试工具；不要假设
  60fps。
- **ScrollBar 目前只有垂直轴**：没有自动隐藏、hover 展开、水平轴或触控惯性。
- **SplitPane 的拖动几何依赖 `size`**：根视图可省略并使用终端尺寸；嵌在
  padding / border / 兄弟节点容器里时必须传实际轴尺寸，否则 min/max 夹取会按
  错误总尺寸计算。窗格布局比例本身仍会跟随父容器。
- **`flexShrink` 没有实现**：row 里只有显式 `truncate` / `wrap={false}` 的
  text 会让位给兄弟节点；普通的折行文本仍然先按自然宽度拿满。
- **`ScrollView` 的翻页步长按整屏高度算**：有固定页眉 / 页脚时会多滚固定区
  那么几行（滚回底部会自动恢复跟随，所以只是「一页多一点点」）。
- **没有 scroll 容器的手势/惯性**：`ScrollView` 管的是根视口；任意子树的
  `scrollOffset` 仍然要应用自己算（`<List>` 已经封装了它自己的那一份）。
- **没有布局调试工具**（类似 flexbox inspector）。
- **焦点不会自动清理**：被移除的节点如果还是焦点，`focusedId()` 会保留它的
  id（下一次 tab 会自动跳到活着的节点）。组件里用 `isFocused` 不受影响。
- **鼠标没有 pointerId / 多指针**：hover 默认关闭（1003 事件量高）；
  OSC 22 是 best-effort，终端可忽略；跨终端窗口的 capture 不在协议范围内。
  惯性只接在 ScrollBar / Slider，不作用于 SplitPane 或文本选择。
- **Keymap 已支持多键 chord / 超时前缀，Command Palette 已有基础 UI**：还缺用户
  自定义绑定持久化、复杂权限门控和更丰富的 result metadata。
- **插件 capability 不是沙箱**：它只在动态 import 前做同意门控，没有运行时
  权限拦截、审批 UI 或跨进程隔离；插件在应用进程内执行，只应加载可信代码。
- **`@butui/web` 是实验层**：接口可能变。

## 6. 版本

当前 `0.1.x`：稳定层已冻结，按 §3 演进。破坏性变更等 `1.0` 再收口 —— 在
`1.0` 之前，新增能力优先走「新增可选字段」，避免动已有形状。
