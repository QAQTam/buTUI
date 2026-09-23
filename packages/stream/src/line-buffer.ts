/**
 * 增量折行缓冲 —— 流式渲染 O(1) 的地基。
 *
 * ## 保证
 *
 * 对累积长度为 N 的文本，分块喂入（每块长度 d）的总成本是
 * `O(N + Σ|pending|)`，而 `|pending| ≤ 2W`（W = 折行宽度）有界，因此
 * **每条 delta 的成本是 O(d + W)，与已累积长度 N 无关**。
 *
 * ## 为什么不能只「保留最后一行」
 *
 * 第一版实现假设 `Bun.wrapAnsi` 是纯贪心的，于是「折出 ≥2 行就定稿前面的
 * 行」。这是错的。看 `src/jsc/bindings/wrapAnsi.cpp:570` 的 `placeWord`：
 *
 *     size_t wordLen = stringWidth(wordStart, wordEnd, ...);
 *     if (options.hard && wordLen > columns) {
 *         size_t remainingColumns = columns > rowLength ? columns - rowLength : 0;
 *         ...
 *         return wrapWord(rows, wordStart, wordEnd, columns, options);  // 填满当前行
 *     }
 *     if (rowLength + wordLen > columns && rowLength > 0 && wordLen > 0) { appendRow(); ... }
 *
 * 断行决策依赖 **整个词的长度**。流式场景下最后一个词还在增长，它的长度一变，
 * 「它到底放不放得进当前行」就可能翻转，从而改写**倒数第二行**。
 *
 * 实测反例（width=6）：
 *
 *     wrapAnsi("测*| )1中")                   -> ["测*| ", ")1中"]   // 词宽 4，放不下 → 换行
 *     wrapAnsi("测*| )1中`👨‍👩‍👧 cb中z-*文 >(") -> ["测*| )", ...]   // 词变长触发 hard wrap，塞进当前行
 *
 * ## 正确的定稿规则
 *
 * 「已折出 ≥2 行就定稿前面的行」是错的，因为**正在增长的词可以翻转它自己的
 * 落位决策**，从而改写倒数第二行。实测反例（width=6）：
 *
 *     wrapAnsi("|文 )z")                            -> ["|文 ", ")z"]      // 词 ")z" 宽 2，放不下
 *     wrapAnsi("|文 )z试试cc_#c*(")                  -> ["|文 )z", "试试cc_", ...]  // 词变长触发 hard wrap
 *
 * 正确的边界来自 `placeWord` 的执行顺序：**词是按顺序放置的**。所以
 *
 * 1. 最后一个空格（含）之前的文本，所有词的落位决策都已经做完 →
 *    这些行里除「当前打开的那一行」之外全部定稿。
 * 2. 最后一个空格之后是正在增长的词，它没有空格。对这部分（打开行 + 增长中的词）
 *    单独折行，**已填满的行**一定定稿 —— hard wrap 是逐字符填充的，
 *    行满了就再也放不进东西。
 *
 * 两条合起来，pending 被限制在 O(W)：
 * 最多「一个未填满的打开行 + 一个未填满的词行」。
 */

export interface LineBufferOptions {
  width: number;
  /** 与 Bun.wrapAnsi 对齐 */
  hard?: boolean;
  wordWrap?: boolean;
}

export interface LineBufferStats {
  /** 传给 Bun.wrapAnsi 的字符总数 —— 复杂度断言的依据 */
  wrappedChars: number;
  wrapCalls: number;
  /** 历史最大 pending 长度，用于验证有界性 */
  maxPending: number;
}

export class LineBuffer {
  private readonly committed: string[] = [];
  private pending = "";
  /** pending 是否代表一个尚未结束的当前行 */
  private tailOpen = false;
  private readonly options: { hard: boolean; wordWrap: boolean; trim: false };
  width: number;
  readonly stats: LineBufferStats = { wrappedChars: 0, wrapCalls: 0, maxPending: 0 };

  constructor(options: LineBufferOptions) {
    this.width = Math.max(1, options.width);
    this.options = {
      hard: options.hard ?? true,
      wordWrap: options.wordWrap ?? true,
      // 必须保持 false：只有不改写行内字符，rows.join("") === pending 才成立
      trim: false,
    };
  }

