/**
 * `@butui/components` —— SPEC §10.1 的基础组件。
 *
 * 这一层是「**跨应用复用**的交互组件」：编辑器模型、输入框，之后还会有
 * Select / List / ScrollBox / Table。
 *
 * 与 `@butui/layout` 的分工：layout 提供的是**原语**（box / row / text /
 * spacer），组件提供的是**带交互语义的东西**（光标、编辑、选择、滚动）。
 * 组件不碰 cell 网格，只组合原语 —— 所以 TUI 和以后别的渲染目标都能复用。
 */
export * from "./editor.ts";
export * from "./input.tsx";
