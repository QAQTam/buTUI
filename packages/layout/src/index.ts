/**
 * 布局引擎 —— SPEC §9.1 的 P0 子集。
 *
 * 不引入 Yoga：P0 需要的只是 row / column / flex / fixed / padding / border /
 * overflow / scroll，用 TypeScript 写清楚比绑一个 wasm 布局器更可控，也符合
 * SPEC §2.2「默认零 native core」。
 *
 * 输出是 cell 网格而不是字符串 —— 每个 cell 记录它属于哪个节点，这是
 * SPEC §4.2「语义 hit test」能够成立的前提。
 */
import {
  type ColorDepth,
  type ElementNode,
  type Node,
  type TextNode,
  isElement,
  parseAnsiRuns,
  resolveColor,
} from "@butui/core";

export interface Cell {
  /** 一个 grapheme；宽字符的后继占位 cell 为空串 */
  ch: string;
  /** 显示宽度：1 / 2 / 0（宽字符占位、组合字符附着） */
  width: number;
  /** 归属节点 id，hit test 用 */
  node: number;
  /** 语义标识（最近的有 semantic 的祖先） */
  semantic?: string;
  /** 完整 SGR 序列（含 reset），空串表示默认样式 */
  sgr: string;
  /**
   * 原生图形标记（SPEC §12）。
   *
   * 占位 cell 上盖一个图片 id，`ImageLayer` 扫帧时把同一 id 的 cell 聚成矩形，
   * 再把 Kitty / iTerm2 / Sixel 序列放到那个位置。cell 网格本身完全不知道
   * 协议细节 —— 它只知道「这块地方属于某张图」。
   */
  graphic?: string;
}

export type Line = Cell[];

export interface Box {
  lines: Line[];
  width: number;
  height: number;
  /**
   * `lines[0..frozen)` 保证不会再变。
   *
   * 这是增量布局的核心契约：父容器只信任子节点的冻结前缀，因此可以在
   * 「最后一个子节点长大」时只重建尾部，而不是重新合成全部行。
   *
   * 前提是那个前缀**真的**没变。`frozenToken` 就是这个前提的凭证：父容器
   * 只在 token 一致时才复用旧行。比如 `<stream>` 用 `lines` 数组本身当
   * token —— 同一个数组只增不改，换一个数组就是全量重建，旧前缀不能再用。
   */
  frozen: number;
  frozenToken?: unknown;
}

export interface LayoutContext {
  depth: ColorDepth;
  /**
   * 视口顶部对应的内容行号。`"bottom"` 表示贴底（聊天记录的标准行为）。
   * 只有可视窗口会被复制成帧，因此每帧成本是 O(视口高度) 而不是 O(总行数)。
   */
  scrollTop?: number | "bottom";
  /**
   * 固定在视口顶部的行数（不参与滚动）。
   *
   * 「固定页眉 + 可滚转录 + 固定页脚」是 TUI 最常见的骨架，而 `<layer>` 只能
   * 相对**父节点**定位（父节点自己也会被滚走），所以这件事必须在视口这一层做。
   * 语义上取内容的前 N 行 —— 应用自己知道页眉有几行。
   */
  stickyTop?: number;
  /** 固定在视口底部的行数（不参与滚动）。语义上取内容的最后 N 行 */
  stickyBottom?: number;
  /** 调试用：统计测量次数 */
  stats?: { measured: number; reused: number };
}

const DEFAULT_CONTEXT: LayoutContext = { depth: "truecolor" };

interface AppendMeta {
  /** 缓存时的 flow 子节点数 */
  childCount: number;
  /** 缓存时的 node.childrenRevSum */
  childrenRevSum: number;
  /** 最后一个 flow 子节点在 node.children 中的下标 */
  childIndex: number;
  /** 内容区在 box.lines 中的 [start, end) */
  contentStart: number;
  contentEnd: number;
  /** 最后一个子节点在 box.lines 中的起点 */
  lastChildStart: number;
  lastChildRev: number;
  lastChildLines: number;
  /** 缓存时该子节点的 frozen（父数组里已有内容的冻结边界） */
  lastChildFrozen: number;
  /** 缓存时该子节点冻结前缀的凭证；不一致就不能复用旧行 */
  lastChildFrozenToken: unknown;
  /** 内容区之后的行（对象复用，重新追加即可） */
  suffix: Line[];
  /** 单条内容行的水平装饰（padding / border / margin） */
  decorate: (line: Line) => Line;
  /**
   * 缓存时**自身**样式与内衬的指纹。
   *
   * 增量快路径只重测子节点，但每一行最后都要过一遍父节点自己的装饰 ——
   * 而装饰里包含父节点自己的 SGR。父节点属性一变（比如选中行加背景），
   * 复用的旧行就会带着上一套样式，所以指纹不一致时直接放弃快路径。
   */
  selfKey: string;
  /** 边框宽度上限；新行超过它就必须整体重排 */
  maxContentWidth: number;
  forcedHeight: number | undefined;
}

interface CacheEntry {
  rev: number;
  width: number;
  height: number;
  box: Box;
  append?: AppendMeta;
}

const cache = new WeakMap<Node, CacheEntry>();

/**
 * `stream` 节点的缓存。
 *
 * `lines` 是一个**只增不改**的数组（同一个引用），所以这里只要记住「已经转换
 * 到第几行」，每次只需要把新增的行转成 cell —— 与已累积行数无关。
 */
interface StreamCache {
  linesRef: readonly { text: string }[] | undefined;
  converted: number;
  cells: Line[];
  tailText: string | undefined;
  tailCells: Line[];
  width: number;
  maxWidth: number;
}

const streamCache = new WeakMap<Node, StreamCache>();

interface ImageCache {
  rev: number;
  width: number;
  box: Box;
}

const imageCache = new WeakMap<Node, ImageCache>();

interface GraphicRect {
  left: number;
  top: number;
  cols: number;
  rows: number;
}

/**
 * `<image>` 节点。
 *
 * 组件侧已经把图片**烤成**两样东西之一：
 *   - `lines`：ANSI 字符串数组（half-block / 占位符），走普通 cell 渲染
 *   - `graphic` + `rect`：原生协议，只占位 + 打标记，真正的图形由 ImageLayer 叠加
 *
 * 所以布局这边不需要知道任何图片协议，成本也只是把已经算好的行转成 cell；
 * 并且按 `(rev, width)` 缓存 —— 图片不重渲染就不会重复解析。
 */
