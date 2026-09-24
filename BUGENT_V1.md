# buTUI v0.1 → bugent 第一版接入清单

> 状态：设计尝试收口，进入可实施阶段。  
> 目标：bugent 使用 buTUI 做第一版自研 TUI，而不是继续扩展 buTUI 的组件面。  
> 冻结原则：现有 `@butui/*` 公共入口只做 bugfix / 兼容性补丁；第一版实施中发现的
> 新能力，进入 v0.2 设计，不阻塞主线。

## 1. 第一版必须用到的能力

| 能力 | 入口 | 用途 |
|---|---|---|
| 应用运行时 | `createTuiApp` | 备用屏、raw mode、resize、焦点、鼠标、退出还原 |
| 流式文本 | `createTextStream` / `StreamText` | assistant 文本输出 |
| 流式 Markdown | `createMarkdownStream` / `StreamMarkdown` | 富文本回答 |
| 平滑显现 | `smooth: { fps: 120, speed: 160 }` | 高频 chunk 逐列显示 |
| 编辑器 | `createTextEditor` / `<Input>` | 用户输入、历史、光标 |
| 列表 / 滚动 | `createSelection` / `<List>` / `createScrollView` | 消息、工具、候选列表 |
| Keymap | `Keymap` / `CommandRegistry` / `<CommandPalette>` | 快捷键、命令面板 |
| 弹窗 | `<Dialog>` / `<Modal>` | 权限、确认、选择 |
| Diff | `DiffStream` / `<Diff>` | tool patch 展示 |
| Agent 状态 | `createSession` / `AgentEvent` | 事件 reducer、消息与工具卡片 |
| 主题 / 颜色 | `@butui/core` theme | 终端色深适配 |

图片、WebUI、插件沙箱、水平 ScrollBar 不进入第一版关键路径。

## 2. 推荐的 bugent 数据流

```text
bugent event stream
  → AgentEvent reducer / Session（只存结构化状态）
  → text.delta 写入独立 StreamSource（不把累积文本塞进全局 store）
  → <StreamMarkdown source smooth={{ fps: 120 }} />
  → createTuiApp 合帧 + backpressure
```

约束：

- 消息、tool、permission、todo 等结构化状态可以进 store。
- 文本增量不要进 store 后每帧拼字符串；交给 `@butui/stream`。
- `StreamSource.lines` 只增不改；不要用 `<For>` 渲染流式行数组。
- 历史消息挂载时立即显示；smooth 只 reveal 新到达内容。

## 3. 推荐启动配置

```tsx
const app = createTuiApp({
  view: runtime => <BugentApp size={runtime.size} />,
  scroll: view,
  stickyBottom: FOOTER_ROWS,
  mouseMotion: "drag",
  mousePointer: true,
  selection: true,
  quitOnCtrlC: true,
});
```

- 流式回答用默认 `render.mode = "microtask"` + `smooth`。smooth 自己按 120fps
  限制可见变更，不需要再叠低 fps 的 frame。
- 如果同一界面还有独立动画 / 高频非 smooth mutation，再开
  `render: { mode: "frame", fps: 120 }`。
- `stdout.write()` 返回 `false` 时 runtime 会暂停自动绘制，等 `drain` 后只画最新
  状态；不要在应用层绕过 `createTuiApp` 直接写 stdout。

## 4. 第一版实施切片

1. **壳层**：进入备用屏、输入框、状态栏、Ctrl+C 退出还原。
2. **文本流**：把 bugent 的 text/reasoning delta 接到 `StreamSource`，开启
   smooth 120fps，完成 2000 chunk/s 真实 PTY 冒烟。
3. **工具链**：tool start/result/diff、权限弹窗、取消与错误状态。
4. **会话能力**：命令面板、历史回滚、undo preview、artifact 占位。
5. **打磨**：滚动跟随、resize、慢终端 backpressure、reduced-motion 降级。

每个切片单独可运行、可回滚；不要把完整 Agent UI 一次性接完。

## 5. 第一版验收

- 2000 chunk/s 下文字连续推进，不整块喷出。
- 慢终端 / `stdout` backpressure 下内存不随输出持续增长。
- resize、Ctrl+C、异常退出都恢复终端状态。
- `TERM=dumb`、`NO_COLOR`、`BUTUI_REDUCED_MOTION=1` 有降级路径。
- 键盘顺序固定：应用 `onKey` → keymap → `useKeyboard` → 内置键 → 焦点节点。
- 鼠标 hit test、滚动、文本选择、权限点击可用。
- 流式长转录的 push / paint 成本不随历史长度线性增长。

## 6. 明确不放进第一版

- 插件运行时沙箱、权限审批、跨进程隔离。
- Kitty keyboard protocol 发送侧。
- WebUI diff / 自定义 renderable catalogue。
- 水平 ScrollBar、复杂 stagger 动画编排。
- 任意位置流式 Diff splice、word-level diff、折叠 hunk。
- 完整的无障碍 / 屏幕阅读器协议适配。

这些可以基于第一版真实使用数据再决定，不继续做设计期功能堆叠。

## 7. 冻结与后续

- **bugfix / 兼容性补丁**：可以直接进 v0.1。
- **新公共 API / 组件**：先记录需求，等第一版跑通后进入 v0.2。
- **不复制 buTUI 源码进 bugent**：通过 workspace / package exports 使用；
  否则增量布局、120fps smooth 和 backpressure 会分叉。
- **保留真实 PTY 冒烟**：内存和 CPU 结论只信 PTY，不信纯 headless benchmark。

验证命令：

```bash
bun --conditions=browser test
bun --conditions=browser x tsc --noEmit
bun --conditions=browser run scripts/smooth-stream-demo.tsx
bun --conditions=browser run scripts/smooth-bench.tsx
```
