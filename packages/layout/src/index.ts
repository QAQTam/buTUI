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
}

export type Line = Cell[];

export interface Box {
  lines: Line[];
  width: number;
  height: number;
}

export interface LayoutContext {
  depth: ColorDepth;
  /** 调试用：统计测量次数 */
  stats?: { measured: number; reused: number };
}

const DEFAULT_CONTEXT: LayoutContext = { depth: "truecolor" };

const cache = new WeakMap<Node, { rev: number; width: number; height: number; box: Box }>();

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
  if (style.bg) out += resolveColor(style.bg, depth);
  // 只返回「开启」序列，reset 由渲染器的状态机决定何时发
  return out;
}

/** 把一个字符串按显示宽度切成 cell（Bun.stringWidth 负责 CJK / emoji） */
function toCells(
  text: string,
  node: Node,
  sgr: string,
  semantic: string | undefined
): Line {
  const cells: Line = [];
  // Intl.Segmenter 按 grapheme 切，组合字符 / ZWJ emoji 不会被拆散
  const segmenter = getSegmenter();
  for (const { segment } of segmenter.segment(text)) {
    const width = Bun.stringWidth(segment);
    if (width === 0) {
      // 组合字符附着到前一格
      const last = cells[cells.length - 1];
      if (last) last.ch += segment;
      continue;
    }
    cells.push({ ch: segment, width, node: node.id, semantic, sgr });
    for (let i = 1; i < width; i++) {
      cells.push({ ch: "", width: 0, node: node.id, semantic, sgr });
    }
  }
  return cells;
}

let segmenter: Intl.Segmenter | undefined;
function getSegmenter(): Intl.Segmenter {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return segmenter;
}

function blankLine(width: number, node: number, semantic?: string): Line {
  const cells: Line = [];
  for (let i = 0; i < width; i++) cells.push({ ch: " ", width: 1, node, semantic, sgr: "" });
  return cells;
}

function padLine(line: Line, width: number, node: number, semantic?: string): Line {
  if (line.length >= width) return line;
  return [...line, ...blankLine(width - line.length, node, semantic)];
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
  if (node.value === "") return { lines: [], width: 0, height: 0 };
  if (width <= 0) return { lines: [], width: 0, height: 0 };
  // Bun.wrapAnsi：ANSI 感知 + CJK/emoji 感知折行，原生实现
  const wrapped = Bun.wrapAnsi(node.value, width, { hard: true, wordWrap: true, trim: false });
  const lines = wrapped.split("\n").map(text => toCells(text, node, sgr, semantic));
  return { lines, width: Math.max(0, ...lines.map(l => l.length)), height: lines.length };
}

function measureInline(
  node: ElementNode,
  innerWidth: number,
  style: Style,
  depth: ColorDepth,
  ctx: LayoutContext,
  semantic: string | undefined
): Box {
  // text 是 inline 容器：子节点横向流动，整体再按宽度折行
  const flat: Line = [];
  for (const child of node.children) {
    if (!inFlow(child)) continue;
    const box = measureNode(child, innerWidth, Number.MAX_SAFE_INTEGER, style, depth, ctx, semantic);
    for (const line of box.lines) flat.push(...line);
  }
  if (flat.length === 0) return { lines: [], width: 0, height: 0 };

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
  return { lines, width: Math.max(0, ...lines.map(l => l.length)), height: lines.length };
}

