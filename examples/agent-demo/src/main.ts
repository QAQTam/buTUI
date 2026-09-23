/**
 * Agent demo —— 真实终端里的 buTUI。
 *
 *   bun --conditions=browser run examples/agent-demo/src/main.ts
 *
 * 走的是 SPEC §6 的完整数据流：
 *   Solid signal → host ops → 节点树 → layout → cell buffer → renderer diff → ANSI
 */
import { createElement, focusNext } from "@butui/core";
import { layout } from "@butui/layout";
import { Renderer } from "@butui/renderer";
import { createComponent, render } from "@butui/solid";
import { TerminalSession, terminalSize } from "@butui/terminal";
import { createEffect, createRoot, flush } from "solid-js";
import { App } from "./app.tsx";
import {
  input,
  messages,
  permission,
  respondPermission,
  selected,
  setInput,
  setSelected,
  setSize,
  size,
  status,
  submitInput,
  todos,
  toggleTodo,
} from "./state.ts";

const session = new TerminalSession({ altScreen: true, mouse: true, bracketedPaste: true });
const root = createElement("root");
const renderer = new Renderer(chunk => session.write(chunk));

function paint(): void {
  const { columns, rows } = size();
  const frame = layout(root, columns, rows, { depth: session.colorDepth });
  renderer.draw(frame);
}

let paintScheduled = false;
function schedulePaint(): void {
  if (paintScheduled) return;
  paintScheduled = true;
  // Solid 在 microtask 里 flush，所以把重绘也放进 microtask，保证读到已提交的状态
  queueMicrotask(() => {
    paintScheduled = false;
    flush();
    paint();
  });
}

// ── 挂载 ────────────────────────────────────────────────────────────────────
render(() => createComponent(App, {}), root);

// 只在这些信号变化时重绘 —— 不做常驻帧循环（SPEC §9.5）
createRoot(() => {
  createEffect(
    () => ({
      m: messages(),
      t: todos(),
      i: input(),
      s: selected(),
      p: permission(),
      z: size(),
      st: status(),
    }),
    () => schedulePaint()
  );
});

session.start();
setSize(terminalSize());
flush();
paint();

// ── 输入 ────────────────────────────────────────────────────────────────────
function quit(): void {
  session.stop();
  process.exit(0);
}

session.onEvent(event => {
  if (event.type === "key") {
    const { name, text, modifiers } = event;

    if (modifiers.ctrl && name === "c") return quit();

    // 权限弹窗期间吃掉所有输入（modal focus trap 的简化版）
    if (permission()) {
      if (name === "y") return respondPermission(true);
      if (name === "n" || name === "escape") return respondPermission(false);
      return;
    }

    if (name === "tab") return void focusNext(root);
    if (name === "enter") return submitInput(input());
    // Solid 2 的 signal 写入延迟到 flush：同 tick 内必须用 updater，否则快速输入会丢字符
    if (name === "backspace") return setInput(prev => prev.slice(0, -1));
    if (name === "escape") return setSelected(null);
    if (text && !modifiers.ctrl && !modifiers.alt) {
      setInput(prev => prev + text);
      return;
    }
    return;
  }

  if (event.type === "mouse" && event.action === "press") {
    const semantic = event.semantic ?? "";
    if (semantic === "perm:allow") return respondPermission(true);
    if (semantic === "perm:deny") return respondPermission(false);
    if (permission()) return;
    if (semantic.startsWith("message:")) return setSelected(semantic.slice("message:".length));
    if (semantic.startsWith("todo:")) return toggleTodo(semantic.slice("todo:".length));
    setSelected(null);
  }
});

session.onResize(next => {
  setSize(next);
  renderer.invalidate();
  schedulePaint();
});

// 自动跑一轮，展示流式输出 + tool call + 权限弹窗
setTimeout(() => submitInput("看看 buTUI 能不能落地"), 400);
