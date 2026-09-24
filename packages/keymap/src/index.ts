/**
 * `@butui/keymap` —— 通用命令 / 快捷键层。
 *
 * 命令注册表与 keymap 分离：命令可以被快捷键、命令面板或鼠标触发；keymap
 * 只负责作用域和按键分派。Solid 适配见 `@butui/keymap/solid`。
 */
export * from "./commands.ts";
export * from "./keys.ts";
export * from "./keymap.ts";