function measureImageNode(node: ElementNode, width: number, semantic: string | undefined): Box {
  const cached = imageCache.get(node);
  if (cached && cached.rev === node.rev && cached.width === width) return cached.box;

  const lines = (node.props.lines as readonly string[] | undefined) ?? [];
  const graphic = typeof node.props.graphic === "string" ? node.props.graphic : undefined;
  const rect = node.props.rect as GraphicRect | undefined;
  const cols = Math.max(0, Math.round(Number(node.props.cols ?? 0)));
  const rows = Math.max(
    lines.length,
    Math.round(Number(node.props.rows ?? 0)),
    graphic && rect ? rect.top + rect.rows : 0
  );

  const cells: Line[] = [];
  let maxWidth = 0;
  for (let y = 0; y < rows; y++) {
    const text = lines[y];
    const line: Line = text !== undefined ? toCells(text, node, "", semantic) : blankLine(cols, node.id, semantic);
    if (graphic && rect && y >= rect.top && y < rect.top + rect.rows) {
      let column = 0;
      for (const cell of line) {
        if (column >= rect.left && column < rect.left + rect.cols) cell.graphic = graphic;
        column += cell.width === 0 ? 0 : cell.width;
      }
    }
    if (line.length > maxWidth) maxWidth = line.length;
    cells.push(line);
  }

  // frozen = 0：图片是**全有全无**的叶子。
  //
  // 父容器的增量快路径会「保留子节点已冻结的前缀、只重新追加尾巴」。图片没有
  // 可以逐行信任的前缀 —— 重新渲染（换图 / resize / 协议降级）会让**所有**行
  // 一起变。声明 frozen = 0 让父容器老老实实整块替换，代价只是 O(图片行数)，
  // 换来的是「先布局、再更新、再布局」不会读到上一张图。
  const box: Box = { lines: cells, width: maxWidth, height: cells.length, frozen: 0 };
  imageCache.set(node, { rev: node.rev, width, box });
  return box;
}

function measureStreamNode(node: ElementNode, width: number, semantic: string | undefined): Box {
  const lines = (node.props.lines as readonly { text: string }[] | undefined) ?? [];
  let entry = streamCache.get(node);
  if (!entry || entry.linesRef !== lines || entry.width !== width) {
    entry = { linesRef: lines, converted: 0, cells: [], tailText: undefined, tailCells: [], width, maxWidth: 0 };
    streamCache.set(node, entry);
  }

  // 只转换新增的行，并增量维护最大宽度（不能用 Math.max(...map) —— 那是 O(N)）
  for (let i = entry.converted; i < lines.length; i++) {
    const line = toCells(lines[i].text, node, "", semantic);
    entry.cells.push(line);
    if (line.length > entry.maxWidth) entry.maxWidth = line.length;
  }
  entry.converted = lines.length;

  // 尾部：丢掉旧 tail，重新接上
  const tailText = typeof node.props.tail === "string" ? node.props.tail : "";
  if (entry.tailText !== tailText) {
    entry.tailText = tailText;
    entry.tailCells =
      tailText === ""
        ? []
        : Bun.wrapAnsi(tailText, Math.max(1, width), { hard: true, wordWrap: true, trim: false })
            .split("\n")
            .map(text => toCells(text, node, "", semantic));
  }
  const out = entry.cells;
  out.length = entry.converted;
  for (const line of entry.tailCells) out.push(line);

  return {
    lines: out,
    width: Math.max(entry.maxWidth, ...entry.tailCells.map(l => l.length), 0),
    height: out.length,
    frozen: entry.converted,
    // lines 数组本身即凭证：同一个数组只增不改，换数组 = 全量重建
    frozenToken: entry.linesRef,
  };
}

/** 主题 / 样式继承下来的可见样式 */
interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

// ── 工具 ────────────────────────────────────────────────────────────────────

function toInsets(value: unknown): Insets {
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }
  if (Array.isArray(value)) {
    const [a = 0, b = a] = value as number[];
    return { top: a, right: b, bottom: a, left: b };
  }
  if (value && typeof value === "object") {
    const o = value as Partial<Insets>;
    return { top: o.top ?? 0, right: o.right ?? 0, bottom: o.bottom ?? 0, left: o.left ?? 0 };
  }
  return ZERO;
}

function sumInsets(a: Insets, b: Insets): Insets {
  return {
    top: a.top + b.top,
    right: a.right + b.right,
    bottom: a.bottom + b.bottom,
    left: a.left + b.left,
  };
}

/** 解析 `40` / `"50%"`；`basis` 是百分比基准 */
function resolveSize(value: unknown, basis: number): number | undefined {
  if (typeof value === "number") return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.endsWith("%")) {
    const pct = Number.parseFloat(value);
    if (Number.isFinite(pct)) return Math.max(0, Math.floor((basis * pct) / 100));
  }
  return undefined;
}

function borderWidth(node: ElementNode): Insets {
  return node.props.border ? { top: 1, right: 1, bottom: 1, left: 1 } : ZERO;
}

function styleOf(node: ElementNode, inherited: Style, depth: ColorDepth): Style {
  const p = node.props;
  const style: Style = { ...inherited };
  // color 是主题 token；fg/bg 是直给的颜色。token 优先，允许组件只写 token
  const fg = p.color ?? p.fg;
  const bg = p.bg;
  if (typeof fg === "string") style.fg = fg;
  if (typeof bg === "string") style.bg = bg;
  for (const key of ["bold", "dim", "italic", "underline", "strikethrough"] as const) {
    if (typeof p[key] === "boolean") style[key] = p[key] as boolean;
  }
  return style;
}

function sgrOf(style: Style, depth: ColorDepth): string {
  if (depth === "none") return "";
  let out = "";
  if (style.bold) out += "\x1b[1m";
  if (style.dim) out += "\x1b[2m";
  if (style.italic) out += "\x1b[3m";
  if (style.underline) out += "\x1b[4m";
  if (style.strikethrough) out += "\x1b[9m";
  if (style.fg) out += resolveColor(style.fg, depth);
  if (style.bg) out += resolveColor(style.bg, depth, "bg");
  // 只返回「开启」序列，reset 由渲染器的状态机决定何时发
  return out;
}

