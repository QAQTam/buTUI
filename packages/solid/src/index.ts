/**
 * `@butui/solid` 主入口。
 *
 * 编译器产物形如：
 *   import { insert, insertNode, createElement, createTextNode } from "@butui/solid";
 * 因此这个模块必须精确导出那些名字（见 ./renderer.ts）。
 */
import { assertSolidClientBuild } from "./runtime-check.ts";

// 放在最前面：让 --conditions=browser 缺失时的静默失效变成明确报错
assertSolidClientBuild();

export * from "./renderer.ts";
export { assertSolidClientBuild, checkSolidRuntime, CONDITIONS_HINT } from "./runtime-check.ts";
