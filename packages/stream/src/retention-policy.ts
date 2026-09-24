/**
 * v0.2 默认 retention 预算。
 *
 * 数值来自现有 retention / viewport / PTY 实测：优先限制 hot stable bytes，
 * 同时保留最近 256 行，避免短会话频繁 spill。它们不是硬编码上限，应用仍可
 * 显式覆盖。
 */
export interface StreamRetentionDefaults {
  /** 内存中保留的 stable bytes 上限。 */
  hotBytes: number;
  /** 无论 bytes 如何都保留的最近行数。 */
  keepTailLines: number;
  /** applied digest sidecar 的内存 chunk 数。 */
  appliedCacheChunks: number;
  /** numeric spill index sidecar 的内存 chunk 数。 */
  indexCacheChunks: number;
  /** delete tombstone 达到此数量后 compact。 */
  compactAfterDeletes: number;
}

export const DEFAULT_RETENTION_POLICY: Readonly<StreamRetentionDefaults> =
  Object.freeze({
    hotBytes: 4 * 1024 * 1024,
    keepTailLines: 256,
    appliedCacheChunks: 64,
    indexCacheChunks: 64,
    compactAfterDeletes: 10_000,
  });
