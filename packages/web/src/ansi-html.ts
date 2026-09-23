/**
 * ANSI SGR → HTML。
 *
 * WebUI 复用 TUI 的 `StreamSource`（它的行是带 ANSI 的字符串），所以这里
 * 把 SGR 转成内联样式 —— **共享状态与协议，不共享组件代码**（SPEC §3 非目标）。
 */
import { parseAnsiRuns } from "@butui/core";

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ESCAPE[ch]);
}

export function ansiToHtml(text: string): string {
  if (text === "") return "";
  return parseAnsiRuns(text)
    .map(run => {
      const style = sgrToCss(run.sgr);
      const body = escapeHtml(run.text);
      return style ? `<span style="${style}">${body}</span>` : body;
    })
    .join("");
}

/** 解析一串 SGR 序列，映射成 CSS 声明 */
export function sgrToCss(sgr: string): string {
  const codes: number[] = [];
  for (const match of sgr.matchAll(/\u001b\[([0-9;]*)m/g)) {
    for (const part of match[1].split(";")) codes.push(part === "" ? 0 : Number(part));
  }

  const css: string[] = [];
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 1) css.push("font-weight:600");
    else if (code === 2) css.push("opacity:.65");
    else if (code === 3) css.push("font-style:italic");
    else if (code === 4) css.push("text-decoration:underline");
    else if (code === 9) css.push("text-decoration:line-through");
    else if (code === 7) css.push("background:#888;color:#111");
    else if (code === 38 || code === 48) {
      const property = code === 38 ? "color" : "background";
      const mode = codes[i + 1];
      if (mode === 5) {
        css.push(`${property}:${xterm256(codes[i + 2] ?? 0)}`);
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0];
        css.push(`${property}:rgb(${r},${g},${b})`);
        i += 4;
      }
    }
  }
  return css.join(";");
}

/** xterm 256 色号 → hex */
export function xterm256(index: number): string {
  if (index < 16) {
    const basic = [
      "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
      "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    return basic[index] ?? "#ffffff";
  }
  if (index < 232) {
    const n = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(n / 36) % 6];
    const g = steps[Math.floor(n / 6) % 6];
    const b = steps[n % 6];
    return `rgb(${r},${g},${b})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}
