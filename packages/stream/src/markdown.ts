/**
 * 增量 Markdown 流 —— 让 markdown 流式渲染也是 O(1)。
 *
 * ## 为什么 markdown 比纯文本难
 *
 * 块级结构是**回溯性**的：`===` / `---` 可以把前面的段落变成 setext 标题，
 * 列表项可以「懒继续」吃掉后面的行，围栏代码块在闭合前内容全是字面量。
 * 所以不能像纯文本那样只看最后一行。
 *
 * ## 策略
 *
 * 1. **块状态机**：逐行喂入，遇到空行 / 新的块起始符就关闭当前块。块一旦关闭，
 *    渲染结果永久冻结。
 * 2. **打开中的块**用 `LineBuffer` 做增量折行，所以「块在长」不等于「成本在长」。
 * 3. **内联定界符**：`**bold` 这类未闭合的定界符会让整行渲染结果变化，所以
 *    这行只进 volatile（先按单行粗略渲染给用户看），等闭合后整段一起
 *    `Bun.markdown.render` 重新渲染并定稿。
 *
 * 每条 delta 的成本 = `O(delta + W + 未闭合定界符跨度)`，与已累积长度无关。
 * 未闭合跨度通常是 0~2 行，因此实际就是 O(delta + W)。
 *
 * ## 与整段解析的差异（明确列出）
 *
 * - **不支持 setext 标题**（`===` / `---` 下划线式）：它需要回溯整个段落，与
 *   流式语义冲突。请用 `#`；裸 `---` 按分隔线处理。
 * - **表格按块关闭时整块渲染**：块内成本 O(块)，不是 O(1)。表格通常很短。
 * - **缩进代码块（4 空格）不识别**：请用围栏。
 */

import { LineBuffer } from "./line-buffer.ts";

export interface MarkdownStreamOptions {
  width: number;
  codeStyle?: string;
  headingStyle?: string;
  bullet?: string;
  quotePrefix?: string;
}

export type BlockKind =
  | "paragraph"
  | "heading"
  | "code"
  | "list"
  | "quote"
  | "hr"
  | "table"
  | "blank";

export interface MarkdownLine {
  id: number;
  text: string;
  kind: BlockKind;
  /** false 表示这行还可能被替换（未闭合的内联定界符 / 正在流式折行的尾部） */
  stable: boolean;
}

export interface MarkdownStats {
  /** 交给 Bun.markdown.render 的字符数 —— 复杂度断言的依据 */
  styledChars: number;
  /** 交给 LineBuffer 的字符数 */
  wrappedChars: number;
  blocks: number;
  /** 内联定界符挂起导致的重渲染次数 */
  heldRenders: number;
}

