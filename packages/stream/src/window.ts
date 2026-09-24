/**
 * StreamLedger stable-line 窗口适配器。
 *
 * `<stream>` 节点仍然只消费一个 `StreamSource`；这个 source 不持有完整
 * transcript，而是只保留当前视口窗口。调用方负责 scroll offset，窗口内容由
 * `readStableRange()` 从 hot / spilled lines 混合读取。
 */
import { createSignal } from "solid-js";
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
}

export interface StreamWindowSource extends StreamSource {
  offset(): number;
  totalLines(): number;
  revision(): number;
  loading(): boolean;
  load(offset: number, count: number): Promise<StreamLineWindow>;
  refresh(): Promise<StreamLineWindow | undefined>;
}

export function createStreamWindow(
  options: StreamWindowOptions
): StreamWindowSource {
  const { ledger, streamId } = options;
  let currentLines: StreamLine[] = [];
  let currentOffset = Math.max(0, Math.floor(options.initialOffset ?? 0));
  let currentTotal = stableLineCount(ledger.project(streamId));
  let currentRevision = ledger.project(streamId).revision;
  let lastCount = 0;
  let generation = 0;
  const listeners = new Set<() => void>();
  const [version, setVersion] = createSignal(0);
  const [loading, setLoading] = createSignal(false);

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const load = async (
    offset: number,
    count: number
  ): Promise<StreamLineWindow> => {
    const request = ++generation;
    lastCount = Math.max(0, Math.floor(count));
    setLoading(true);
    let committed = false;
    try {
      const window = await ledger.readStableRange(streamId, offset, count);
      if (request !== generation) return window;

      currentLines = window.lines.map((line, index) => ({
        id: window.offset + index + 1,
        text: line.text,
        stable: true,
      }));
      currentOffset = window.offset;
      currentTotal = window.totalLines;
      currentRevision = window.revision;
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
    refresh() {
      if (lastCount === 0) return Promise.resolve(undefined);
      return load(currentOffset, lastCount);
    },
  };
}

function stableLineCount(projection: {
  stableLines: readonly StreamLineRecord[];
  spilledSegments: readonly { count: number }[];
}): number {
  return (
    projection.stableLines.length +
    projection.spilledSegments.reduce((sum, segment) => sum + segment.count, 0)
  );
}
