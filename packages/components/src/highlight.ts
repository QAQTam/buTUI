/**
 * 轻量语法高亮 —— `<Code>` 的地基。
 *
 * 为什么不用 tree-sitter（opentui 走的路）：那是原生依赖 + wasm 资产 +
 * 每种语言一份 grammar，和 buTUI「默认零 native core」的取舍冲突（SPEC §2.2）。
 * TUI 里代码块通常就几十行、只求「关键词/字符串/注释一眼能分」，
 * 一个确定性的逐行扫描器足够，而且**不会因为语法错误整块失色**。
 *
 * 刻意不做的事：跨行状态（多行字符串 / 块注释）。流式渲染里每一行到达时都
 * 要能立刻上色，跨行状态会让「这一行怎么画」依赖前面所有内容。
 *
 * 接口是**可替换**的：`<Code highlight={...}>` 可以塞自己的实现
 * （bugent 那套、或者以后接 tree-sitter）。
 */
export type TokenKind =
  | "text"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "function"
  | "operator"
  | "punctuation";

export interface Token {
  text: string;
  kind: TokenKind;
}

/** token 类型 → 主题 token（`<Code>` 允许逐个覆盖） */
export const TOKEN_COLOR: Record<TokenKind, string> = {
  text: "fg",
  comment: "muted",
  string: "success",
  number: "warning",
  keyword: "accent",
  type: "user",
  function: "assistant",
  operator: "muted",
  punctuation: "muted",
};

const KEYWORDS = new Set([
  // TS / JS
  "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch",
  "class", "const", "continue", "declare", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "from", "function",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new",
  "null", "of", "package", "private", "protected", "public", "readonly", "return",
  "satisfies", "static", "super", "switch", "this", "throw", "true", "try",
  "type", "typeof", "undefined", "var", "void", "while", "yield",
  // Python
  "and", "def", "del", "elif", "except", "global", "is", "lambda", "None",
  "nonlocal", "not", "or", "pass", "raise", "with", "self", "True", "False",
  // Shell / Rust / Go
  "case", "done", "echo", "esac", "fi", "fn", "impl", "match", "mut", "pub",
  "struct", "then", "trait", "use", "where",
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

export interface TokenizeOptions {
  /** 支持 `#` 行注释的语言（python / shell / yaml…） */
  hashComments?: boolean;
}

/** 逐行 token 化。纯函数、无状态，所以可以按行缓存 / 并行 */
export function tokenizeLine(line: string, options: TokenizeOptions = {}): Token[] {
  const tokens: Token[] = [];
  const push = (text: string, kind: TokenKind): void => {
    if (text === "") return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ text, kind });
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;

    // 注释：`//` 或 `#`（按语言开关）—— 注释吃掉整行剩余部分
    if (line.startsWith("//", i) || (options.hashComments && ch === "#")) {
      push(line.slice(i), "comment");
      break;
    }

    // 字符串：单引号 / 双引号 / 反引号，尊重反斜杠转义
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      push(line.slice(i, Math.min(j, line.length)), "string");
      i = Math.min(j, line.length);
      continue;
    }

    // 数字：前面不是标识符字符才算（避免把 foo2 里的 2 拆出来）
    if (/[0-9]/.test(ch) && !IDENT_PART.test(line[i - 1] ?? "")) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxXoObB._eE+-]/.test(line[j]!)) {
        // 指数符号后面必须跟数字，否则 `1+2` 会被吃成一个大 token
        if ((line[j] === "+" || line[j] === "-") && !/[eE]/.test(line[j - 1] ?? "")) break;
        j++;
      }
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }

    // 标识符：关键字 / 类型（首字母大写）/ 函数（后面跟 `(`）
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < line.length && IDENT_PART.test(line[j]!)) j++;
      const word = line.slice(i, j);
      let kind: TokenKind = "text";
      if (KEYWORDS.has(word)) kind = "keyword";
      else if (/^[A-Z]/.test(word)) kind = "type";
      else if (line.slice(j).trimStart().startsWith("(")) kind = "function";
      push(word, kind);
      i = j;
      continue;
    }

    if (/[=+\-*/%<>!&|^~?:]/.test(ch)) {
      push(ch, "operator");
      i++;
      continue;
    }
    if (/[{}()[\],.;]/.test(ch)) {
      push(ch, "punctuation");
      i++;
      continue;
    }
    push(ch, "text");
    i++;
  }
  return tokens;
}

/** 语言名 → 扫描器选项 */
export function tokenizeOptionsFor(language: string | undefined): TokenizeOptions {
  const lang = (language ?? "").toLowerCase();
  return {
    hashComments: ["py", "python", "sh", "bash", "zsh", "shell", "yaml", "yml", "rb", "ruby"].includes(
      lang
    ),
  };
}

/** 整段代码 → 每行的 token（`<Code>` 用） */
export function tokenize(code: string, language?: string): Token[][] {
  const options = tokenizeOptionsFor(language);
  return code.split("\n").map(line => tokenizeLine(line, options));
}