const INLINE_CALLBACKS = {
  paragraph: (children: string) => children,
  strong: (children: string) => `\x1b[1m${children}\x1b[22m`,
  emphasis: (children: string) => `\x1b[3m${children}\x1b[23m`,
  codespan: (children: string) => `\x1b[7m${children}\x1b[27m`,
  strikethrough: (children: string) => `\x1b[9m${children}\x1b[29m`,
  link: (children: string) => `\x1b[4m${children}\x1b[24m`,
  text: (text: string) => text,
};

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UL = /^(\s*)[-*+]\s+(.*)$/;
const OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
/** 只由块起始字符组成时还无法判定（`---` 可能是分隔线，也可能是段落） */
const UNDECIDED = /^[#>\-*+`|_~\d.\s]*$/;

interface Balance {
  ticks: number;
  stars: number;
  underscores: number;
  tildes: number;
  brackets: number;
}

interface OpenBlock {
  kind: BlockKind;
  prefix: string;
  buffer: LineBuffer;
  /** 等待内联定界符闭合的原始行 */
  held: string[];
  /** held 的粗略渲染（用户先看到的内容） */
  volatile: string[];
  balance: Balance;
  fence?: string;
}

export class MarkdownStream {
  readonly stats: MarkdownStats = {
    styledChars: 0,
    wrappedChars: 0,
    blocks: 0,
    heldRenders: 0,
  };
  private readonly options: Required<MarkdownStreamOptions>;
  private readonly frozenLines: string[] = [];
  private readonly frozenKinds: BlockKind[] = [];
  private open: OpenBlock | null = null;
  private pendingLine = "";
  /** pendingLine 中已经喂给当前打开块的前缀长度（避免重复喂） */
  private pendingFed = 0;

  constructor(options: MarkdownStreamOptions) {
    this.options = {
      width: Math.max(1, options.width),
      codeStyle: options.codeStyle ?? "\x1b[38;5;109m",
      headingStyle: options.headingStyle ?? "\x1b[1m\x1b[38;5;117m",
      bullet: options.bullet ?? "•",
      quotePrefix: options.quotePrefix ?? "│ ",
    };
  }

  push(delta: string): void {
    if (delta === "") return;
    this.pendingLine += delta;

    let index = this.pendingLine.indexOf("\n");
    while (index !== -1) {
      const line = this.pendingLine.slice(0, index);
      this.pendingLine = this.pendingLine.slice(index + 1);
      this.feedLine(line);
      this.pendingFed = 0;
      index = this.pendingLine.indexOf("\n");
    }

    // 还没有打开块时，如果这一行看起来就是段落，先开一个 —— 否则用户
    // 在第一个换行到达之前什么也看不到
    if (!this.open && this.pendingLine !== "" && !this.isBlockStart(this.pendingLine)) {
      this.open = this.createBlock("paragraph", "");
      this.stats.blocks++;
      this.pendingFed = 0;
    }

    // 不完整的最后一行：只把「还没喂过的那一段」交给打开块
    if (this.open && this.pendingLine !== "" && this.canStreamTail()) {
      const content = this.contentOf(this.pendingLine);
      const fresh = content.slice(this.pendingFed);
      if (fresh !== "") {
        this.feedTail(fresh);
        this.pendingFed = content.length;
      }
    }
  }

  flush(): void {
    if (this.pendingLine !== "") {
      const line = this.pendingLine;
      this.pendingLine = "";
      this.feedLine(line);
      this.pendingFed = 0;
    }
    this.closeOpen();
  }

  get lines(): readonly MarkdownLine[] {
    const out: MarkdownLine[] = [];
    for (let i = 0; i < this.frozenLines.length; i++) {
      out.push({ id: i + 1, text: this.frozenLines[i], kind: this.frozenKinds[i], stable: true });
    }
    const block = this.open;
    if (!block) return out;
    let id = this.frozenLines.length + 1;
    for (const line of block.volatile) {
      out.push({ id: id++, text: block.prefix + line, kind: block.kind, stable: false });
    }
    const tail = block.buffer.lines.slice(block.buffer.committedCount);
    for (const line of tail) {
      out.push({
        id: id++,
        text: block.prefix + this.renderLine(block, line),
        kind: block.kind,
        stable: false,
      });
    }
    return out;
  }

  /**
   * 只取从 `index` 开始的冻结行。用于增量同步到 Solid store ——
   * 全量 `lines` 每次都要 O(N) 重建，这里只要 O(新增) 。
   */
  frozenLinesFrom(index: number): Array<{ text: string; kind: BlockKind }> {
    const out: Array<{ text: string; kind: BlockKind }> = [];
    for (let i = index; i < this.frozenLines.length; i++) {
      out.push({ text: this.frozenLines[i], kind: this.frozenKinds[i] });
    }
    return out;
  }

  /** 未定稿的尾部（volatile + 折行中的尾巴），长度有界 */
  tailLines(): MarkdownLine[] {
    const block = this.open;
    if (!block) return [];
    const out: MarkdownLine[] = [];
    let id = -1;
    for (const line of block.volatile) {
      out.push({ id: id--, text: block.prefix + line, kind: block.kind, stable: false });
    }
    for (const line of block.buffer.tailLines()) {
      out.push({
        id: id--,
        text: block.prefix + this.renderLine(block, line),
        kind: block.kind,
        stable: false,
      });
    }
    return out;
  }

  /** 永久冻结的行数 —— 增量布局的 frozen 边界 */
  get frozenCount(): number {
    return this.frozenLines.length;
  }

  // ── 块状态机 ──────────────────────────────────────────────────────────────

  private feedLine(line: string): void {
    if (this.open?.kind === "code") {
      if (FENCE.test(line) && line.trimStart().startsWith(this.open.fence ?? "```")) {
        this.closeOpen();
        return;
      }
      this.feedTail(this.continuationOf(line) + "\n");
      return;
    }

    if (line.trim() === "") {
      this.closeOpen();
      this.pushFrozen("", "blank");
      return;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      this.closeOpen();
      this.stats.blocks++;
      this.pushFrozen(this.options.headingStyle + this.styleInline(heading[2]) + "\x1b[0m", "heading");
      return;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      this.closeOpen();
      this.open = this.createBlock("code", "");
      this.open.fence = fence[1];
      this.stats.blocks++;
      return;
    }

    if (HR.test(line)) {
      this.closeOpen();
      this.stats.blocks++;
      this.pushFrozen("─".repeat(Math.min(this.options.width, 40)), "hr");
      return;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      if (this.open?.kind !== "quote") {
        this.closeOpen();
        this.open = this.createBlock("quote", this.options.quotePrefix);
        this.stats.blocks++;
      }
      this.feedTail(this.continuationOf(quote[1]) + "\n");
      return;
    }

    const ul = UL.exec(line);
    if (ul) {
      this.closeOpen();
      this.open = this.createBlock("list", `${this.options.bullet} `);
      this.stats.blocks++;
      this.feedTail(this.continuationOf(this.stripTask(ul[2])) + "\n");
      return;
    }

    const ol = OL.exec(line);
    if (ol) {
      this.closeOpen();
      this.open = this.createBlock("list", `${ol[2]}. `);
      this.stats.blocks++;
      this.feedTail(this.continuationOf(this.stripTask(ol[3])) + "\n");
      return;
    }

    if (TABLE_ROW.test(line)) {
      if (this.open?.kind !== "table") {
        this.closeOpen();
        this.open = this.createBlock("table", "");
        this.stats.blocks++;
      }
      this.feedTail(this.continuationOf(line) + "\n");
      return;
    }

    if (this.open?.kind === "paragraph") {
      this.feedTail(this.continuationOf(line) + "\n");
      return;
    }
    this.closeOpen();
    this.open = this.createBlock("paragraph", "");
    this.stats.blocks++;
    this.feedTail(line + "\n");
  }

  private createBlock(kind: BlockKind, prefix: string): OpenBlock {
    const width = Math.max(1, this.options.width - Bun.stringWidth(prefix));
    return {
      kind,
      prefix,
      buffer: new LineBuffer({ width }),
      held: [],
      volatile: [],
      balance: { ticks: 0, stars: 0, underscores: 0, tildes: 0, brackets: 0 },
    };
  }

  /**
   * 把文本喂给打开块，并把「内联定界符已闭合」的行定稿。
   *
   * 未闭合时只把它们放进 volatile（按单行粗略渲染），闭合后整段一起
   * `Bun.markdown.render` —— 因为强调可以跨行（`**bo\nld**`）。
   */
  private feedTail(text: string): void {
    const block = this.open;
    if (!block) return;
    const committed = block.buffer.push(text);
    if (committed.length === 0) return;

    for (const line of committed) {
      block.held.push(line);
      addBalance(block.balance, line);
      block.volatile.push(this.renderLine(block, line));
    }

    if (isBalanced(block.balance)) {
      const rendered = this.renderHeld(block, block.held);
      for (const line of rendered) this.pushFrozen(block.prefix + line, block.kind);
      block.held = [];
      block.volatile = [];
    }
  }

  /** 整段渲染（用于闭合的 held 区域） */
  private renderHeld(block: OpenBlock, lines: string[]): string[] {
    if (lines.length === 0) return [];
    this.stats.heldRenders++;
    if (block.kind === "code" || block.kind === "table") {
      return lines.map(line => this.options.codeStyle + line + "\x1b[0m");
    }
    const source = lines.join("\n");
    this.stats.styledChars += source.length;
    const rendered = this.styleInline(source);
    const parts = rendered.split("\n");
    // 行数应当与输入一致；不一致时保守回退到逐行渲染
    if (parts.length !== lines.length) return lines.map(line => this.styleInline(line));
    return parts;
  }

  private renderLine(block: OpenBlock, line: string): string {
    if (block.kind === "code" || block.kind === "table") {
      return this.options.codeStyle + line + "\x1b[0m";
    }
    return this.styleInline(line);
  }

  private styleInline(text: string): string {
    if (text === "") return "";
    this.stats.styledChars += text.length;
    try {
      return Bun.markdown.render(text, INLINE_CALLBACKS);
    } catch {
      return text;
    }
  }

  private stripTask(text: string): string {
    const task = TASK.exec(text);
    if (!task) return text;
    return (task[1].toLowerCase() === "x" ? "☑ " : "☐ ") + task[2];
  }

  /** 取这一行里属于当前块内容的部分（剥掉 `> ` / 列表符号） */
  private contentOf(line: string): string {
    const block = this.open;
    if (!block) return line;
    if (block.kind === "quote") return QUOTE.exec(line)?.[1] ?? line;
    if (block.kind === "list") {
      const ul = UL.exec(line);
      if (ul) return this.stripTask(ul[2]);
      const ol = OL.exec(line);
      if (ol) return this.stripTask(ol[3]);
    }
    return line;
  }

  /** 延续行：只返回「还没喂过」的部分 */
  private continuationOf(content: string): string {
    const fresh = content.slice(this.pendingFed);
    this.pendingFed = 0;
    return fresh;
  }

  private canStreamTail(): boolean {
    const block = this.open;
    if (!block) return false;
    if (block.kind === "code") {
      // 可能是闭合围栏的前缀 → 先别喂进代码内容
      const trimmed = this.pendingLine.trimStart();
      const fence = block.fence ?? "```";
      if (/^[`~]*$/.test(trimmed) && trimmed.length <= fence.length) return false;
      return true;
    }
    if (block.kind === "paragraph") return true;
    return !this.isBlockStart(this.pendingLine);
  }

  private isBlockStart(line: string): boolean {
    if (line === "") return true;
    if (HEADING.test(line) || HR.test(line) || TABLE_ROW.test(line) || FENCE.test(line)) return true;
    if (QUOTE.test(line) || UL.test(line) || OL.test(line)) return true;
    return UNDECIDED.test(line);
  }

  private pushFrozen(text: string, kind: BlockKind): void {
    this.frozenLines.push(text);
    this.frozenKinds.push(kind);
  }

  private closeOpen(): void {
    const block = this.open;
    if (!block) return;
    this.open = null;
    this.pendingFed = 0;
    // 块关闭时 buffer 的 pending 往往是空串（上一行以 \n 结束），
    // flush 会把它当成一个空行吐出来 —— 那不是块的内容，丢掉。
    const committed = block.buffer.pendingText === "" ? [] : block.buffer.flush();
    for (const line of committed) {
      block.held.push(line);
      addBalance(block.balance, line);
    }
    for (const line of this.renderHeld(block, block.held)) {
      this.pushFrozen(block.prefix + line, block.kind);
    }
    block.held = [];
    block.volatile = [];
  }
}

function addBalance(balance: Balance, text: string): void {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") balance.ticks++;
    else if (ch === "*") balance.stars++;
    else if (ch === "_") balance.underscores++;
    else if (ch === "~") balance.tildes++;
    else if (ch === "[") balance.brackets++;
    else if (ch === "]") balance.brackets--;
  }
}

function isBalanced(balance: Balance): boolean {
  return (
    balance.ticks % 2 === 0 &&
    balance.stars % 2 === 0 &&
    balance.underscores % 2 === 0 &&
    balance.tildes % 2 === 0 &&
    balance.brackets === 0
  );
}

/** 单行版本，供测试与外部使用 */
export function inlineBalanced(text: string): boolean {
  const balance: Balance = { ticks: 0, stars: 0, underscores: 0, tildes: 0, brackets: 0 };
  addBalance(balance, text);
  return isBalanced(balance);
}
