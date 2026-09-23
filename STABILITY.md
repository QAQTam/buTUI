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
| JSX 与编译 | `@butui/solid` | **稳定** |
| 布局 | `@butui/layout` | **稳定**（`Cell` / `Line` / `Frame` / `layout`） |
| 渲染 | `@butui/renderer` | **稳定**（`Renderer` / `plainText` / `paintLine`） |
| 终端 | `@butui/terminal` | **稳定**（`TerminalSession` / 输入解码 / 能力探测） |
| 基础组件 | `@butui/components` | **稳定**（编辑器 / 选择 / 列表 / 滚动 / 弹窗 / 展示组件） |
| 流式文本 | `@butui/stream` | **稳定**（`StreamSource` / `<stream>`） |
| 图片 | `@butui/image` | **稳定**（`createImage` / `ImageLayer` / `renderImage`） |
| Agent 协议与组件 | `@butui/agent` | **稳定**（`AgentEvent` / `UiCommand` / `Session`） |
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
  focusedId(): number | null;       // 响应式焦点
  isFocused(node?: Node): boolean;  // O(1)
  focus(node?: Node): void;
  dispose(): void;                  // stop + 解绑所有订阅
}
```

**保证：**

1. **自动重绘。** 任何 `touch()`（= 任何节点变更）都会合并到下一帧，同一 tick
   内多次变更只画一次。异步变更不需要任何手动通知。
2. **事件顺序固定**：`onKey`（应用级，返回 `true` 即消费）→ 内建（ctrl+c、
   tab/shift+tab）→ 焦点节点（向上冒泡）。
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

### 4.9 弹窗与基础展示组件

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

### 4.10 滚动视口：`createScrollView`

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

### 4.11 Agent 协议

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

## 5. 已知缺口（不要依赖，也不建议自己绕）

- **列表只有单列 + 固定行高**：`itemHeight` 是常数，变高行（折行文本、展开的
  卡片）不支持；`MultiSelect` / `Tree` / `Table` 还没做。
- **编辑器没有选区 / 剪贴板历史 / 撤销栈**：只有光标与历史。
- **`flexShrink` 没有实现**：row 里只有显式 `truncate` / `wrap={false}` 的
  text 会让位给兄弟节点；普通的折行文本仍然先按自然宽度拿满。
- **`ScrollView` 的翻页步长按整屏高度算**：有固定页眉 / 页脚时会多滚固定区
  那么几行（滚回底部会自动恢复跟随，所以只是「一页多一点点」）。
- **没有 scroll 容器的手势/惯性**：`ScrollView` 管的是根视口；任意子树的
  `scrollOffset` 仍然要应用自己算（`<List>` 已经封装了它自己的那一份）。
- **没有布局调试工具**（类似 flexbox inspector）。
- **焦点不会自动清理**：被移除的节点如果还是焦点，`focusedId()` 会保留它的
  id（下一次 tab 会自动跳到活着的节点）。组件里用 `isFocused` 不受影响。
- **`@butui/web` 是实验层**：接口可能变。

## 6. 版本

当前 `0.1.x`：稳定层已冻结，按 §3 演进。破坏性变更等 `1.0` 再收口 —— 在
`1.0` 之前，新增能力优先走「新增可选字段」，避免动已有形状。
