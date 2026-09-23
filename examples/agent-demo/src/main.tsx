/**
 * Agent demo 入口 —— 用 `@butui/runtime` 起一个真终端应用。
 *
 *   bun --conditions=browser run examples/agent-demo/src/main.tsx
 *
 * 数据流：
 *   键盘/鼠标 → UiCommand → mock agent → AgentEvent → Session → AgentView
 *
 * 注意这个文件**没有**终端、渲染器、重绘调度、resize、退出这些基础设施 ——
 * 它们都在 `createTuiApp` 里。这里只剩「视图 + 键位策略」。
 */
import { type AgentEvent, type UiCommand, createSession } from "@butui/agent";
import { createTextEditor } from "@butui/components";
import { ImageLayer } from "@butui/image";
import { type TuiApp, createTuiApp } from "@butui/runtime";
import { App } from "./app.tsx";
import { createMemoryWorkspace, createMockAgent } from "./mock-agent.ts";
import { permission, setPermission, setStatus } from "./state.ts";

/** 原生图片协议（Kitty / iTerm2 / Sixel）不进 cell 网格，由 ImageLayer 叠加 */
const imageLayer = new ImageLayer();

/**
 * 输入框的编辑模型：光标、词跳转、历史、提交全在里面。
 * 应用不用再写 backspace / ctrl+u / ↑↓ —— 那是 `@butui/components` 的事。
 */
const editor = createTextEditor({
  onSubmit: value => session.submit(value),
});

const session = createSession({
  width: () => Math.max(20, app.size().columns - 6),
  onCommand: (command: UiCommand) => agent.handle(command),
});

// Demo 的工作区：内存实现，但走的是真实的 journal / diff / patch 路径
const workspace = createMemoryWorkspace({
  "src/auth.ts": "export function login() {\n  // TODO: extract\n  return token;\n}\n",
  "src/util.ts": "export const noop = () => {};\n",
});

const agent = createMockAgent(
  (event: AgentEvent) => {
    session.dispatch(event);
    setStatus(session.state.status);
    setPermission(session.state.permissions.length > 0);
  },
  { workspace }
);

const app: TuiApp = createTuiApp({
  // 视图：任何节点变更都会自动重绘，不需要 schedulePaint
  view: runtime => (
    <App
      session={session}
      size={runtime.size}
      editor={editor}
      imageLayer={imageLayer}
      onImageLoad={() => runtime.requestPaint()}
    />
  ),
  scroll: () => "bottom",
  afterDraw: (frame, stats) => imageLayer.render(frame, stats.changed),
  onKey: event => {
    const { name, modifiers } = event;

    // ctrl+u：对最后一条 assistant 消息做 undo 预览（SPEC §8.3）
    if (modifiers.ctrl && name === "u") {
      const last = [...session.state.messages].reverse().find(m => m.role === "assistant");
      if (last) {
        session.selectMessage(last.id);
        session.requestUndoPreview(last.id, workspace.fs.read);
      }
      return true;
    }

    // 权限弹窗期间吃掉输入（modal focus trap 的简化版）
    if (permission()) {
      const request = session.state.permissions[0];
      if (name === "y" && request) {
        session.respondPermission(request.id, true);
        return true;
      }
      if ((name === "n" || name === "escape") && request) {
        session.respondPermission(request.id, false);
        return true;
      }
      return true;
    }

    // 其余按键交给 <Input> 里的编辑器（它挂在焦点节点上）
    return false;
  },
  onMouse: event => {
    const semantic = event.semantic ?? "";
    if (semantic.endsWith(":allow")) {
      const request = session.state.permissions[0];
      if (request) session.respondPermission(request.id, true);
      return true;
    }
    if (semantic.endsWith(":deny")) {
      const request = session.state.permissions[0];
      if (request) session.respondPermission(request.id, false);
      return true;
    }
    if (semantic === "action:undo") {
      const target = session.state.selectedMessage;
      if (target) session.requestUndoPreview(target, workspace.fs.read);
      return true;
    }
    if (semantic.startsWith("message:")) {
      session.selectMessage(semantic.split(":")[1]);
      return true;
    }
    if (semantic === "undo:confirm") {
      const preview = session.state.undoPreview;
      if (preview) session.undo(preview.target, "branch", workspace.fs);
      return true;
    }
    if (semantic === "undo:cancel" || semantic === "revert:close") {
      session.dismissUndoPreview();
      return true;
    }
    return false;
  },
});

// resize / 退出 / 焦点循环都由 runtime 处理
agent.greet();