  /** 追加一段 delta，返回本次新定稿的行 */
  push(delta: string): string[] {
    if (delta === "") return [];
    this.tailOpen = true;
    this.pending += delta;
    const out: string[] = [];

    // 1) 硬换行：`\n` 之前的逻辑行已经彻底结束，全部定稿
    let index = this.pending.indexOf("\n");
    while (index !== -1) {
      const logical = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      out.push(...this.wrap(logical));
      index = this.pending.indexOf("\n");
    }

    // 2) 唯一的定稿边界：最后一个空格。
    //
    // 前缀以空格结尾 → 它最后一个词是完整的，`placeWord` 对该词的落位决策
    // 只依赖它自己的长度，因此这个前缀的折行结果与「整段折行」的前缀部分
    // 完全一致。前缀里除「打开行」（最后一行）之外都可以定稿。
    //
    // 为什么不能更进一步定稿「已填满的行」：正在增长的词会翻转它自己的落位
    // 决策（`breaksStartingNextLine < breaksStartingThisLine`），甚至会
    // 翻转 hard wrap 是从当前行还是下一行开始，从而改写当前行。
    const prefixEnd = lastSpaceIndex(this.pending) + 1;
    const prefixRows = this.wrap(this.pending.slice(0, prefixEnd));
    const safeCount = Math.max(0, prefixRows.length - 1);
    for (let i = 0; i < safeCount; i++) {
      // 满行末尾可能挂着零宽 joiner（ZWJ / variation selector）。`wrapWord`
      // 在 `vis == columns` 时先断行再放下一个字符（wrapAnsi.cpp:267），
      // 所以这类字符应当属于下一行，要退回去。
      const [head, tail] = Bun.stringWidth(prefixRows[i]) >= this.width
        ? splitTrailingJoiners(prefixRows[i])
        : [prefixRows[i], ""];
      if (head.length > 0) out.push(head);
      if (tail !== "") {
        this.pending = tail + prefixRows.slice(i + 1).join("") + this.pending.slice(prefixEnd);
        if (out.length) this.committed.push(...out);
        return out;
      }
    }
    this.pending = prefixRows.slice(safeCount).join("") + this.pending.slice(prefixEnd);

    if (out.length) this.committed.push(...out);
    if (this.pending.length > this.stats.maxPending) this.stats.maxPending = this.pending.length;
    return out;
  }

  /** 收尾：把 pending 也定稿 */
  flush(): string[] {
    if (!this.tailOpen) return [];
    const out = this.wrap(this.pending);
    this.pending = "";
    this.tailOpen = false;
    if (out.length) this.committed.push(...out);
    return out;
  }

  /** 当前所有行（含尚未定稿的尾部） */
  get lines(): readonly string[] {
    if (!this.tailOpen) return this.committed;
    const tail = this.wrap(this.pending);
    return this.committed.length ? [...this.committed, ...tail] : tail;
  }

  /** 已定稿的行数 —— 增量布局的 frozen 边界 */
  get committedCount(): number {
    return this.committed.length;
  }

  /** 尚未定稿的尾部折行结果（长度有界，O(W)） */
  tailLines(): string[] {
    if (!this.tailOpen) return [];
    return this.wrap(this.pending);
  }

  /** 尚未定稿的原文（调试 / 测试用） */
  get pendingText(): string {
    return this.pending;
  }

  reset(width?: number): void {
    this.committed.length = 0;
    this.pending = "";
    this.tailOpen = false;
    if (width !== undefined) this.width = Math.max(1, width);
  }

  private wrap(text: string): string[] {
    this.stats.wrapCalls++;
    this.stats.wrappedChars += text.length;
    return Bun.wrapAnsi(text, this.width, this.options).split("\n");
  }
}

/** 与 `wrapAnsi` 的 `findWordSeparator` 对齐：只把 ASCII 空格当词分隔符 */
function lastSpaceIndex(text: string): number {
  return text.lastIndexOf(" ");
}

/**
 * 把一个「已填满」的行拆成 `[可定稿部分, 需要退回的尾部 joiner]`。
 *
 * 只对零宽连接类字符做处理：ZWJ、variation selector、组合记号、肤色修饰符、
 * 区域指示符（旗帜对）。它们本身不占宽度，但会让前一个字符继续演化。
 */
function splitTrailingJoiners(row: string): [string, string] {
  let end = row.length;
  while (end > 0) {
    const cp = row.codePointAt(end - 1);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    if (!isGraphemeJoiner(cp)) break;
    end -= width;
  }
  return end === row.length ? [row, ""] : [row.slice(0, end), row.slice(end)];
}

function isGraphemeJoiner(cp: number): boolean {
  return (
    cp === 0x200d || // ZWJ
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xe0100 && cp <= 0xe01ef) || // variation selectors supplement
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) || // skin tone modifiers
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) // regional indicators
  );
}

