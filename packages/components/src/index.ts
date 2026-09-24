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
export * from "./textarea.tsx";
export * from "./selection.ts";
export * from "./list.tsx";
export * from "./command-palette.ts";
export * from "./command-palette.tsx";
export * from "./scroll.ts";
export * from "./scrollbar.ts";
export * from "./scrollbar.tsx";
export * from "./stream-window.ts";
export * from "./stream-window.tsx";
export * from "./slider.ts";
export * from "./slider.tsx";
export * from "./splitpane.ts";
export * from "./splitpane.tsx";
export * from "./shimmer.ts";
export * from "./shimmer.tsx";
export * from "./display.tsx";
export * from "./modal.tsx";
export * from "./toast.ts";
export * from "./toast.tsx";
export * from "./tooltip.ts";
export * from "./tooltip.tsx";
export * from "./popover.ts";
export * from "./popover.tsx";
export * from "./portal.tsx";
export * from "./dynamic.tsx";
export * from "./capability-approval.tsx";
export * from "./select.tsx";
export * from "./multi-select.ts";
export * from "./multi-select.tsx";
export * from "./form.ts";
export * from "./form.tsx";
export * from "./table.tsx";
export * from "./tree.tsx";
export * from "./highlight.ts";
export * from "./diff.tsx";
export * from "./code.tsx";
export * from "./markdown.tsx";
