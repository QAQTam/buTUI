/**
 * Solid 绑定 —— 把流式引擎接到 Solid 的细粒度响应式上。
 *
 * ## 为什么不是「一行一个 Solid 节点」
 *
 * 直觉方案是 `<For each={lines}>` 一行一个 `<text>`。但实测 Solid 的 `For`
 * 每次都要对数组做一次 O(N) 的 reconcile（common-prefix 扫描），所以每来一个
 * delta 就是 O(N)：
 *
 *     N=100   → 0.09 ms/push
 *     N=9000  → 4.40 ms/push
 *
 * （`createStore(..., {shallow: true})` 会让它变成常数，但 shallow store 的
 * 子数组不再被代理，`push` 根本不触发更新 —— 是个假象。）
 *
 * ## 实际方案：一个节点 + 一次 setProp
 *
 * `lines` 是**只增不改**的普通数组（引用恒定），`version()` 是每次 push 自增的
 * 信号。组件渲染成单个 `<stream>` 节点：
 *
 *   - Solid 侧：一次 `setProp`，O(1)；
 *   - 布局侧：`measureStreamNode` 只把新增行转成 cell，O(新增)；
 *   - 渲染侧：帧只复制可视窗口，O(视口)。
 *
 * 这才是真正的 O(1)，而且仍然是「细粒度」——变化被限制在一个属性上，
 * 不会重建任何子树。
 */
import { createSignal } from "solid-js";
import { LineBuffer } from "./line-buffer.ts";
import { MarkdownStream, type MarkdownStreamOptions } from "./markdown.ts";

export interface StreamLine {
  id: number;
  /** 可能带 ANSI */
  text: string;
  stable: boolean;
}

export interface StreamSource {
  /** 已定稿的行。**只增不改**：同一个数组引用，只在末尾追加 */
  readonly lines: readonly StreamLine[];
  /** 未定稿的尾部文本（0~2 行） */
  readonly tail: () => string;
  /** 每次内容变化自增 —— 用来触发 `<stream>` 节点重新测量 */
  readonly version: () => number;
  push(delta: string): void;
  flush(): void;
  /** 已经不会再变的行数 */
  readonly frozen: number;
  readonly stats: Readonly<Record<string, number>>;
  /**
   * 可选：内容变化通知。
   *
   * `createSmoothStream()` 用它驱动 reveal cursor；自定义 source 如果要做
   * 平滑显现，应实现这个订阅。返回函数用于退订。
   */
  onChange?(listener: () => void): () => void;
}

/** 纯文本流：增量折行 */
export function createTextStream(options: { width: number }): StreamSource {
  const buffer = new LineBuffer({ width: options.width });
  const lines: StreamLine[] = [];
  const [version, setVersion] = createSignal(0);
  const listeners = new Set<() => void>();
  let tailText = "";
  let nextId = 1;
  let flushed = false;

  const refresh = (added: string[]): void => {
    for (const text of added) lines.push({ id: nextId++, text, stable: true });
    tailText = buffer.tailLines().join("\n");
    setVersion(v => v + 1);
    for (const listener of [...listeners]) listener();
  };

  return {
    lines,
    tail: () => tailText,
    version,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get frozen() {
      return buffer.committedCount;
    },
    get stats() {
      return buffer.stats as unknown as Record<string, number>;
    },
    push(delta) {
      if (flushed) throw new Error("[butui] stream 已经 flush，不能再 push");
      refresh(buffer.push(delta));
    },
    flush() {
      if (flushed) return;
      const added = buffer.flush();
      flushed = true;
      for (const text of added) lines.push({ id: nextId++, text, stable: true });
      tailText = "";
      setVersion(v => v + 1);
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Markdown 流：块状态机 + 增量折行 */
export function createMarkdownStream(options: MarkdownStreamOptions): StreamSource {
  const stream = new MarkdownStream(options);
  const lines: StreamLine[] = [];
  const [version, setVersion] = createSignal(0);
  const listeners = new Set<() => void>();
  let tailText = "";
  let syncedFrozen = 0;
  let nextId = 1;
  let flushed = false;

  const sync = (): void => {
    const frozen = stream.frozenCount;
    if (frozen > syncedFrozen) {
      for (const line of stream.frozenLinesFrom(syncedFrozen)) {
        lines.push({ id: nextId++, text: line.text, stable: true });
      }
      syncedFrozen = frozen;
    }
    tailText = stream.tailLines().map(line => line.text).join("\n");
    setVersion(v => v + 1);
    for (const listener of [...listeners]) listener();
  };

  return {
    lines,
    tail: () => tailText,
    version,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get frozen() {
      return stream.frozenCount;
    },
    get stats() {
      return stream.stats as unknown as Record<string, number>;
    },
    push(delta) {
      if (flushed) throw new Error("[butui] stream 已经 flush，不能再 push");
      stream.push(delta);
      sync();
    },
    flush() {
      if (flushed) return;
      stream.flush();
      flushed = true;
      sync();
      tailText = "";
      for (const listener of [...listeners]) listener();
    },
  };
}
