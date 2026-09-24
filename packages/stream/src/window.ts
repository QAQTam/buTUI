/**
 * StreamLedger stable-line 窗口适配器。
 *
 * `<stream>` 节点仍然只消费一个 `StreamSource`；这个 source 不持有完整
 * transcript，而是只保留当前视口窗口。调用方负责 scroll offset，窗口内容由
 * `readWindow()` 从 stable hot / spilled lines 与 volatile tail 混合读取。
 */
import { createSignal } from "solid-js";
import type {
  FrameClock,
  FrameRequestHandle,
} from "@butui/core";
import type {
  StreamId,
  StreamLedger,
  StreamLineRecord,
  StreamLineWindow,
} from "./ledger.ts";
import type { StreamLine, StreamSource } from "./source.ts";

export interface StreamWindowOptions {
  ledger: StreamLedger;
  streamId: StreamId;
  initialOffset?: number;
  /** 最多缓存多少个窗口；0 表示关闭，默认 8。 */
  cacheSize?: number;
}

export interface StreamWindowSource extends StreamSource {
  offset(): number;
  totalLines(): number;
  revision(): number;
  loading(): boolean;
  load(offset: number, count: number): Promise<StreamLineWindow>;
  /** 读取并缓存窗口，但不改变当前显示内容。 */
  prefetch(offset: number, count: number): Promise<StreamLineWindow>;
  refresh(): Promise<StreamLineWindow | undefined>;
}

export interface StreamWindowControllerOptions extends StreamWindowOptions {
  /** 视口高度；默认 20。 */
  height?: number;
  /** 上下各预取多少页；默认 1。 */
  prefetchPages?: number;
  /** 新 revision 到达时保持贴底；默认 false。 */
  follow?: boolean;
  /** 注入后把连续滚动合并到帧；不传时请求立即排队执行。 */
  clock?: FrameClock;
}

export interface StreamWindowController {
  readonly source: StreamWindowSource;
  height(): number;
  setHeight(height: number): Promise<StreamLineWindow>;
  offset(): number;
  totalLines(): number;
  atTop(): boolean;
  atBottom(): boolean;
  load(): Promise<StreamLineWindow>;
  /** 刷新当前窗口；follow=true 时重新贴底。 */
  refresh(): Promise<StreamLineWindow | undefined>;
  scrollTo(offset: number): Promise<StreamLineWindow>;
  scrollBy(delta: number): Promise<StreamLineWindow>;
  pageBy(pages: number): Promise<StreamLineWindow>;
  /** 请求滚动；注入 FrameClock 时同一帧只提交最新 offset。 */
  requestScrollTo(offset: number): void;
  requestScrollBy(delta: number): void;
  /** 等待最近一次已提交的 requestScroll* 完成。 */
  flushRequestedScroll(): Promise<void>;
  flushPrefetch(): Promise<void>;
}

