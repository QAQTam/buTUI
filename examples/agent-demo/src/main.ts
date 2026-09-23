/**
 * Agent demo 入口。
 *
 *   bun --conditions=browser run examples/agent-demo/src/main.ts
 *
 * 数据流：
 *   键盘/鼠标 → UiCommand → mock agent → AgentEvent → Session → AgentView
 */
import { type AgentEvent, type UiCommand, createSession } from "@butui/agent";
import { createElement, focusNext } from "@butui/core";
import { ImageLayer } from "@butui/image";
import { layout } from "@butui/layout";
import { Renderer } from "@butui/renderer";
import { createComponent, render } from "@butui/solid";
import { TerminalSession, terminalSize } from "@butui/terminal";
import { createEffect, createRoot, flush } from "solid-js";
import { App } from "./app.tsx";
import { createMemoryWorkspace, createMockAgent } from "./mock-agent.ts";
import { input, permission, setInput, setPermission, setSize, setStatus, size } from "./state.ts";

const terminal = new TerminalSession({ altScreen: true, mouse: true, bracketedPaste: true });
const root = createElement("root");
/**
 * 原生图片协议（Kitty / iTerm2 / Sixel）不进 cell 网格，而是由 ImageLayer
 * 在文字差分之后按矩形摆放（SPEC §12.4）。
 */
const imageLayer = new ImageLayer();
const renderer = new Renderer(chunk => terminal.write(chunk), {
  afterDraw: (frame, stats) => imageLayer.render(frame, stats.changed),
});

// ── 协议接线 ────────────────────────────────────────────────────────────────
const pending: UiCommand[] = [];
const session = createSession({
  width: () => Math.max(20, size().columns - 6),
  onCommand: command => {
    // UI → Agent 的命令出口。真实实现里这里是 NDJSON over stdio。
    pending.push(command);
    agent.handle(command);
  },
});

// Demo 的工作区：内存实现，但走的是真实的 journal / diff / patch 路径
const workspace = createMemoryWorkspace({
  "src/auth.ts": "export function login() {\n  // TODO: extract\n  return token;\n}\n",
  "src/util.ts": "export const noop = () => {};\n",
});

const agent = createMockAgent((event: AgentEvent) => {
  // Agent → UI 的事件入口。真实实现里这里是 NDJSON decoder。
  session.dispatch(event);
  setStatus(session.state.status);
  setPermission(session.state.permissions.length > 0);
}, { workspace });

function paint(): void {
  const { columns, rows } = size();
  const frame = layout(root, columns, rows, {
    depth: terminal.colorDepth,
    // 转录区贴底：只把可视窗口复制成帧
    scrollTop: "bottom",
  });
  renderer.draw(frame);
}

let scheduled = false;
function schedulePaint(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    flush();
    paint();
  });
}

render(() => createComponent(App, { session, imageLayer, onImageLoad: schedulePaint }), root);

createRoot(() => {
  createEffect(
    () => ({ i: input(), s: size(), p: permission(), st: session.state.status }),
    () => schedulePaint()
  );
});

terminal.start();
setSize(terminalSize());
flush();
paint();
agent.greet();

// ── 输入 ────────────────────────────────────────────────────────────────────
function quit(): void {
  terminal.stop();
  process.exit(0);
}

terminal.onEvent(event => {
  if (event.type === "key") {
    const { name, text, modifiers } = event;
    if (modifiers.ctrl && name === "c") return quit();

    // ctrl+u：对最后一条 assistant 消息做 undo 预览（SPEC §8.3）
    if (modifiers.ctrl && name === "u") {
      const last = [...session.state.messages]
        .reverse()
        .find(m => m.role === "assistant");
      if (last) {
        session.selectMessage(last.id);
        session.requestUndoPreview(last.id, workspace.fs.read);
      }
      return;
    }

    // 权限弹窗期间吃掉输入（modal focus trap 的简化版）
    if (permission()) {
      if (name === "y") {
        const request = session.state.permissions[0];
        if (request) session.respondPermission(request.id, true);
        return;
      }
      if (name === "n" || name === "escape") {
        const request = session.state.permissions[0];
        if (request) session.respondPermission(request.id, false);
        return;
      }
      return;
    }

    if (name === "tab") return void focusNext(root);
    if (name === "enter") {
      const value = input();
      if (value.trim() !== "") {
        session.submit(value);
        setInput("");
      }
      return;
    }
    // Solid 2 的 signal 写入延迟到 flush：累加必须用 updater
    if (name === "backspace") return setInput(prev => prev.slice(0, -1));
    if (text && !modifiers.ctrl && !modifiers.alt) {
      setInput(prev => prev + text);
      return;
    }
    return;
  }

  if (event.type === "mouse" && event.action === "press") {
    const semantic = event.semantic ?? "";
    if (semantic.endsWith(":allow")) {
      const request = session.state.permissions[0];
      if (request) session.respondPermission(request.id, true);
      return;
    }
    if (semantic.endsWith(":deny")) {
      const request = session.state.permissions[0];
      if (request) session.respondPermission(request.id, false);
      return;
    }
    if (semantic === "action:undo") {
      const target = session.state.selectedMessage;
      if (target) session.requestUndoPreview(target, workspace.fs.read);
      return;
    }
    if (semantic.startsWith("message:")) {
      // 点消息 → 选中（显示 MessageActionBar）
      session.selectMessage(semantic.split(":")[1]);
      return;
    }
    if (semantic === "undo:confirm") {
      const preview = session.state.undoPreview;
      if (preview) session.undo(preview.target, "branch", workspace.fs);
      return;
    }
    if (semantic === "undo:cancel" || semantic === "revert:close") {
      session.dismissUndoPreview();
    }
  }
});

terminal.onResize(next => {
  setSize(next);
  session.resize();
  renderer.invalidate();
  schedulePaint();
});