/**
 * 把一个字符串按显示宽度切成 cell（Bun.stringWidth 负责 CJK / emoji）。
 *
 * 会先摘掉 ANSI 转义序列，把它转成每个 cell 的 SGR —— 否则 `\x1b[1m`
 * 会被当成 4 个可见字符算进宽度。
 */
function toCells(
  text: string,
  node: Node,
  sgr: string,
  semantic: string | undefined
): Line {
  const cells: Line = [];
  // Intl.Segmenter 按 grapheme 切，组合字符 / ZWJ emoji 不会被拆散
  const segmenter = getSegmenter();
  for (const run of parseAnsiRuns(text)) {
    const runSgr = sgr + run.sgr;
    for (const { segment } of segmenter.segment(run.text)) {
      const width = Bun.stringWidth(segment);
      if (width === 0) {
        // 组合字符附着到前一格
        const last = cells[cells.length - 1];
        if (last) last.ch += segment;
        continue;
      }
      cells.push({ ch: segment, width, node: node.id, semantic, sgr: runSgr });
      for (let i = 1; i < width; i++) {
        cells.push({ ch: "", width: 0, node: node.id, semantic, sgr: runSgr });
      }
    }
  }
  return cells;
}

let segmenter: Intl.Segmenter | undefined;
function getSegmenter(): Intl.Segmenter {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return segmenter;
}

/**
 * 空白填充 cell。
 *
 * `sgr` 默认空串（= 终端默认样式），但**容器自己撑出来的空白要带自己的
 * 样式** —— 否则 `<box bg="accent">` 只有文字那一截是彩色的，右边补的空白
 * 又变回默认背景。列表选中行整行高亮、状态栏、modal 遮罩都靠这个。
 */
function blankLine(width: number, node: number, semantic?: string, sgr = ""): Line {
  const cells: Line = [];
  for (let i = 0; i < width; i++) cells.push({ ch: " ", width: 1, node, semantic, sgr });
  return cells;
}

function padLine(line: Line, width: number, node: number, semantic?: string, sgr = ""): Line {
  if (line.length >= width) return line;
  return [...line, ...blankLine(width - line.length, node, semantic, sgr)];
}

function fitLine(line: Line, width: number): Line {
  if (line.length <= width) return line;
  const out: Line = [];
  let used = 0;
  for (const cell of line) {
    if (used + cell.width > width) break;
    out.push(cell);
    used += cell.width;
  }
  return out;
}

/** 重打语义标识：cell 归属的节点如果没有 semantic，就继承最近祖先的 */
function semanticFor(node: Node, inherited: string | undefined): string | undefined {
  return node.semantic ?? inherited;
}

// ── 核心测量 ────────────────────────────────────────────────────────────────

function measureText(
  node: TextNode,
  width: number,
  style: Style,
  depth: ColorDepth,
  semantic: string | undefined
): Box {
  const sgr = sgrOf(style, depth);
  if (node.value === "") return { lines: [], width: 0, height: 0, frozen: 0 };
  if (width <= 0) return { lines: [], width: 0, height: 0, frozen: 0 };
  // Bun.wrapAnsi：ANSI 感知 + CJK/emoji 感知折行，原生实现
  const wrapped = Bun.wrapAnsi(node.value, width, { hard: true, wordWrap: true, trim: false });
  const lines = wrapped.split("\n").map(text => toCells(text, node, sgr, semantic));
  // 文本节点一变就是整体重算，所以没有任何前缀可以保证
  return { lines, width: Math.max(0, ...lines.map(l => l.length)), height: lines.length, frozen: 0 };
}

function measureInline(
  node: ElementNode,
  innerWidth: number,
  style: Style,
  depth: ColorDepth,
  ctx: LayoutContext,
  semantic: string | undefined
): Box {
  // 不折行的两种写法：`truncate`（截断 + 省略号）/ `wrap={false}`（直接截断）。
  // 状态栏、表格单元、单行标签都需要它 —— 否则文本一超宽就折成两行，
  // 行高变得不可预测（`stickyBottom: 1` 这种「固定一行」的假设就崩了）。
  const ellipsis = node.props.truncate === true;
  const nowrap = ellipsis || node.props.wrap === false;
  // text 是 inline 容器：子节点横向流动，整体再按宽度折行
  const flat: Line = [];
  for (const child of node.children) {
    if (!inFlow(child)) continue;
    const box = measureNode(
      child,
      nowrap ? Number.MAX_SAFE_INTEGER : innerWidth,
      Number.MAX_SAFE_INTEGER,
      style,
      depth,
      ctx,
      semantic
    );
    for (const line of box.lines) flat.push(...line);
  }
  if (flat.length === 0) return { lines: [], width: 0, height: 0, frozen: 0 };

  if (nowrap) {
    const limit = Math.max(0, innerWidth);
    if (flat.length <= limit) {
      return { lines: [flat], width: flat.length, height: 1, frozen: 0 };
    }
    if (ellipsis && limit > 0) {
      const cells = flat.slice(0, limit - 1);
      const dot = toCells("…", node, sgrOf(style, depth), semantic)[0];
      if (dot) cells.push(dot);
      return { lines: [cells], width: cells.length, height: 1, frozen: 0 };
    }
    return { lines: [flat.slice(0, limit)], width: limit, height: 1, frozen: 0 };
  }

  const lines: Line[] = [];
  let current: Line = [];
  let used = 0;
  for (const cell of flat) {
    if (used + cell.width > innerWidth && current.length > 0) {
      lines.push(current);
      current = [];
      used = 0;
    }
    current.push(cell);
    used += cell.width;
  }
  if (current.length) lines.push(current);
  // inline 流的行由多个子节点拼成，任何一段变化都会影响整行，保守取 0
  return { lines, width: Math.max(0, ...lines.map(l => l.length)), height: lines.length, frozen: 0 };
}

/** 出流节点（overlay/portal）不参与常规 flow，最后单独合成 */
function inFlow(child: Node): boolean {
  if (child.kind === "sentinel") return false;
  return !(isElement(child) && child.tag === "layer");
}

