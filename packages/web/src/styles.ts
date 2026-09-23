/** WebUI 的内联样式表 —— 单文件注入，零构建依赖 */
const CSS = `
.butui-root{font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f172a;color:#e2e8f0;
  padding:16px;max-width:900px;margin:0 auto;border-radius:10px}
.butui-header{display:flex;justify-content:space-between;align-items:center;gap:12px;
  border-bottom:1px solid #334155;padding-bottom:8px;margin-bottom:12px}
.butui-brand{color:#7dd3fc;font-weight:600}
.butui-status{display:flex;gap:12px;font-size:12px}
.butui-muted{color:#94a3b8}
.butui-warn{color:#facc15}
.butui-error{color:#f87171}
.butui-ok{color:#4ade80}
.butui-messages{display:flex;flex-direction:column;gap:12px}
.butui-message{border:1px solid transparent;border-radius:8px;padding:8px;cursor:pointer}
.butui-message:hover{border-color:#334155}
.butui-message.butui-selected{border-color:#38bdf8;background:#111c33}
.butui-role{color:#a3e635;font-weight:600;margin-bottom:4px}
.butui-role.user{color:#f472b6}
.butui-streaming{color:#facc15;font-weight:400;margin-left:8px;font-size:12px}
.butui-text{white-space:pre-wrap}
.butui-md .butui-line{white-space:pre-wrap;min-height:1.55em}
.butui-tail{display:inline}
.butui-tool{display:flex;gap:8px;color:#94a3b8;font-size:12px;padding-left:8px}
.butui-glyph.butui-success{color:#4ade80}
.butui-glyph.butui-running{color:#facc15}
.butui-glyph.butui-error{color:#f87171}
.butui-tool-name{color:#94a3b8}
.butui-actions{display:flex;gap:8px;margin-top:6px}
.butui-actions button,.butui-dialog-actions button{background:#1e293b;color:#7dd3fc;border:1px solid #334155;
  border-radius:6px;padding:3px 10px;font:inherit;cursor:pointer}
.butui-actions button:hover,.butui-dialog-actions button:hover{border-color:#38bdf8}
.butui-secondary{color:#94a3b8!important}
.butui-section-title{color:#94a3b8;font-size:12px;margin:12px 0 4px}
.butui-todo{display:flex;gap:8px}
.butui-dialog{margin-top:12px;border:1px solid #38bdf8;border-radius:10px;padding:12px;
  background:#111c33;max-width:560px}
.butui-dialog.butui-danger{border-color:#f87171}
.butui-dialog.butui-warn-border{border-color:#facc15}
.butui-dialog-title{font-weight:600;margin-bottom:6px}
.butui-dialog.butui-danger .butui-dialog-title{color:#f87171}
.butui-dialog.butui-warn-border .butui-dialog-title{color:#facc15}
.butui-dialog-actions{display:flex;gap:8px;margin-top:10px}
.butui-code{background:#020617;border-radius:6px;padding:8px;overflow-x:auto;margin:6px 0}
.butui-effects{margin:6px 0;padding-left:18px}
.butui-option{display:block;background:none;border:none;color:#7dd3fc;font:inherit;
  text-align:left;padding:2px 0;cursor:pointer}
`;

let injected = false;

export function injectStyles(doc: Document = document): void {
  if (injected || doc.getElementById("butui-styles")) return;
  const style = doc.createElement("style");
  style.id = "butui-styles";
  style.textContent = CSS;
  doc.head.appendChild(style);
  injected = true;
}

export const styles = CSS;
