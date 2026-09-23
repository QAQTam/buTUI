/**
 * JSX 运行时兜底。
 *
 * 正常情况下这个模块**永远不会被调用**：`@butui/solid/plugin` 的 onLoad
 * 已经把 .tsx 用 `@solidjs/compiler`（`generate: "universal"`）编译成了
 * host ops 调用。
 *
 * 如果它被调用了，说明插件没注册 —— 与其抛出难以理解的 `insert is not a
 * function`，不如在这里说清楚原因。
 */
const MISSING_PLUGIN =
  "[butui] 检测到 JSX 走了默认的 jsx-runtime，说明 @butui/solid 的编译器插件没有注册。\n" +
  "  修复方式：在 bunfig.toml 里 preload 插件\n\n" +
  '    preload = ["@butui/solid/plugin"]\n\n' +
  "  或者在使用 Bun.build 时传入 `plugins: [butui()]`。";

function unsupported(): never {
  throw new Error(MISSING_PLUGIN);
}

export const jsx = unsupported;
export const jsxs = unsupported;
export const jsxDEV = unsupported;
export const Fragment = Symbol.for("butui.Fragment");