/**
 * 「可以随便压窄」的节点：显式声明不折行的 text。
 *
 * 它们**最后**参与第一轮测量，先让别的兄弟节点拿走自己要的宽度，剩下的才归
 * 它们。否则状态栏这种 `<row><text truncate>长文本</text><text>右对齐</text>`
 * 会被第一个孩子按自然宽度吃光整行，右边那个直接被挤出去。
 */
function isSqueezable(node: Node): boolean {
  return (
    isElement(node) &&
    node.tag === "text" &&
    (node.props.truncate === true || node.props.wrap === false)
  );
}

function measureRow(
  node: ElementNode,
  innerWidth: number,
  innerHeight: number,
  style: Style,
  depth: ColorDepth,
  ctx: LayoutContext,
  semantic: string | undefined
): Box {
  const gap = Number(node.props.gap ?? 0);
  const kids = node.children.filter(inFlow);
  if (kids.length === 0) return { lines: [], width: 0, height: 0, frozen: 0 };
  // 容器自己撑出来的空白带自己的样式（bg 才会铺满整行）
  const sgr = sgrOf(style, depth);

  const available = Math.max(0, innerWidth - gap * (kids.length - 1));

  // 第一轮：显式宽度 / flexGrow 之外的孩子按自然宽度
  const sizes: number[] = [];
  const grow: number[] = [];
  let fixedTotal = 0;
  // 可压缩的（truncate / wrap=false）放最后量，先让兄弟节点拿走自己的宽度
  const order = kids
    .map((_, i) => i)
    .sort((a, b) => Number(isSqueezable(kids[a])) - Number(isSqueezable(kids[b])));
  for (const i of order) {
    const kid = kids[i];
    const explicit = isElement(kid) ? resolveSize(kid.props.width, innerWidth) : undefined;
    const growAmount = growOf(kid);
    if (explicit !== undefined) {
      sizes[i] = explicit;
      grow[i] = 0;
      fixedTotal += explicit;
    } else if (growAmount > 0) {
      sizes[i] = 0;
      grow[i] = growAmount;
    } else {
      // 自然宽度：先按剩余空间测一次
      const natural = measureNode(
        kid,
        Math.max(0, available - fixedTotal),
        innerHeight,
        style,
        depth,
        ctx,
        semantic
      );
      const width = Math.min(natural.width, Math.max(0, available - fixedTotal));
      sizes[i] = width;
      grow[i] = 0;
      fixedTotal += width;
    }
  }

  // 第二轮：剩余空间先按 flexGrow 分配，再交给 justify
  const growTotal = grow.reduce((a, b) => a + b, 0);
  let leftover = Math.max(0, available - fixedTotal);
  if (growTotal > 0) {
    for (let i = 0; i < sizes.length; i++) {
      if (grow[i] > 0) sizes[i] = Math.floor((leftover * grow[i]) / growTotal);
    }
    leftover = Math.max(0, leftover - sizes.reduce((a, b) => a + b, 0));
  }

  const justify = (node.props.justify as string) ?? "start";
  let leading = 0;
  let extraGap = 0;
  if (growTotal === 0) {
    if (justify === "center") leading = Math.floor(leftover / 2);
    else if (justify === "end") leading = leftover;
    else if (justify === "between" && kids.length > 1) {
      extraGap = Math.floor(leftover / (kids.length - 1));
    }
  }

  // 第三轮：按最终宽度测量并横向拼接
  const columns = kids.map((kid, i) =>
    measureNode(kid, sizes[i], innerHeight, style, depth, ctx, semantic, undefined)
  );
  const contentHeight = Math.max(0, ...columns.map(c => c.height));
  const align = (node.props.align as string) ?? "start";
  const height =
    node.props.height !== undefined ? contentHeight : contentHeight;

  const lines: Line[] = [];
  for (let y = 0; y < height; y++) {
    const line: Line = leading > 0 ? blankLine(leading, node.id, semantic, sgr) : [];
    let placed = 0;
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      // 空列（条件渲染关掉 / 空数组）不占 gap、也不占宽度 —— 同 measureColumn。
      // 注意 `<spacer/>` 也是「没有行」的，但它有分配到的宽度，不能跳过。
      if (column.lines.length === 0 && sizes[i] === 0) continue;
      if (placed > 0 && (gap > 0 || extraGap > 0)) {
        line.push(...blankLine(gap + extraGap, node.id, semantic, sgr));
      }
      placed++;
      // 交叉轴对齐
      const offset =
        align === "center"
          ? Math.floor((height - column.height) / 2)
          : align === "end"
            ? height - column.height
            : 0;
      const row = offset <= y ? column.lines[y - Math.max(0, offset)] : undefined;
      if (row) line.push(...row, ...blankLine(sizes[i] - row.length, node.id, semantic, sgr));
      else line.push(...blankLine(sizes[i], node.id, semantic, sgr));
    }
    lines.push(line);
  }
  // 一行由所有列拼成，只有所有列的这一行都冻结，整行才冻结
  const frozen = Math.min(height, ...columns.map(c => c.frozen));
  return { lines, width: Math.max(0, ...lines.map(l => l.length)), height: lines.length, frozen };
}

/**
 * 节点「自身样式 + 内衬」的指纹（见 `AppendMeta.selfKey`）。
 *
 * 只包含**由这个节点自己的属性决定**的东西：SGR、padding / margin / border。
 * 子节点怎么变都不影响它。
 */
function selfKeyOf(node: ElementNode, style: Style, depth: ColorDepth): string {
  const padding = toInsets(node.props.padding);
  const margin = toInsets(node.props.margin);
  const border = node.props.border ? String(node.props.border) : "0";
  return [
    sgrOf(style, depth),
    padding.top,
    padding.right,
    padding.bottom,
    padding.left,
    margin.top,
    margin.right,
    margin.bottom,
    margin.left,
    border,
  ].join("|");
}

function growOf(node: Node): number {
  if (!isElement(node)) return 0;
  const explicit = Number(node.props.flexGrow ?? 0);
  if (explicit > 0) return explicit;
  // <spacer/> 不给 size 时默认吃掉剩余空间
  if (node.tag === "spacer" && node.props.size === undefined) return 1;
  return 0;
}

