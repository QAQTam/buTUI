/**
 * 最小 ANSI SGR 解析。
 *
 * 为什么需要它：`Bun.markdown.render` / `Bun.markdown.ansi` 产出的是带转义
 * 序列的字符串，而布局层要按 grapheme 建 cell。如果不先把转义序列摘出来，
 * `\x1b[1m` 会被当成 4 个可见字符算进宽度。
 *
 * 只处理 SGR（`ESC [ ... m`）与 OSC 8 超链接；其它序列按零宽跳过。
 */
export interface AnsiRun {
  /** 可见文本 */
  text: string;
  /** 该段生效的 SGR 前缀（可直接拼在文本前） */
  sgr: string;
}

const ESC = 0x1b;
const BEL = 0x07;
const ST = 0x5c; // ESC \

export function parseAnsiRuns(input: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  let sgr = "";
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer !== "") {
      runs.push({ text: buffer, sgr });
      buffer = "";
    }
  };

  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code !== ESC) {
      buffer += input[i];
      i++;
      continue;
    }

    const next = input[i + 1];
    if (next === "[") {
      // CSI：找到终止字节 0x40-0x7e
      let end = i + 2;
      while (end < input.length) {
        const c = input.charCodeAt(end);
        if (c >= 0x40 && c <= 0x7e) break;
        end++;
      }
      if (end >= input.length) {
        // 截断的序列：先当普通文本处理，下一帧补齐后会重新解析
        buffer += input.slice(i);
        break;
      }
      const final = input[end];
      if (final === "m") {
        flush();
        const params = input.slice(i + 2, end);
        sgr = applySgr(sgr, params);
      }
      // 其它 CSI（光标、清屏）一律零宽丢弃
      i = end + 1;
      continue;
    }

    if (next === "]") {
      // OSC：直到 BEL 或 ESC \
      let end = i + 2;
      while (end < input.length) {
        const c = input.charCodeAt(end);
        if (c === BEL) break;
        if (c === ESC && input.charCodeAt(end + 1) === ST) {
          end++;
          break;
        }
        end++;
      }
      i = Math.min(input.length, end + 1);
      continue;
    }

    // 其它两字符转义（ESC ( B 等）
    i += 2;
  }
  flush();
  return runs;
}

/** 把新的 SGR 参数叠加到当前状态上，返回可直接输出的前缀 */
function applySgr(current: string, params: string): string {
  const codes = params === "" ? ["0"] : params.split(";");
  if (codes.includes("0")) return "";
  return current + `\x1b[${params}m`;
}

/** 去掉所有 ANSI 序列，得到纯文本 */
export function stripAnsi(input: string): string {
  return parseAnsiRuns(input)
    .map(run => run.text)
    .join("");
}
