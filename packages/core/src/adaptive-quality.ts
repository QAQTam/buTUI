/**
 * AdaptiveQuality —— v0.2 帧预算控制器。
 *
 * 设计目标是“输入优先，装饰可降级”：
 *   - 超预算时先降质量，而不是中断 critical 工作；
 *   - 升档必须比降档慢，避免在阈值附近振荡；
 *   - 所有采样都是确定性的，fake clock / replay 不依赖真实 wall-clock。
 */

export const QUALITY_ORDER = ["minimal", "responsive", "balanced", "full"] as const;
export type QualityLevel = (typeof QUALITY_ORDER)[number];

export const QUALITY_BUDGET_MS: Record<QualityLevel, number> = {
  full: 6,
  balanced: 12,
  responsive: 8,
  minimal: 4,
};

export interface QualitySignals {
  computeP95Ms: number;
  presentedIntervalP95Ms: number;
  blockedRatio: number;
  eventLoopDelayP95Ms: number;
  inputLatencyP95Ms: number;
  skippedFrameCount: number;
}

export interface AdaptiveQualityOptions {
  /** 初始档位，默认 full。 */
  initial?: QualityLevel;
  /** 最低档位，默认 minimal。 */
  min?: QualityLevel;
  /** 最高档位，默认 initial。 */
  max?: QualityLevel;
  /** 目标帧间隔，默认 1000 / 120。 */
  targetIntervalMs?: number;
  /** 连续坏样本阈值，默认 30。 */
  downgradeAfter?: number;
  /** 连续好样本达到这个时长才升档，默认 2000ms。 */
  upgradeAfterMs?: number;
  /** compute / presented / skipped 窗口，默认 120。 */
  sampleWindow?: number;
  /** input latency 窗口，默认 100。 */
  latencyWindow?: number;
  /** blocked ratio 统计窗口，默认 1000ms。 */
  blockedWindowMs?: number;
}

export interface DispatchQualitySample {
  at: number;
  computeMs: number;
  budgetMs: number;
  skipped: number;
}

interface BlockedEvent {
  start: number;
  end?: number;
}

const QUALITY_INDEX: Record<QualityLevel, number> = {
  minimal: 0,
  responsive: 1,
  balanced: 2,
  full: 3,
};

function qualityAt(index: number): QualityLevel {
  return QUALITY_ORDER[Math.max(0, Math.min(QUALITY_ORDER.length - 1, index))]!;
}