function measureColumn(
  node: ElementNode,
  innerWidth: number,
  innerHeight: number,
  style: Style,
  depth: ColorDepth,
  ctx: LayoutContext,
  semantic: string | undefined
): Box {
  const gap = Number(node.props.gap ?? 0);
  const kids = node.children.filter(inFlow);
  if (kids.length === 0) return { lines: [], width: 0, height: 0, frozen: 0 };

  const gapTotal = gap * Math.max(0, kids.length - 1);
  const grow = kids.map(growOf);
  const growTotal = grow.reduce((a, b) => a + b, 0);

  // 第一轮：非 grow 子节点按自然高度测量，并占用纵向预算
  const measured: Box[] = new Array(kids.length);
  let fixedHeight = 0;
  for (let i = 0; i < kids.length; i++) {
    if (grow[i] > 0) continue;
    const remaining = Math.max(0, innerHeight - fixedHeight - gapTotal);
    const box = measureNode(kids[i], innerWidth, remaining, style, depth, ctx, semantic);
    measured[i] = box;
    fixedHeight += box.height;
  }

  // 第二轮：把剩余高度按 flexGrow 分给 grow 子节点（可能比自然高度小，此时裁剪）
  const remaining = Math.max(0, innerHeight - fixedHeight - gapTotal);
  for (let i = 0; i < kids.length; i++) {
    if (grow[i] === 0) continue;
    const share = Math.floor((remaining * grow[i]) / growTotal);
    measured[i] = measureNode(kids[i], innerWidth, share, style, depth, ctx, semantic, share);
  }

  const align = (node.props.align as string) ?? "start";
  const alignSgr = sgrOf(style, depth);
  const alignLine = (line: Line): Line => {
    const slack = innerWidth - line.length;
    if (slack <= 0 || align === "start" || align === "stretch") {
      return padLine(line, innerWidth, node.id, semantic, alignSgr);
    }
    const lead = align === "center" ? Math.floor(slack / 2) : slack;
    return [
      ...blankLine(lead, node.id, semantic, alignSgr),
      ...line,
      ...blankLine(slack - lead, node.id, semantic, alignSgr),
    ];
  };

  const lines: Line[] = [];
  // 空子节点（`<Show>` 关掉、`<For>` 空数组、空字符串）不占 gap。
  // 否则 `<box gap={1}>` 里几个条件渲染一关，屏幕上就凭空多出几行空白。
  let placed = 0;
  for (const box of measured) {
    if (box.lines.length === 0) continue;
    if (placed > 0 && gap > 0) {
      for (let g = 0; g < gap; g++) lines.push(blankLine(innerWidth, node.id, semantic, alignSgr));
    }
    placed++;
    lines.push(...box.lines.map(alignLine));
  }
  // 累积到第一个「还有易变尾部」的子节点为止（口径与上面一致）
  let frozen = 0;
  let counted = 0;
  for (const box of measured) {
    if (box.lines.length === 0) continue;
    if (counted > 0) frozen += gap;
    counted++;
    frozen += box.frozen;
    if (box.frozen < box.lines.length) break;
  }
  return { lines, width: innerWidth, height: lines.length, frozen };
}