/** 出流节点（overlay/portal）不参与常规 flow，最后单独合成 */
function inFlow(child: Node): boolean {
  if (child.kind === "sentinel") return false;
  return !(isElement(child) && child.tag === "layer");
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
  if (kids.length === 0) return { lines: [], width: 0, height: 0 };

  const available = Math.max(0, innerWidth - gap * (kids.length - 1));

  // 第一轮：显式宽度 / flexGrow 之外的孩子按自然宽度
  const sizes: number[] = [];
  const grow: number[] = [];
  let fixedTotal = 0;
  for (const kid of kids) {
    const explicit = isElement(kid) ? resolveSize(kid.props.width, innerWidth) : undefined;
    const growAmount = growOf(kid);
    if (explicit !== undefined) {
      sizes.push(explicit);
      grow.push(0);
      fixedTotal += explicit;
    } else if (growAmount > 0) {
      sizes.push(0);
      grow.push(growAmount);
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
      sizes.push(width);
      grow.push(0);
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
    const line: Line = leading > 0 ? blankLine(leading, node.id, semantic) : [];
    for (let i = 0; i < columns.length; i++) {
      if (i > 0 && (gap > 0 || extraGap > 0)) {
        line.push(...blankLine(gap + extraGap, node.id, semantic));
      }
      const column = columns[i];
      // 交叉轴对齐
      const offset =
        align === "center"
          ? Math.floor((height - column.height) / 2)
          : align === "end"
            ? height - column.height
            : 0;
      const row = offset <= y ? column.lines[y - Math.max(0, offset)] : undefined;
      if (row) line.push(...row, ...blankLine(sizes[i] - row.length, node.id, semantic));
      else line.push(...blankLine(sizes[i], node.id, semantic));
    }
    lines.push(line);
  }
  return { lines, width: Math.max(0, ...lines.map(l => l.length)), height: lines.length };
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
  if (kids.length === 0) return { lines: [], width: 0, height: 0 };

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
  const alignLine = (line: Line): Line => {
    const slack = innerWidth - line.length;
    if (slack <= 0 || align === "start" || align === "stretch") {
      return padLine(line, innerWidth, node.id, semantic);
    }
    const lead = align === "center" ? Math.floor(slack / 2) : slack;
    return [
      ...blankLine(lead, node.id, semantic),
      ...line,
      ...blankLine(slack - lead, node.id, semantic),
    ];
  };

  const lines: Line[] = [];
  for (let i = 0; i < measured.length; i++) {
    if (i > 0 && gap > 0) {
      for (let g = 0; g < gap; g++) lines.push(blankLine(innerWidth, node.id, semantic));
    }
    lines.push(...measured[i].lines.map(alignLine));
  }
  return { lines, width: innerWidth, height: lines.length };
}

function measureNode(
  node: Node,
  availableWidth: number,
  availableHeight: number,
  inherited: Style,
  depth: ColorDepth,
  ctx: LayoutContext,
  parentSemantic: string | undefined,
  /**
   * flex 分配下来的确定高度。与 `props.height` 的区别是它来自父容器的
   * 剩余空间计算，子节点必须接受这个尺寸（必要时裁剪或补白）。
   */
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

  let box: Box;
  if (node.tag === "text") {
    box = measureInline(node, innerWidth, style, depth, ctx, semantic);
  } else if (node.tag === "row") {
    box = measureRow(node, innerWidth, innerHeight, style, depth, ctx, semantic);
  } else if (node.tag === "spacer") {
    const size = Number(node.props.size ?? 0);
    box = { lines: [], width: size, height: 0 };
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
  // 只有显式声明 overflow: hidden|scroll 的节点才会被父容器的可用高度裁剪。
  // 默认（未声明）视为 visible —— 否则一个放不下的 <text> 会被静默裁成 0 行。
  const clips = node.props.overflow === "hidden" || node.props.overflow === "scroll";
  const contentHeight = clips
    ? Math.min(targetHeight, Math.max(0, availableHeight - frameY))
    : targetHeight;

  let lines = box.lines.map(line => fitLine(line, contentWidth));
  // 先按滚动偏移取窗口，再按可视高度裁剪 —— 反过来会把要显示的行提前切掉
  const scrollOffset = Number(node.props.scrollOffset ?? 0);
  if (scrollOffset > 0) lines = lines.slice(scrollOffset);
  lines = lines.slice(0, contentHeight);
  lines = lines.map(line => padLine(line, contentWidth, node.id, semantic));
  // 显式高度 / flex 分配的高度要撑满，否则 border 只包住内容
  while (explicitHeight !== undefined && lines.length < contentHeight) {
    lines.push(blankLine(contentWidth, node.id, semantic));
  }

  // padding / margin / border
  if (padding.left || padding.right) {
    lines = lines.map(line => [
      ...blankLine(padding.left, node.id, semantic),
      ...line,
      ...blankLine(padding.right, node.id, semantic),
    ]);
  }
  const paddedWidth = Math.max(0, ...lines.map(l => l.length));
  for (let i = 0; i < padding.top; i++) lines.unshift(blankLine(paddedWidth, node.id, semantic));
  for (let i = 0; i < padding.bottom; i++) lines.push(blankLine(paddedWidth, node.id, semantic));

  if (node.props.border) lines = drawBorder(node, lines, style, depth, semantic);
  if (margin.left || margin.right) {
    lines = lines.map(line => [
      ...blankLine(margin.left, node.id, semantic),
      ...line,
      ...blankLine(margin.right, node.id, semantic),
    ]);
  }
  for (let i = 0; i < margin.top; i++) {
    lines.unshift(blankLine(Math.max(0, ...lines.map(l => l.length)), node.id, semantic));
  }
  for (let i = 0; i < margin.bottom; i++) {
    lines.push(blankLine(Math.max(0, ...lines.map(l => l.length)), node.id, semantic));
  }

  // overlay / portal（SPEC §9.4）：出流子节点按 (x, y) 合成到本节点之上
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
      const y = ly + i;
      const target = lines[y];
      if (!target) continue;
      const source = layerBox.lines[i];
      for (let x = 0; x < source.length; x++) {
        const cx = lx + x;
        if (cx < 0 || cx >= target.length) continue;
        const cell = source[x];
        if (cell.width === 0) continue;
        target[cx] = cell;
        // 宽字符：把后继占位也覆盖掉，避免出现半格残留
        for (let k = 1; k < cell.width; k++) {
          const placeholder = cx + k;
          if (placeholder < target.length) {
            target[placeholder] = { ...cell, ch: "", width: 0 };
          }
        }
      }
    }
  }

  return {
    lines,
    width: Math.max(0, ...lines.map(l => l.length)),
    height: lines.length,
  };
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
  const cached = cache.get(root);
  let box: Box;
  if (cached && cached.rev === root.rev && cached.width === width && cached.height === height) {
    box = cached.box;
    if (ctx.stats) ctx.stats.reused++;
  } else {
    box = measureNode(root, width, height, {}, ctx.depth, ctx, undefined);
    cache.set(root, { rev: root.rev, width, height, box });
    if (ctx.stats) ctx.stats.measured++;
  }

  const lines = box.lines.map(line => fitLine(line, width));
  const padded = lines.map(line => padLine(line, width, root.id));
  // 补齐到视口高度：帧始终是 width×height，hit test / 差分都不需要额外边界判断
  while (padded.length < height) padded.push(blankLine(width, root.id));

  return {
    lines: padded,
    width,
    height,
    nodeAt(x, y) {
      const line = padded[y];
      if (!line) return undefined;
      let used = 0;
      for (const cell of line) {
        if (used === x || (cell.width > 0 && used + cell.width > x)) return cell.node;
        used += cell.width;
      }
      return line[line.length - 1]?.node;
    },
    semanticAt(x, y) {
      const line = padded[y];
      if (!line) return undefined;
      let used = 0;
      for (const cell of line) {
        if (used === x || (cell.width > 0 && used + cell.width > x)) return cell.semantic;
        used += cell.width;
      }
      return line[line.length - 1]?.semantic;
    },
    text() {
      return padded
        .map(line => line.map(c => (c.width === 0 ? "" : c.ch)).join("").replace(/\s+$/, ""))
        .join("\n");
    },
  };
}

export function clearLayoutCache(): void {
  // WeakMap 无法清空；这里只是语义占位，测试用
}
