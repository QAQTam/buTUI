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
 * ANSI 切片交给 `Bun.sliceAnsi`，CJK / emoji 不会被劈开；已定稿行只追加，
 * volatile tail 可以随 source 重写，但不会破坏已经显示的前缀。
 */
import { AnimationScheduler, prefersReducedMotion } from "@butui/solid";
import { createSignal } from "solid-js";
import type { StreamLine, StreamSource } from "./source.ts";

/** 所有 smooth stream 共享一个 60fps 时钟，避免每个流各起一个 timer。 */
const smoothScheduler = new AnimationScheduler({ fps: 60 });
const EPSILON = 1e-6;

export interface SmoothStreamOptions {
  /**
   * 基础显现速度，单位是终端列 / 秒。默认 160。
   *
   * CJK / emoji 按 `Bun.stringWidth` 计宽，例如一个中文汉字算 2 列。
   */
  speed?: number;
  /** 当前积压在这个时间内追平；默认 180ms。越大越柔和，越小越跟手。 */
  catchUpMs?: number;
  /** 单帧最多推进多少列，默认 256；防止超大 backlog 一帧跳完整段。 */
  maxColumnsPerFrame?: number;
  /** false 时直接显示 target，不做 reveal 动画。 */
  enabled?: boolean;
  /** 测试 / 嵌入方覆盖 reduced-motion 环境检测。 */
  reducedMotion?: boolean;
  /** 测试 / 嵌入方注入时钟。 */
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
  const maxColumnsPerFrame = Math.max(1, options.maxColumnsPerFrame ?? 256);
  const scheduler = options.scheduler ?? smoothScheduler;
  const enabled =
    options.enabled !== false &&
    !(options.reducedMotion ?? prefersReducedMotion());

  const revealedLines: StreamLine[] = [];
  const [version, setVersion] = createSignal(0);
  const listeners = new Set<() => void>();
  const committedWidths: number[] = [];
  let committedTotalWidth = 0;
  let knownCommitted = 0;
  let revealedWidth = 0;
  let tailLines: string[] = [];
  let tailWidths: number[] = [];
  let cursorLine = 0;
  let cursorColumns = 0;
  let currentTail = "";
  let currentRate = speed;
  let lastTickAt: number | undefined;
  let stopTick: (() => void) | undefined;
  let stopSource: (() => void) | undefined;
  let disposed = false;

  const widthOf = (text: string): number => Bun.stringWidth(text);

  const syncCommitted = (): void => {
    for (let i = knownCommitted; i < source.lines.length; i++) {
      const width = widthOf(source.lines[i]!.text);
      committedWidths.push(width);
      committedTotalWidth += width;
    }
    knownCommitted = source.lines.length;
  };

  const pushCommittedLine = (index: number): void => {
    const line = source.lines[index];
    if (!line || revealedLines.length !== index) return;
    revealedLines.push(line);
    revealedWidth += committedWidths[index] ?? widthOf(line.text);
  };

  const targetWidth = (): number => {
    let total = committedTotalWidth;
    for (const width of tailWidths) total += width;
    return total;
  };

  const shownWidth = (): number => {
    let total = revealedWidth;
    if (cursorLine < source.lines.length) return total + cursorColumns;

    const tailIndex = cursorLine - source.lines.length;
    const fullTail = Math.min(tailIndex, tailLines.length);
    for (let i = 0; i < fullTail; i++) total += tailWidths[i] ?? 0;
    if (tailIndex < tailLines.length) total += cursorColumns;
    return total;
  };

  const lineWidth = (index: number): number => {
    if (index < source.lines.length) return committedWidths[index] ?? 0;
    return tailWidths[index - source.lines.length] ?? 0;
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
    tailLines = source.tail() === "" ? [] : source.tail().split("\n");
    tailWidths = tailLines.map(widthOf);

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
      const width = committedWidths[cursorLine] ?? 0;
      if (cursorColumns + EPSILON < width) break;
      pushCommittedLine(cursorLine);
      cursorLine++;
      cursorColumns = 0;
    }

    if (cursorLine < source.lines.length) {
      cursorColumns = Math.min(
        cursorColumns,
        committedWidths[cursorLine] ?? 0
      );
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

  const renderView = (force = false): void => {
    const nextTail = renderTail();
    if (!force && nextTail === currentTail) return;
    currentTail = nextTail;
    setVersion(v => v + 1);
    for (const listener of [...listeners]) listener();
  };

  const advance = (columns: number): void => {
    let remaining = columns;
    syncTarget();

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

    renderView(true);
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

    const frameScale = dt / (1000 / 60);
    const step = Math.min(
      lag,
      (currentRate * dt) / 1000,
      maxColumnsPerFrame * frameScale
    );
    if (step <= EPSILON) return;
    advance(step);
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
    },
  };
}