function measureNode(
  node: Node,
  availableWidth: number,
  availableHeight: number,
  inherited: Style,
  depth: ColorDepth,
  ctx: LayoutContext,
  parentSemantic: string | undefined,
  forcedHeight?: number
): Box {
  const semantic = semanticFor(node, parentSemantic);

  if (node.kind !== "element") {
    return measureText(node, availableWidth, inherited, depth, semantic);
  }

  const style = styleOf(node, inherited, depth);
  const padding = toInsets(node.props.padding);
  const margin = toInsets(node.props.margin);
  const border = borderWidth(node);
  const frame = sumInsets(sumInsets(padding, margin), border);
  const innerWidth = Math.max(0, availableWidth - frame.left - frame.right);
  const innerHeight = Math.max(0, availableHeight - frame.top - frame.bottom);

  // ── 增量快路径 ───────────────────────────────────────────────────────────
  // 只有「容器结构没变、只有最后一段内容在增长」时才走这里。
  const cached = cache.get(node);
  if (
    cached &&
    cached.width === availableWidth &&
    cached.height === availableHeight &&
    cached.append &&
    cached.append.forcedHeight === forcedHeight
  ) {
    const fast = tryIncremental(node, cached, innerWidth, innerHeight, style, depth, ctx, semantic);
    if (fast) {
      if (ctx.stats) ctx.stats.reused++;
      return fast;
    }
  }

  if (ctx.stats) ctx.stats.measured++;

  let box: Box;
  if (node.tag === "text") {
    box = measureInline(node, innerWidth, style, depth, ctx, semantic);
  } else if (node.tag === "row") {
    box = measureRow(node, innerWidth, innerHeight, style, depth, ctx, semantic);
  } else if (node.tag === "spacer") {
    box = { lines: [], width: Number(node.props.size ?? 0), height: 0, frozen: 0 };
  } else if (node.tag === "stream") {
    box = measureStreamNode(node, innerWidth, semantic);
  } else if (node.tag === "image") {
    box = measureImageNode(node, innerWidth, semantic);
  } else {
    box = measureColumn(node, innerWidth, innerHeight, style, depth, ctx, semantic);
  }

  // 显式尺寸是「外框尺寸」（border-box），内容区要扣掉 border / padding / margin
  const explicitWidth = resolveSize(node.props.width, availableWidth);
  const explicitHeight = forcedHeight ?? resolveSize(node.props.height, availableHeight);
  const frameX = frame.left + frame.right;
  const frameY = frame.top + frame.bottom;
  const contentWidth = explicitWidth !== undefined ? Math.max(0, explicitWidth - frameX) : box.width;
  const targetHeight =
    explicitHeight !== undefined ? Math.max(0, explicitHeight - frameY) : box.height;
  const clips = node.props.overflow === "hidden" || node.props.overflow === "scroll";
  const contentHeight = clips
    ? Math.min(targetHeight, Math.max(0, availableHeight - frameY))
    : targetHeight;
  const scrollOffset = Number(node.props.scrollOffset ?? 0);

  // stream / image 节点的内容行已经是最终形态；没有装饰时直接返回，
  // 避免 O(N) 的通用组合
  if (
    (node.tag === "stream" || node.tag === "image") &&
    !node.props.border &&
    node.props.padding === undefined &&
    node.props.margin === undefined &&
    !clips &&
    scrollOffset === 0 &&
    explicitWidth === undefined &&
    explicitHeight === undefined
  ) {
    cache.set(node, { rev: node.rev, width: availableWidth, height: availableHeight, box, append: undefined });
    compositeLayers(node, box, availableWidth, availableHeight, style, depth, ctx, semantic);
    return box;
  }

  let contentLines = box.lines.map(line => fitLine(line, contentWidth));
  if (scrollOffset > 0) contentLines = contentLines.slice(scrollOffset);
  contentLines = contentLines.slice(0, contentHeight);
  const ownSgr = sgrOf(style, depth);
  contentLines = contentLines.map(line => padLine(line, contentWidth, node.id, semantic, ownSgr));
  while (explicitHeight !== undefined && contentLines.length < contentHeight) {
    contentLines.push(blankLine(contentWidth, node.id, semantic, ownSgr));
  }

  // ── 组合：prefix + content + suffix ──────────────────────────────────────
  const bordered = node.props.border
    ? borderSpec(node, style, depth, semantic, contentWidth + padding.left + padding.right)
    : null;
  const innerTotal = contentWidth + padding.left + padding.right;
  const totalWidth = innerTotal + (bordered ? 2 : 0) + margin.left + margin.right;

  const decorate = (line: Line): Line => {
    let out = padLine(line, contentWidth, node.id, semantic);
    if (padding.left || padding.right) {
      out = [
        ...blankLine(padding.left, node.id, semantic),
        ...out,
        ...blankLine(padding.right, node.id, semantic),
      ];
    }
    if (bordered) {
      out = [
        ...bordered.left,
        ...padLine(out, bordered.innerWidth, node.id, semantic),
        ...bordered.right,
      ];
    }
    if (margin.left || margin.right) {
      out = [
        ...blankLine(margin.left, node.id, semantic),
        ...out,
        ...blankLine(margin.right, node.id, semantic),
      ];
    }
    return out;
  };

  const prefix: Line[] = [];
  const suffix: Line[] = [];
  const pushMarginRow = (target: Line[]) => {
    if (totalWidth > 0) target.push(blankLine(totalWidth, node.id, semantic));
  };
  for (let i = 0; i < margin.top; i++) pushMarginRow(prefix);
  if (bordered) prefix.push(edgeLine(bordered.top, bordered, node, semantic, totalWidth, margin));
  for (let i = 0; i < padding.top; i++) pushMarginRow(prefix);
  for (let i = 0; i < padding.bottom; i++) pushMarginRow(suffix);
  if (bordered) suffix.push(edgeLine(bordered.bottom, bordered, node, semantic, totalWidth, margin));
  for (let i = 0; i < margin.bottom; i++) pushMarginRow(suffix);

  const lines = [...prefix, ...contentLines.map(decorate), ...suffix];
  const contentStart = prefix.length;
  const contentEnd = contentStart + contentLines.length;
  const frozen = clips || scrollOffset > 0 ? 0 : contentStart + box.frozen;

  const result: Box = { lines, width: totalWidth, height: lines.length, frozen };

  // ── 记录增量元数据 ──────────────────────────────────────────────────────
  const kids = node.children.filter(inFlow);
  // 增量快路径只对「纵向堆叠」的容器成立：inline / row 的子节点是在同一行里
  // 横向拼接的，`lastChildStart` 这种「行号区间」没有意义。
  const stackable = node.tag !== "text" && node.tag !== "row";
  if (stackable && !clips && scrollOffset === 0 && kids.length > 0) {
    const lastIndex = node.children.indexOf(kids[kids.length - 1]);
    const lastLines = measureNode(
      kids[kids.length - 1],
      innerWidth,
      innerHeight,
      style,
      depth,
      ctx,
      semantic
    );
    const beforeLast = contentEnd - contentStart - lastLines.lines.length;
    cachedMeta.set(node, {
      childCount: kids.length,
      childrenRevSum: node.childrenRevSum,
      contentStart,
      contentEnd,
      lastChildStart: contentStart + Math.max(0, beforeLast),
      lastChildRev: kids[kids.length - 1].rev,
      lastChildLines: lastLines.lines.length,
      lastChildFrozen: lastLines.frozen,
      lastChildFrozenToken: lastLines.frozenToken,
      suffix,
      decorate,
      selfKey: selfKeyOf(node, style, depth),
      maxContentWidth: contentWidth,
      forcedHeight,
      childIndex: lastIndex,
    });
  } else {
    cachedMeta.delete(node);
  }

  cache.set(node, { rev: node.rev, width: availableWidth, height: availableHeight, box: result, append: cachedMeta.get(node) });

  // overlay / portal（SPEC §9.4）：出流子节点按 (x, y) 合成到本节点之上
  compositeLayers(node, result, availableWidth, availableHeight, style, depth, ctx, semantic);
  return result;
}

/** 把 layer 子节点合成到父节点之上 */
function compositeLayers(
  node: ElementNode,
  result: Box,
  availableWidth: number,
  availableHeight: number,
  style: Style,
  depth: ColorDepth,
  ctx: LayoutContext,
  semantic: string | undefined
): void {
  for (const layer of node.children) {
    if (!isElement(layer) || layer.tag !== "layer") continue;
    const lx = Number(layer.props.x ?? 0);
    const ly = Number(layer.props.y ?? 0);
    const layerBox = measureNode(
      layer,
      Math.max(0, availableWidth - lx),
      Math.max(0, availableHeight - ly),
      style,
      depth,
      ctx,
      semantic
    );
    for (let i = 0; i < layerBox.lines.length; i++) {
      const target = result.lines[ly + i];
      if (!target) continue;
      const source = layerBox.lines[i];
      for (let x = 0; x < source.length; x++) {
        const cx = lx + x;
        if (cx < 0 || cx >= target.length) continue;
        const cell = source[x];
        if (cell.width === 0) continue;
        target[cx] = cell;
        for (let k = 1; k < cell.width; k++) {
          if (cx + k < target.length) target[cx + k] = { ...cell, ch: "", width: 0 };
        }
      }
    }
  }
}

