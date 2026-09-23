/**
 * bunfig preload 入口。
 *
 *   # bunfig.toml
 *   preload = ["@butui/solid/preload"]
 *
 * 与 `@butui/solid/plugin` 的区别：那个导出的是工厂函数（给 Bun.build 用），
 * 这个在 import 时就注册插件（给 `bun run` / `bun test` 的 preload 用）。
 */
import { butui } from "./plugin.ts";

Bun.plugin(butui());
