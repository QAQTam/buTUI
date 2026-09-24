/**
 * 平滑显现 —— 把 chunk 的到达速度与终端的视觉推进速度解耦。
 *
 * 高频模型输出常见两种极端：
 *
 *   1. token 很碎，但每个 chunk 一到就把内容整块画出来，像“喷”；
 *   2. 2000 tok/s 时如果每帧只推进很少字符，又会无限落后。
 *
 * `createSmoothStream()` 用 reveal cursor 解决：target 可以瞬时增长，但每帧只
 * 推进 `speed` 列；积压变大时按 `catchUpMs` 在有限时间内加速追平。追赶仍然按
 * 帧推进，不会一次性把 backlog 全部刷到屏幕上。
 *
 * 默认 120fps。高频时钟只有“有积压”时才订阅，target 没变时不重建 tail，cursor
 * 没跨过可见列时不触发 Solid / layout，避免把 120fps 变成 120 次无效重绘。
 *
 * ANSI 切片交给 `Bun.sliceAnsi`，CJK / emoji 不会被劈开；已定稿行只追加，
 * volatile tail 可以随 source 重写，但不会破坏已经显示的前缀。
 */
import { FrameClock } from "@butui/core";
import { AnimationScheduler, prefersReducedMotion } from "@butui/solid";
import { createSignal } from "solid-js";
import type { StreamLine, StreamSource } from "./source.ts";

export const DEFAULT_SMOOTH_FPS = 120;

const defaultSmoothClock = new FrameClock({ fps: DEFAULT_SMOOTH_FPS });
const smoothSchedulers = new WeakMap<FrameClock, Map<number, AnimationScheduler>>();
const EPSILON = 1e-6;

function schedulerForFps(fps: number, clock = defaultSmoothClock): AnimationScheduler {
  const normalized = Math.max(1, Math.min(240, Math.round(fps)));
  let schedulers = smoothSchedulers.get(clock);
  if (!schedulers) {
    schedulers = new Map();
    smoothSchedulers.set(clock, schedulers);
  }

  let scheduler = schedulers.get(normalized);
  if (!scheduler) {
    scheduler = new AnimationScheduler({
      fps: normalized,
      clock,
      lane: "reveal",
      coalesceKey: `smooth:${normalized}`,
    });
    schedulers.set(normalized, scheduler);
  }
  return scheduler;
}

export interface SmoothStreamOptions {
  /** 目标刷新率，默认 120；同一 fps 的所有流共享一个 timer。 */
  fps?: number;
  /**
   * 基础显现速度，单位是终端列 / 秒。默认 160。
   *
   * CJK / emoji 按 `Bun.stringWidth` 计宽，例如一个中文汉字算 2 列。
   */
  speed?: number;
  /** 当前积压在这个时间内追平；默认 180ms。越大越柔和，越小越跟手。 */
  catchUpMs?: number;
  /** 单帧最多推进多少列，默认 128；防止超大 backlog 一帧跳完整段。 */
  maxColumnsPerFrame?: number;
  /** false 时直接显示 target，不做 reveal 动画。 */
  enabled?: boolean;
  /** 测试 / 嵌入方覆盖 reduced-motion 环境检测。 */
  reducedMotion?: boolean;
  /** runtime 共享 FrameClock；不传时使用模块内默认 clock。 */
  clock?: FrameClock;
  /** 测试 / 嵌入方注入调度器；给定时忽略 fps / clock。 */
  scheduler?: AnimationScheduler;
}

export interface SmoothStream extends StreamSource {
  /** 距离 target 还有多少列没有显示。 */
  lag(): number;
  /** 跳过剩余动画，立刻显示当前 target。 */
  finish(): void;
  /** 退订 source / 时钟；组件卸载时调用。 */
  dispose(): void;
}