/** 增量元数据单独存，避免 Box 上挂内部字段 */
const cachedMeta = new WeakMap<Node, AppendMeta>();

/**
 * 尝试增量重建。
 *
 * 两种情形：
 *
 * A. **追加了新子节点** —— 前面的子节点通过 `childrenRevSum` 的差被证明没变，
 *    所以直接把新子节点的行接在内容区末尾，再把 suffix 补回去。
 * B. **只有最后一个子节点变了** —— 从它的起点截断，重新接上它的行与 suffix。
 *
 * 两种情形都只做 O(新增行数 + suffix) 的工作，与已累积行数无关。
 */
function tryIncremental(
  node: ElementNode,
  cached: CacheEntry,
  innerWidth: number,
  innerHeight: number,
  style: Style,
  depth: ColorDepth,
  ctx: LayoutContext,
  semantic: string | undefined
): Box | null {
  const meta = cached.append;
  if (!meta) return null;
  // 自己的样式 / 内衬变了 → 旧行上的装饰不能再用
  if (meta.selfKey !== selfKeyOf(node, style, depth)) return null;
  const kids = node.children.filter(inFlow);
  if (kids.length < meta.childCount) return null;

  const lines = cached.box.lines;
  const appended = kids.length > meta.childCount;

  if (appended) {
    // 前缀（原有子节点）必须原封不动：childrenRevSum 的差恰好等于新增部分的 rev 和
    let tailSum = 0;
    for (let i = meta.childCount; i < kids.length; i++) tailSum += kids[i].rev;
    if (node.childrenRevSum - tailSum !== meta.childrenRevSum) return null;

    lines.length = meta.contentEnd;
    let addedFrozen = 0;
    let addedLines = 0;
    for (let i = meta.childCount; i < kids.length; i++) {
      const childBox = measureNode(kids[i], innerWidth, innerHeight, style, depth, ctx, semantic);
      for (const line of childBox.lines) lines.push(meta.decorate(line));
      addedFrozen += childBox.frozen;
      addedLines += childBox.lines.length;
    }
    const previousContent = meta.contentEnd - meta.contentStart;
    meta.contentEnd = meta.contentStart + previousContent + addedLines;
    meta.childCount = kids.length;
    meta.childrenRevSum = node.childrenRevSum;
    meta.lastChildRev = kids[kids.length - 1].rev;
    meta.lastChildLines = addedLines || meta.lastChildLines;
    meta.lastChildStart = meta.contentEnd - meta.lastChildLines;
    lines.push(...meta.suffix);
    cached.box.height = lines.length;
    // 原有内容此刻全部冻结，新增部分只冻结各自的 frozen 前缀
    cached.box.frozen = meta.contentStart + previousContent + addedFrozen;
    return cached.box;
  }

  // 情形 B：只有最后一个子节点变了
  const last = kids[kids.length - 1];
  const onlyLastChanged =
    kids.length === meta.childCount &&
    last.rev !== meta.lastChildRev &&
    node.childrenRevSum - meta.childrenRevSum === last.rev - meta.lastChildRev;
  if (!onlyLastChanged) return null;

  const childBox = measureNode(last, innerWidth, innerHeight, style, depth, ctx, semantic);
  // 关键：截断点必须用**父数组里已有的**那部分（旧 frozen），而不是子节点
  // 现在的新 frozen —— 子节点的冻结前缀会增长，多出来的那些行父数组里还没有。
  // 冻结前缀的凭证变了（例如 <stream> 换了一个 lines 数组）→ 旧行一行都不能信
  const reusableFrozen =
    meta.lastChildFrozenToken === childBox.frozenToken ? meta.lastChildFrozen : 0;
  const keepFromChild = Math.min(reusableFrozen, meta.lastChildLines);
  const keep = meta.lastChildStart + keepFromChild;
  if (keep > lines.length) return null;
  lines.length = keep;
  for (let i = keepFromChild; i < childBox.lines.length; i++) {
    lines.push(meta.decorate(childBox.lines[i]));
  }
  lines.push(...meta.suffix);
  meta.contentEnd = keep + (childBox.lines.length - keepFromChild);
  meta.lastChildLines = childBox.lines.length;
  meta.lastChildFrozen = childBox.frozen;
  meta.lastChildFrozenToken = childBox.frozenToken;
  meta.lastChildRev = last.rev;
  meta.childrenRevSum = node.childrenRevSum;
  cached.box.height = lines.length;
  cached.box.frozen = meta.lastChildStart + childBox.frozen;
  return cached.box;
}

interface BorderSpec {
  top: Line;
  bottom: Line;
  left: Line;
  right: Line;
  innerWidth: number;
}

function borderSpec(
  node: ElementNode,
  style: Style,
  depth: ColorDepth,
  semantic: string | undefined,
  innerWidth: number
): BorderSpec {
  const kind = typeof node.props.border === "string" ? node.props.border : "round";
  const glyphs = BORDER_GLYPHS[kind as keyof typeof BORDER_GLYPHS] ?? BORDER_GLYPHS.round;
  const borderStyle: Style = {
    ...style,
    fg: (node.props.borderColor as string) ?? style.fg,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
  };
  const sgr = sgrOf(borderStyle, depth);
  const horizontal = (left: string, middle: string, right: string): Line => {
    const cells = toCells(left, node, sgr, semantic);
    // 总宽 = innerWidth + 2：左边 1 格 + 中间 innerWidth 格 + 右边 1 格
    while (cells.length < innerWidth + 1) cells.push(...toCells(middle, node, sgr, semantic));
    cells.push(...toCells(right, node, sgr, semantic));
    return cells.slice(0, innerWidth + 2);
  };
  return {
    top: horizontal(glyphs[0], glyphs[1], glyphs[2]),
    bottom: horizontal(glyphs[5], glyphs[6], glyphs[7]),
    left: toCells(glyphs[3], node, sgr, semantic),
    right: toCells(glyphs[4], node, sgr, semantic),
    innerWidth,
  };
}

