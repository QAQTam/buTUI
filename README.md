# buTUI

> 面向 coding agent 的 Agent UI Runtime。设计文档见 [SPEC.md](./SPEC.md)。

当前状态：**M1/M2 骨架已跑通**（Solid 2 RC universal → 节点树 → 布局 → 差分渲染），
`bun test` 52 个用例全绿。

```
Solid signal / store
  → @butui/solid   (13 个 host ops，Solid 自带 reconciler)
  → @butui/core    (节点树 / 失效传播 / focus / 事件冒泡 / theme)
  → @butui/layout  (row / column / flex / padding / border / overflow / overlay)
  → @butui/renderer(cell buffer + 逐行差分 + SGR 状态机)
  → @butui/terminal(raw mode / resize / 输入解码 / 能力探测)
  → 终端 ANSI
```

## 快速开始

```bash
bun install

# 跑测试（--conditions=browser 不是可选项，见下）
bun test

# 跑 agent demo（需要真实终端）
bun --conditions=browser run examples/agent-demo/src/main.ts

# 打印一张纯文本快照
bun --conditions=browser run scripts/snapshot.tsx 72 22
```

Demo 里的操作：直接打字 → `Enter` 发送 → `Tab` 切焦点 → 鼠标点消息展开
action bar → 点 todo 勾选 → 权限弹窗出现后按 `y`/`n` 或点按钮 → `Ctrl+C` 退出。

## 包

| 包 | 职责 |
|---|---|
| `@butui/core` | 节点树、`rev` 失效传播、focus 树、事件冒泡、theme token |
| `@butui/solid` | `@solidjs/universal` host ops、JSX 类型、Bun 编译插件 |
| `@butui/layout` | flex 子集 → cell 网格（每个 cell 记录归属节点与语义标识） |
| `@butui/renderer` | cell → ANSI，逐行差分 + SGR 状态机 |
| `@butui/terminal` | raw mode、备用屏、鼠标/paste/focus 开关、输入解码、能力探测 |
| `@butui/test` | headless render、快照、事件注入 |

## 三个必须知道的坑

这三个都是实测踩出来的，写在这里避免重复踩。

### 1. `--conditions=browser` 是强制的

`solid-js@2.0.0-rc.9` 的 exports map：

```json
{
  "worker": { "default": "./dist/server.js" },
  "browser": { "default": "./dist/solid.js" },   // ← 客户端响应式在这里
  "node":   { "default": "./dist/server.js" },
  "deno":   { "default": "./dist/server.js" }
}
```

Bun 默认命中 `node` 条件 → 拿到 `dist/server.js` → **不报错，但 signal 更新毫无反应**。

实测结论（都不是可行方案）：

- `bunfig.toml` **不支持** `conditions`
- Bun 插件的 `onResolve` 对 bare specifier 不生效（连回调都不会进）
- `.env` 里的 `BUN_OPTIONS` 太晚，来不及影响解析

可用方案：

```bash
bun --conditions=browser run src/main.ts
BUN_OPTIONS="--conditions=browser" bun run src/main.ts
```

`@butui/solid` 启动时会用 `import.meta.resolve("solid-js")` 检查，命中 server 构建
直接抛错，不让它静默失效。

### 2. `bun test` 的 preload 要单独配

```toml
preload = ["@butui/solid/preload"]        # 只作用于 bun run

[test]
preload = ["@butui/solid/preload"]        # bun test 需要这一份
```

### 3. Solid 2 的 signal 写入延迟到 flush

```ts
const [text, setText] = createSignal("");
setText(text() + "a");
setText(text() + "b");
flush();
// → "b"，第一个字符被吞了
```

对 TUI 来说这就是**快速输入丢字符**。buTUI 的约定：累加型状态一律用 updater：

```ts
setText(prev => prev + "a");
setText(prev => prev + "b");
```

`tests/solid-signal-contract.test.ts` 把这组行为钉住了。

## 编译管线

`@butui/solid/plugin` 实现 SPEC §5.3：

```ts
Bun.plugin(onLoad)
  → @solidjs/compiler.transform({ generate: "universal", moduleName: "@butui/solid" })
  → Bun.Transpiler({ loader: "ts" })   // 编译器不剥 TypeScript，要补一刀
```

`@solidjs/compiler` 是 Rust/napi 构建期工具；纯 JS 兜底是 `@solidjs/babel-plugin`。

已知限制：universal 模式下 **JSX 属性值不能是 JSX 元素/Fragment**
（`packages/compiler/src/universal/transform.rs:620,780`），`<Box header={<Text/>}/>`
会编译失败。包成组件或改用 children 即可。

## 为什么 `@butui/solid` 这么薄

Solid 2 RC 的 `@solidjs/universal` 自带完整 reconciler（`insert` / `spread` /
`reconcileArrays` / `cleanChildren`），buTUI 只需要实现 13 个 host ops：

```
createElement  createTextNode  createSentinel  replaceText  isTextNode
setProperty    insertNode      removeNode      getParentNode
getFirstChild  getNextSibling  cleanupNodes?
```

于是「不从 OpenTUI 复制 reconciler」这条约束直接升级成「**不需要 reconciler**」。

## 依赖的 Bun 主线 API

| 能力 | API |
|---|---|
| 显示宽度（CJK / emoji / ANSI） | `Bun.stringWidth` |
| ANSI 感知折行 | `Bun.wrapAnsi(s, cols, { hard, wordWrap, trim })` |
| ANSI 感知截断 | `Bun.sliceAnsi` |
| Markdown → 终端 | `Bun.markdown.ansi(s, { columns, colors, links })` |
| Markdown → 语义节点 | `Bun.markdown.render(s, callbacks)`（22 个元素回调） |
| 颜色 | `Bun.color(x, "ansi-256" \| "ansi-16m")` |
| 图片解码 / 缩放 | `Bun.Image`（**无 raw pixel 出口**，sixel/half-block 要自带解码） |
| PTY | `Bun.Terminal` + `Bun.spawn({ terminal })` |
| raw mode / resize | `process.stdin.setRawMode` / `SIGWINCH` |
| grapheme 切分 | `Intl.Segmenter` |

## 还没做

- `@butui/components` / `@butui/agent`：把 demo 里内联的组件抽成正式包
- `@butui/undo`：checkpoint / branch / revert（SPEC §8）
- 事件协议（SPEC §13 NDJSON）与 `@butui/web` adapter
- 图片子系统（SPEC §12）：Kitty / iTerm2 好做，sixel 需要补 PNG 解码
- 虚拟列表、动画、Kitty keyboard protocol 的发送侧
- `markdown` / `code` / `image` 三个 intrinsic element 目前只有类型，没有实现