export function createSmoothStream(
  source: StreamSource,
  options: SmoothStreamOptions = {}
): SmoothStream {
  const speed = Math.max(1, options.speed ?? 160);
  const catchUpMs = Math.max(16, options.catchUpMs ?? 180);
  const maxColumnsPerFrame = Math.max(1, options.maxColumnsPerFrame ?? 128);
  const fps = Math.max(1, Math.min(240, options.fps ?? DEFAULT_SMOOTH_FPS));
  const scheduler = options.scheduler ?? schedulerForFps(fps, options.clock);
  const enabled =
    options.enabled !== false &&
    !(options.reducedMotion ?? prefersReducedMotion());

  const revealedLines: StreamLine[] = [];
  const [version, setVersion] = createSignal(0);
  const listeners = new Set<() => void>();
  const pendingWidths = new Map<number, number>();
  let committedTotalWidth = 0;
  let knownCommitted = 0;
  let revealedWidth = 0;
  let tailSource = "";
  let tailLines: string[] = [];
  let tailWidths: number[] = [];
  let tailPrefixWidths: number[] = [];
  let tailTotalWidth = 0;
  let tailDirty = true;
  let tailRevision = 0;
  let cursorLine = 0;
  let cursorColumns = 0;
  let currentTail = "";
  let renderedLineCount = 0;
  let renderedCursorLine = -1;
  let renderedCursorColumns = -1;
  let renderedTailRevision = -1;
  let currentRate = speed;
  let lastTickAt: number | undefined;
  let stopTick: (() => void) | undefined;
  let stopSource: (() => void) | undefined;
  let disposed = false;
  let tickCount = 0;
  let skippedTickCount = 0;
  let renderCount = 0;

  const widthOf = (text: string): number => Bun.stringWidth(text);

  const syncCommitted = (): void => {
    for (let i = knownCommitted; i < source.lines.length; i++) {
      const width = widthOf(source.lines[i]!.text);
      pendingWidths.set(i, width);
      committedTotalWidth += width;
    }
    knownCommitted = source.lines.length;
  };

  const pushCommittedLine = (index: number): void => {
    const line = source.lines[index];
    if (!line || revealedLines.length !== index) return;
    revealedLines.push(line);
    revealedWidth += lineWidth(index);
    pendingWidths.delete(index);
  };

  const lineWidth = (index: number): number => {
    if (index < source.lines.length) {
      const cached = pendingWidths.get(index);
      if (cached !== undefined) return cached;
      const width = widthOf(source.lines[index]!.text);
      pendingWidths.set(index, width);
      return width;
    }
    return tailWidths[index - source.lines.length] ?? 0;
  };

  const targetWidth = (): number => committedTotalWidth + tailTotalWidth;

  const shownWidth = (): number => {
    if (cursorLine < source.lines.length) {
      return revealedWidth + cursorColumns;
    }

    const tailIndex = cursorLine - source.lines.length;
    if (tailIndex >= tailLines.length) {
      return revealedWidth + tailTotalWidth;
    }
    return revealedWidth + (tailPrefixWidths[tailIndex] ?? 0) + cursorColumns;
  };

  const totalLines = (): number => source.lines.length + tailLines.length;

  /**
   * 对齐 source 的当前状态。
   *
   * `lines` 只追加快照；tail 是 volatile，所以每帧重新读。cursor 超出新 tail
   * 时会夹回末尾，而不是显示已经不存在的内容。
   */
  const syncTarget = (): void => {
    syncCommitted();
    if (tailDirty) {
      const nextTail = source.tail();
      if (nextTail !== tailSource) {
        tailSource = nextTail;
        tailLines = nextTail === "" ? [] : nextTail.split("\n");
        tailWidths = tailLines.map(widthOf);
        tailPrefixWidths = new Array(tailWidths.length);
        tailTotalWidth = 0;
        for (let i = 0; i < tailWidths.length; i++) {
          tailPrefixWidths[i] = tailTotalWidth;
          tailTotalWidth += tailWidths[i] ?? 0;
        }
        tailRevision++;
      }
      tailDirty = false;
    }

    const total = totalLines();
    if (cursorLine > total) {
      cursorLine = total > 0 ? total - 1 : 0;
      cursorColumns = total > 0 ? lineWidth(cursorLine) : 0;
    }

    const shouldRevealCommitted =
      cursorLine >= source.lines.length
        ? source.lines.length
        : cursorLine;
    while (revealedLines.length < shouldRevealCommitted) {
      pushCommittedLine(revealedLines.length);
    }

    while (cursorLine < source.lines.length) {
      const width = lineWidth(cursorLine);
      if (cursorColumns + EPSILON < width) break;
      pushCommittedLine(cursorLine);
      cursorLine++;
      cursorColumns = 0;
    }

    if (cursorLine < source.lines.length) {
      cursorColumns = Math.min(cursorColumns, lineWidth(cursorLine));
    } else if (cursorLine < total) {
      cursorColumns = Math.min(
        cursorColumns,
        tailWidths[cursorLine - source.lines.length] ?? 0
      );
    } else {
      cursorColumns = 0;
    }
  };

  const renderTail = (): string => {
    if (cursorLine < source.lines.length) {
      const columns = Math.floor(cursorColumns);
      if (columns <= 0) return "";
      return Bun.sliceAnsi(source.lines[cursorLine]!.text, 0, columns);
    }

    const tailIndex = cursorLine - source.lines.length;
    if (tailIndex <= 0 && cursorColumns <= 0) return "";

    const parts: string[] = [];
    const fullTail = Math.min(tailIndex, tailLines.length);
    for (let i = 0; i < fullTail; i++) parts.push(tailLines[i]!);
    if (tailIndex < tailLines.length) {
      parts.push(
        Bun.sliceAnsi(tailLines[tailIndex]!, 0, Math.floor(cursorColumns))
      );
    }
    return parts.join("\n");
  };

  const renderView = (force = false): boolean => {
    const visibleColumns = Math.floor(cursorColumns);
    const lineCountChanged = revealedLines.length !== renderedLineCount;
    const cursorChanged =
      cursorLine !== renderedCursorLine ||
      visibleColumns !== renderedCursorColumns;
    const tailChanged = tailRevision !== renderedTailRevision;

    if (!force && !lineCountChanged && !cursorChanged && !tailChanged) {
      return false;
    }

    const nextTail = renderTail();
    renderedLineCount = revealedLines.length;
    renderedCursorLine = cursorLine;
    renderedCursorColumns = visibleColumns;
    renderedTailRevision = tailRevision;

    // tail 的 ANSI / 文本可能被 source 重写，但可见 prefix 恰好相同；
    // 没有结构变化时不必触发 Solid。
    if (!force && !lineCountChanged && nextTail === currentTail) {
      return false;
    }

    currentTail = nextTail;
    renderCount++;
    setVersion(v => v + 1);
    for (const listener of [...listeners]) listener();
    return true;
  };

  const advance = (columns: number): boolean => {
    let remaining = columns;

    while (remaining > EPSILON) {
      const total = totalLines();
      if (cursorLine >= total) break;

      const width = lineWidth(cursorLine);
      if (cursorColumns + EPSILON >= width) {
        if (cursorLine < source.lines.length) {
          pushCommittedLine(cursorLine);
          cursorLine++;
          cursorColumns = 0;
          continue;
        }
        if (cursorLine + 1 < total) {
          cursorLine++;
          cursorColumns = 0;
          continue;
        }
        break;
      }

      const take = Math.min(remaining, width - cursorColumns);
      cursorColumns += take;
      remaining -= take;

      if (cursorColumns + EPSILON >= width) {
        if (cursorLine < source.lines.length) {
          pushCommittedLine(cursorLine);
          cursorLine++;
          cursorColumns = 0;
        } else if (cursorLine + 1 < total) {
          cursorLine++;
          cursorColumns = 0;
        }
      }
    }

    return renderView(false);
  };

  const revealAll = (): void => {
    syncTarget();
    while (cursorLine < source.lines.length) {
      pushCommittedLine(cursorLine);
      cursorLine++;
      cursorColumns = 0;
    }

    const total = totalLines();
    if (total === 0) {
      cursorLine = 0;
      cursorColumns = 0;
    } else {
      const last = total - 1;
      if (last < source.lines.length) {
        while (cursorLine < source.lines.length) {
          pushCommittedLine(cursorLine);
          cursorLine++;
        }
        cursorColumns = 0;
      } else {
        cursorLine = last;
        cursorColumns = lineWidth(last);
      }
    }

    currentRate = speed;
    renderView(true);
  };

  const stopAnimation = (): void => {
    stopTick?.();
    stopTick = undefined;
    lastTickAt = undefined;
  };

  const tick = (time: number): void => {
    if (disposed) return;
    tickCount++;
    if (!enabled) {
      revealAll();
      stopAnimation();
      return;
    }

    syncTarget();
    const lag = Math.max(0, targetWidth() - shownWidth());
    if (lag <= EPSILON) {
      renderView(false);
      stopAnimation();
      return;
    }

    if (lastTickAt === undefined) {
      lastTickAt = time;
      return;
    }

    const dt = Math.min(100, Math.max(0, time - lastTickAt));
    lastTickAt = time;
    if (dt <= 0) return;

    const catchUpRate = lag / (catchUpMs / 1000);
    const targetRate = Math.max(speed, catchUpRate);
    const blend = 1 - Math.exp(-dt / 80);
    currentRate += (targetRate - currentRate) * blend;

    const frameScale = dt / (1000 / fps);
    const step = Math.min(
      lag,
      (currentRate * dt) / 1000,
      maxColumnsPerFrame * frameScale
    );
    if (step <= EPSILON || !advance(step)) {
      skippedTickCount++;
    }
  };

  const ensureAnimation = (): void => {
    if (!enabled || disposed || stopTick) return;
    syncTarget();
    if (targetWidth() - shownWidth() <= EPSILON) {
      renderView(false);
      return;
    }
    lastTickAt = undefined;
    currentRate = speed;
    stopTick = scheduler.subscribe(tick);
  };

  const onSourceChange = (): void => {
    if (disposed) return;
    tailDirty = true;
    if (!enabled) {
      revealAll();
      return;
    }
    syncTarget();
    renderView(false);
    ensureAnimation();
  };

  // 已有历史直接显示；只有挂载之后新到达的内容才做 reveal。
  revealAll();
  const sourceHasChange = typeof source.onChange === "function";
  stopSource = source.onChange?.(onSourceChange);

  return {
    lines: revealedLines,
    tail: () => currentTail,
    version,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(delta) {
      source.push(delta);
      if (!sourceHasChange) onSourceChange();
    },
    flush() {
      source.flush();
      if (!sourceHasChange) onSourceChange();
    },
    get frozen() {
      return revealedLines.length;
    },
    get stats() {
      return {
        ...source.stats,
        revealLag: Math.max(0, targetWidth() - shownWidth()),
        revealLines: revealedLines.length,
        revealPendingWidths: pendingWidths.size,
        smoothTicks: tickCount,
        smoothSkippedTicks: skippedTickCount,
        smoothRenders: renderCount,
      };
    },
    lag() {
      syncTarget();
      return Math.max(0, targetWidth() - shownWidth());
    },
    finish() {
      revealAll();
      stopAnimation();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopAnimation();
      stopSource?.();
      stopSource = undefined;
      listeners.clear();
      pendingWidths.clear();
    },
  };
}