export function createStreamWindow(
  options: StreamWindowOptions
): StreamWindowSource {
  const { ledger, streamId } = options;
  let currentLines: StreamLine[] = [];
  let currentOffset = Math.max(0, Math.floor(options.initialOffset ?? 0));
  let currentTotal = lineCount(ledger.project(streamId));
  let currentRevision = ledger.project(streamId).revision;
  let lastCount = 0;
  let generation = 0;
  const cacheSize = Math.max(0, Math.floor(options.cacheSize ?? 8));
  const cache = new Map<string, StreamLineWindow>();
  const listeners = new Set<() => void>();
  const [version, setVersion] = createSignal(0);
  const [loading, setLoading] = createSignal(false);

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const applyWindow = (window: StreamLineWindow): void => {
    currentLines = window.lines.map((line, index) => ({
      id: window.offset + index + 1,
      text: line.text,
      stable: line.volatile !== true,
    }));
    currentOffset = window.offset;
    currentTotal = window.totalLines;
    currentRevision = window.revision;
  };

  const cacheKey = (
    offset: number,
    count: number,
    revision = ledger.project(streamId).revision
  ): string => {
    return `${revision}\u0000${offset}\u0000${count}`;
  };

  const cacheWindow = (key: string, window: StreamLineWindow): void => {
    if (cacheSize === 0) return;
    cache.delete(key);
    cache.set(key, window);
    while (cache.size > cacheSize) {
      cache.delete(cache.keys().next().value!);
    }
  };

  const findCachedWindow = (
    offset: number,
    count: number,
    revision: number
  ): StreamLineWindow | undefined => {
    for (const window of cache.values()) {
      if (window.revision !== revision) continue;
      const start = clampWindowIndex(offset, window.totalLines);
      const end = Math.min(window.totalLines, start + Math.max(0, Math.floor(count)));
      const cachedEnd = window.offset + window.lines.length;
      if (start < window.offset || end > cachedEnd) continue;

      const lines = window.lines.slice(
        start - window.offset,
        end - window.offset
      );
      return {
        streamId: window.streamId,
        revision: window.revision,
        offset: start,
        totalLines: window.totalLines,
        lines,
      };
    }
    return undefined;
  };

  const readWindow = async (
    offset: number,
    count: number
  ): Promise<StreamLineWindow> => {
    const revision = ledger.project(streamId).revision;
    const cached = findCachedWindow(offset, count, revision);
    if (cached) return cached;

    const window = await ledger.readWindow(streamId, offset, count);
    cacheWindow(
      cacheKey(window.offset, window.lines.length, window.revision),
      window
    );
    return window;
  };

  const loadWindow = async (
    offset: number,
    count: number,
    bypassCache: boolean
  ): Promise<StreamLineWindow> => {
    const request = ++generation;
    lastCount = Math.max(0, Math.floor(count));
    const cached = bypassCache
      ? undefined
      : findCachedWindow(offset, count, ledger.project(streamId).revision);
    if (cached) {
      applyWindow(cached);
      setLoading(false);
      setVersion(value => value + 1);
      notify();
      return cached;
    }

    setLoading(true);
    let committed = false;
    try {
      const window = await ledger.readWindow(streamId, offset, count);
      if (request !== generation) return window;

      applyWindow(window);
      cacheWindow(
        cacheKey(window.offset, window.lines.length, window.revision),
        window
      );
      committed = true;
      return window;
    } finally {
      if (request === generation) {
        setLoading(false);
        setVersion(value => value + 1);
        if (committed) notify();
      }
    }
  };

  const load = (
    offset: number,
    count: number
  ): Promise<StreamLineWindow> => loadWindow(offset, count, false);

  return {
    get lines() {
      return currentLines;
    },
    tail: () => "",
    version,
    push() {
      throw new Error("[butui] stream window 是只读 source");
    },
    flush() {
      throw new Error("[butui] stream window 是只读 source");
    },
    get frozen() {
      return currentLines.length;
    },
    get stats() {
      return {
        offset: currentOffset,
        totalLines: currentTotal,
        loadedLines: currentLines.length,
        revision: currentRevision,
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    offset: () => currentOffset,
    totalLines: () => currentTotal,
    revision: () => currentRevision,
    loading,
    load,
    prefetch: readWindow,
    refresh() {
      if (lastCount === 0) return Promise.resolve(undefined);
      return loadWindow(currentOffset, lastCount, true);
    },
  };
}

export function createStreamWindowController(
  options: StreamWindowControllerOptions
): StreamWindowController {
  const source = createStreamWindow(options);
  const clock = options.clock;
  const follow = options.follow ?? false;
  let height = Math.max(0, Math.floor(options.height ?? 20));
  const prefetchPages = Math.max(0, Math.floor(options.prefetchPages ?? 1));
  let pendingPrefetch: Promise<void> = Promise.resolve();
  let pendingScroll: Promise<void> = Promise.resolve();
  let requestedOffset: number | undefined;
  let requestHandle: FrameRequestHandle | undefined;
  let requestRevision = 0;

  const maxOffset = (): number => Math.max(0, source.totalLines() - height);
  const clampOffset = (offset: number): number =>
    Math.min(maxOffset(), Math.max(0, Math.floor(offset)));
  const cancelRequestedScroll = (): void => {
    requestHandle?.cancel();
    requestHandle = undefined;
    requestedOffset = undefined;
  };
  const enqueueScroll = (target: number): void => {
    pendingScroll = pendingScroll.then(() => scrollTo(target)).then(() => undefined);
  };

  const schedulePrefetch = (window: StreamLineWindow): void => {
    if (height === 0 || prefetchPages === 0) return;
    const page = Math.floor(window.offset / height);
    const start = Math.max(0, (page - prefetchPages) * height);
    const end = Math.min(
      window.totalLines,
      (page + prefetchPages + 1) * height
    );
    if (end <= start) return;

    const run = source.prefetch(start, end - start).then(() => undefined);
    pendingPrefetch = pendingPrefetch.then(() => run);
  };

  const loadVisible = async (): Promise<StreamLineWindow> => {
    cancelRequestedScroll();
    const offset = clampOffset(source.offset());
    const window = await source.load(offset, height);
    schedulePrefetch(window);
    return window;
  };

  const scrollTo = async (offset: number): Promise<StreamLineWindow> => {
    const target = clampOffset(offset);
    const window = await source.load(target, height);
    schedulePrefetch(window);
    return window;
  };

  const refresh = async (): Promise<StreamLineWindow | undefined> => {
    if (!follow) {
      const window = await source.refresh();
      if (window) schedulePrefetch(window);
      return window;
    }
    const total = lineCount(options.ledger.project(options.streamId));
    const window = await source.load(Math.max(0, total - height), height);
    schedulePrefetch(window);
    return window;
  };

  const requestScrollTo = (offset: number): void => {
    requestedOffset = clampOffset(offset);
    if (!clock) {
      const target = requestedOffset;
      requestedOffset = undefined;
      enqueueScroll(target);
      return;
    }

    requestHandle = clock.request({
      lane: "critical",
      reason: "stream-window-scroll",
      sessionRevision: ++requestRevision,
      coalesceKey: `stream-window:${options.streamId}`,
      work: () => {
        requestHandle = undefined;
        const target = requestedOffset;
        requestedOffset = undefined;
        if (target !== undefined) enqueueScroll(target);
      },
    });
  };

  return {
    source,
    height: () => height,
    async setHeight(nextHeight) {
      height = Math.max(0, Math.floor(nextHeight));
      return loadVisible();
    },
    offset: () => source.offset(),
    totalLines: () => source.totalLines(),
    atTop: () => source.offset() === 0,
    atBottom: () => source.offset() >= maxOffset(),
    load: loadVisible,
    refresh,
    scrollTo: async offset => {
      cancelRequestedScroll();
      return scrollTo(offset);
    },
    scrollBy: async delta => {
      cancelRequestedScroll();
      return scrollTo(source.offset() + delta);
    },
    pageBy: async pages => {
      cancelRequestedScroll();
      return scrollTo(source.offset() + pages * height);
    },
    requestScrollTo,
    requestScrollBy(delta) {
      requestScrollTo((requestedOffset ?? source.offset()) + delta);
    },
    async flushRequestedScroll() {
      if (requestHandle) {
        requestHandle.cancel();
        requestHandle = undefined;
        const target = requestedOffset;
        requestedOffset = undefined;
        if (target !== undefined) enqueueScroll(target);
      }
      await pendingScroll;
    },
    async flushPrefetch() {
      await pendingPrefetch;
    },
  };
}

function lineCount(projection: {
  stableLines: readonly StreamLineRecord[];
  spilledSegments: readonly { count: number }[];
  volatileTail: readonly { id: string; text: string }[];
}): number {
  return (
    projection.stableLines.length +
    projection.spilledSegments.reduce((sum, segment) => sum + segment.count, 0) +
    projection.volatileTail.length
  );
}

function clampWindowIndex(value: number, total: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(total, Math.max(0, Math.floor(value)));
}