function edgeLine(
  edge: Line,
  spec: BorderSpec,
  node: ElementNode,
  semantic: string | undefined,
  totalWidth: number,
  margin: Insets
): Line {
  const out = [
    ...blankLine(margin.left, node.id, semantic),
    ...edge,
    ...blankLine(margin.right, node.id, semantic),
  ];
  return padLine(out, totalWidth, node.id, semantic).slice(0, totalWidth);
}

const BORDER_GLYPHS = {
  single: ["┌", "─", "┐", "│", "│", "└", "─", "┘"],
  round: ["╭", "─", "╮", "│", "│", "╰", "─", "╯"],
  double: ["╔", "═", "╗", "║", "║", "╚", "═", "╝"],
  heavy: ["┏", "━", "┓", "┃", "┃", "┗", "━", "┛"],
} as const;

function drawBorder(
  node: ElementNode,
  lines: Line[],
  style: Style,
  depth: ColorDepth,
  semantic: string | undefined
): Line[] {
  const kind = typeof node.props.border === "string" ? node.props.border : "round";
  const glyphs = BORDER_GLYPHS[kind as keyof typeof BORDER_GLYPHS] ?? BORDER_GLYPHS.round;
  const borderStyle: Style = {
    ...style,
    fg: (node.props.borderColor as string) ?? style.fg,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
  };
  const sgr = sgrOf(borderStyle, depth);
  const width = Math.max(0, ...lines.map(l => l.length)) + 2;

  const edge = (left: string, middle: string, right: string): Line => {
    const cells = toCells(left, node, sgr, semantic);
    while (cells.length < width - 1) cells.push(...toCells(middle, node, sgr, semantic));
    cells.push(...toCells(right, node, sgr, semantic));
    return cells.slice(0, width);
  };

  const body = lines.map(line => [
    ...toCells(glyphs[3], node, sgr, semantic),
    ...line,
    ...blankLine(Math.max(0, width - 2 - line.length), node.id, semantic),
    ...toCells(glyphs[4], node, sgr, semantic),
  ]);

  return [edge(glyphs[0], glyphs[1], glyphs[2]), ...body, edge(glyphs[5], glyphs[6], glyphs[7])];
}

// ── 对外 API ────────────────────────────────────────────────────────────────

export interface Frame {
  lines: Line[];
  width: number;
  height: number;
  /**
   * 滚动区第一行在**滚动区内**的行号。
   *
   * 恒有 `0 <= top <= total - height`，所以「是否贴底」直接用
   * `top >= total - height` 判断即可 —— `ScrollView` 就是这么做的，而且这个
   * 等式在有固定页眉 / 页脚（`stickyTop` / `stickyBottom`）时依然成立：
   * 固定区只缩小滚动区，不改变 `total - height` 的差值。
   */
  top: number;
  /** 内容总行数（含固定页眉 / 页脚） */
  total: number;
  /** 语义 hit test：返回 `message:<id>` 这类标识（SPEC §4.2） */
  semanticAt(x: number, y: number): string | undefined;
  /** 返回节点 id */
  nodeAt(x: number, y: number): number | undefined;
  /** 扁平化文本，测试用 */
  text(): string;
}

export function layout(
  root: Node,
  width: number,
  height: number,
  context: Partial<LayoutContext> = {}
): Frame {
  const ctx: LayoutContext = { ...DEFAULT_CONTEXT, ...context };
  const box = measureNode(root, width, height, {}, ctx.depth, ctx, undefined);

  const total = box.lines.length;

  // ── 固定页眉 / 页脚 ────────────────────────────────────────────────────
  // 只滚动中间那段。`top` / `total` 仍然按**整块内容**算，这样
  // `maxTop === total - height` 对调用方（比如 ScrollView）依然成立。
  const rows = Math.max(0, Math.floor(height));
  const stickyTop = Math.max(0, Math.min(Math.floor(ctx.stickyTop ?? 0) || 0, rows));
  const stickyBottom = Math.max(
    0,
    Math.min(Math.floor(ctx.stickyBottom ?? 0) || 0, rows - stickyTop, total - stickyTop)
  );
  const bodyStart = Math.min(stickyTop, total);
  const bodyEnd = Math.max(bodyStart, total - stickyBottom);
  const bodyHeight = Math.max(0, rows - stickyTop - stickyBottom);

  const maxTop = Math.max(0, bodyEnd - bodyStart - bodyHeight);
  const requested = ctx.scrollTop ?? 0;
  // 偏移是**滚动区内**的行号（不是整块内容的绝对行号）：
  // 这样 `maxTop === total - height` 在有没有固定页眉/页脚时都成立，
  // 调用方（ScrollView）不用知道固定区有几行。
  const bodyTop =
    requested === "bottom"
      ? maxTop
      : Math.max(0, Math.min(Math.floor(requested), maxTop));
  const top = bodyTop;
  const bodyOffset = bodyStart + bodyTop;

  // 只把可视窗口复制成帧：与总行数无关
  const lines: Line[] = [];
  const push = (line: Line): void => {
    lines.push(padLine(fitLine(line, width), width, root.id));
  };
  for (let i = 0; i < bodyStart; i++) push(box.lines[i]);
  for (let i = bodyOffset; i < Math.min(bodyOffset + bodyHeight, bodyEnd); i++) {
    push(box.lines[i]);
  }
  for (let i = bodyEnd; i < total; i++) push(box.lines[i]);
  while (lines.length < height) lines.push(blankLine(width, root.id));

  return {
    lines,
    width,
    height,
    top,
    total,
    nodeAt(x, y) {
      const line = lines[y];
      if (!line) return undefined;
      let used = 0;
      for (const cell of line) {
        if (used === x || (cell.width > 0 && used + cell.width > x)) return cell.node;
        used += cell.width;
      }
      return line[line.length - 1]?.node;
    },
    semanticAt(x, y) {
      const line = lines[y];
      if (!line) return undefined;
      let used = 0;
      for (const cell of line) {
        if (used === x || (cell.width > 0 && used + cell.width > x)) return cell.semantic;
        used += cell.width;
      }
      return line[line.length - 1]?.semantic;
    },
    text() {
      return lines
        .map(line => line.map(c => (c.width === 0 ? "" : c.ch)).join("").replace(/\s+$/, ""))
        .join("\n");
    },
  };
}

export function clearLayoutCache(): void {
  // WeakMap 无法清空；这里只是语义占位，测试用
}