function clampQuality(
  value: QualityLevel,
  min: QualityLevel,
  max: QualityLevel
): QualityLevel {
  const index = Math.max(QUALITY_INDEX[min], Math.min(QUALITY_INDEX[max], QUALITY_INDEX[value]));
  return qualityAt(index);
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

export class AdaptiveQuality {
  private readonly min: QualityLevel;
  private readonly max: QualityLevel;
  private readonly targetIntervalMs: number;
  private readonly downgradeAfter: number;
  private readonly upgradeAfterMs: number;
  private readonly sampleWindow: number;
  private readonly latencyWindow: number;
  private readonly blockedWindowMs: number;

  private quality: QualityLevel;
  private computeRatios: number[] = [];
  private presentedIntervals: number[] = [];
  private skippedSamples: number[] = [];
  private inputLatencies: number[] = [];
  private blockedEvents: BlockedEvent[] = [];
  private blockedStartedAt: number | undefined;
  private lastPresentedAt: number | undefined;
  private badStreak = 0;
  private goodSince: number | undefined;
  private lastAt = 0;

  constructor(options: AdaptiveQualityOptions = {}) {
    const initial = options.initial ?? "full";
    this.min = options.min ?? "minimal";
    this.max = options.max ?? initial;
    this.quality = clampQuality(initial, this.min, this.max);
    this.targetIntervalMs = Math.max(1, options.targetIntervalMs ?? 1000 / 120);
    this.downgradeAfter = Math.max(1, Math.floor(options.downgradeAfter ?? 30));
    this.upgradeAfterMs = Math.max(1, options.upgradeAfterMs ?? 2000);
    this.sampleWindow = Math.max(1, Math.floor(options.sampleWindow ?? 120));
    this.latencyWindow = Math.max(1, Math.floor(options.latencyWindow ?? 100));
    this.blockedWindowMs = Math.max(1, options.blockedWindowMs ?? 1000);
  }

  current(): QualityLevel {
    return this.quality;
  }

  setQuality(quality: QualityLevel): QualityLevel {
    this.quality = clampQuality(quality, this.min, this.max);
    this.badStreak = 0;
    this.goodSince = undefined;
    return this.quality;
  }

  recordDispatch(sample: DispatchQualitySample): QualityLevel {
    this.lastAt = sample.at;
    pushWindow(this.computeRatios, sample.computeMs / Math.max(0.001, sample.budgetMs), this.sampleWindow);
    pushWindow(this.skippedSamples, sample.skipped, this.sampleWindow);
    return this.evaluate(sample.at);
  }

  recordPresented(at: number): QualityLevel {
    this.lastAt = at;
    if (this.lastPresentedAt !== undefined && at > this.lastPresentedAt) {
      pushWindow(this.presentedIntervals, at - this.lastPresentedAt, this.sampleWindow);
    }
    this.lastPresentedAt = at;
    return this.evaluate(at);
  }

  recordInputLatency(at: number, latencyMs: number): QualityLevel {
    this.lastAt = at;
    pushWindow(this.inputLatencies, Math.max(0, latencyMs), this.latencyWindow);
    return this.evaluate(at);
  }

  recordBlocked(at: number): QualityLevel {
    this.lastAt = at;
    if (this.blockedStartedAt === undefined) this.blockedStartedAt = at;
    return this.evaluate(at);
  }

  recordDrained(at: number): QualityLevel {
    this.lastAt = at;
    if (this.blockedStartedAt !== undefined) {
      this.blockedEvents.push({ start: this.blockedStartedAt, end: at });
      this.blockedStartedAt = undefined;
    }
    this.pruneBlocked(at);
    return this.evaluate(at);
  }

  signals(at = this.lastAt): QualitySignals {
    return {
      computeP95Ms: p95(this.computeRatios) * this.budgetForQuality(),
      presentedIntervalP95Ms: p95(this.presentedIntervals),
      blockedRatio: this.blockedRatio(at),
      eventLoopDelayP95Ms: 0,
      inputLatencyP95Ms: p95(this.inputLatencies),
      skippedFrameCount: this.skippedSamples.reduce((sum, value) => sum + value, 0),
    };
  }

  private evaluate(at: number): QualityLevel {
    const signals = this.signals(at);
    const bad =
      signals.computeP95Ms > this.budgetForQuality() * 1.2 ||
      signals.presentedIntervalP95Ms > this.targetIntervalMs * 1.25 ||
      signals.blockedRatio > 0.1 ||
      signals.inputLatencyP95Ms > this.targetIntervalMs ||
      signals.skippedFrameCount >= this.downgradeAfter;

    if (bad) {
      this.goodSince = undefined;
      this.badStreak++;
      if (this.badStreak >= this.downgradeAfter) {
        this.quality = qualityAt(QUALITY_INDEX[this.quality] - 1);
        this.badStreak = 0;
      }
      return this.quality;
    }

    this.badStreak = 0;
    if (this.goodSince === undefined) {
      this.goodSince = at;
    } else if (at - this.goodSince >= this.upgradeAfterMs) {
      this.quality = qualityAt(QUALITY_INDEX[this.quality] + 1);
      this.goodSince = at;
    }
    return this.quality;
  }

  private budgetForQuality(): number {
    return QUALITY_BUDGET_MS[this.quality];
  }

  private blockedRatio(at: number): number {
    const windowStart = at - this.blockedWindowMs;
    let blockedMs = 0;
    for (const event of this.blockedEvents) {
      const end = event.end ?? at;
      const start = Math.max(event.start, windowStart);
      const clampedEnd = Math.min(end, at);
      if (clampedEnd > start) blockedMs += clampedEnd - start;
    }
    return blockedMs / this.blockedWindowMs;
  }

  private pruneBlocked(at: number): void {
    const cutoff = at - this.blockedWindowMs;
    this.blockedEvents = this.blockedEvents.filter(event => (event.end ?? at) >= cutoff);
  }
}

function pushWindow<T>(window: T[], value: T, limit: number): void {
  window.push(value);
  if (window.length > limit) window.splice(0, window.length - limit);
}
