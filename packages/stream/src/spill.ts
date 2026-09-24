/**
 * Stream retention / spill 基础层。
 *
 * 这一层只负责“哪些 stable line 可以离开内存”和“离开后如何按原 LineId 恢复”，
 * 不决定 transcript 的展示或 scroll 行为。StreamLedger 接入时继续复用这里的
 * digest / 顺序校验。
 */
import type { LineId, StreamId, StreamLineRecord } from "./ledger.ts";

export interface SpillRecord {
  streamId: StreamId;
  lineId: LineId;
  text: string;
  digest: string;
  stableAtRevision: number;
  bytes: number;
}

export interface SpillManifest {
  streamId: StreamId;
  lineIds: readonly LineId[];
  firstLineId?: LineId;
  lastLineId?: LineId;
  count: number;
  bytes: number;
}

export interface SpillStore {
  write(record: SpillRecord): Promise<void> | void;
  /** 可选批量写入；实现应保证调用返回后所有记录均可读。 */
  writeMany?(records: readonly SpillRecord[]): Promise<void> | void;
  read(
    streamId: StreamId,
    lineId: LineId
  ): Promise<SpillRecord | undefined> | SpillRecord | undefined;
  /** 可选批量读取；返回数组与 lineIds 下标一一对应。 */
  readMany?(
    streamId: StreamId,
    lineIds: readonly LineId[]
  ): Promise<readonly (SpillRecord | undefined)[]> | readonly (SpillRecord | undefined)[];
  delete?(streamId: StreamId, lineId: LineId): Promise<void> | void;
}

export interface RetentionPolicy {
  /** 内存中最多保留多少 stable bytes。 */
  maxBytes: number;
  /** 无论 bytes 如何，至少保留最近 N 行。 */
  keepTailLines?: number;
}

export interface RetentionPlan {
  keep: StreamLineRecord[];
  spill: StreamLineRecord[];
  keptBytes: number;
  spillBytes: number;
}

export interface SpillResult {
  manifest: SpillManifest;
  records: readonly SpillRecord[];
}

export class MemorySpillStore implements SpillStore {
  private readonly records = new Map<string, SpillRecord>();
  private bytes = 0;

  write(record: SpillRecord): void {
    const key = spillKey(record.streamId, record.lineId);
    const previous = this.records.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.records.set(key, { ...record });
    this.bytes += record.bytes;
  }

  read(streamId: StreamId, lineId: LineId): SpillRecord | undefined {
    return this.records.get(spillKey(streamId, lineId));
  }

  delete(streamId: StreamId, lineId: LineId): void {
    const key = spillKey(streamId, lineId);
    const previous = this.records.get(key);
    if (!previous) return;
    this.bytes -= previous.bytes;
    this.records.delete(key);
  }

  stats(): { records: number; bytes: number } {
    return { records: this.records.size, bytes: this.bytes };
  }
}

export class StreamRetention {
  constructor(
    private readonly store: SpillStore,
    private readonly policy: RetentionPolicy
  ) {}

  plan(lines: readonly StreamLineRecord[]): RetentionPlan {
    const maxBytes = Math.max(0, this.policy.maxBytes);
    const keepTailLines = Math.max(0, Math.floor(this.policy.keepTailLines ?? 0));
    let keptBytes = 0;
    let keepCount = 0;

    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      const bytes = lineBytes(line);
      const mustKeep = keepCount < keepTailLines;
      if (!mustKeep && keptBytes + bytes > maxBytes) break;
      keptBytes += bytes;
      keepCount++;
    }

    const split = lines.length - keepCount;
    return {
      keep: lines.slice(split),
      spill: lines.slice(0, split),
      keptBytes,
      spillBytes: lines.slice(0, split).reduce((sum, line) => sum + lineBytes(line), 0),
    };
  }

  async spill(
    streamId: StreamId,
    lines: readonly StreamLineRecord[]
  ): Promise<SpillResult> {
    const records: SpillRecord[] = [];
    let bytes = 0;
    for (const line of lines) {
      const record: SpillRecord = {
        streamId,
        lineId: line.id,
        text: line.text,
        digest: line.digest,
        stableAtRevision: line.stableAtRevision,
        bytes: lineBytes(line),
      };
      records.push(record);
      bytes += record.bytes;
    }

    if (this.store.writeMany) {
      await this.store.writeMany(records);
    } else {
      for (const record of records) await this.store.write(record);
    }

    if (this.store.readMany) {
      const restored = await this.store.readMany(
        streamId,
        records.map(record => record.lineId)
      );
      if (restored.length !== records.length) {
        throw new Error(
          `[butui] spill verification failed: ${streamId} returned ${restored.length}/${records.length} records`
        );
      }
      for (let index = 0; index < records.length; index++) {
        verifyRecord(records[index]!, restored[index]);
      }
    } else {
      for (const record of records) {
        verifyRecord(record, await this.store.read(streamId, record.lineId));
      }
    }

    return {
      manifest: {
        streamId,
        lineIds: records.map(record => record.lineId),
        ...(records[0] ? { firstLineId: records[0].lineId } : {}),
        ...(records.length > 0
          ? { lastLineId: records[records.length - 1]!.lineId }
          : {}),
        count: records.length,
        bytes,
      },
      records,
    };
  }

  async restore(manifest: SpillManifest): Promise<SpillRecord[]> {
    const restored: SpillRecord[] = [];
    for (const lineId of manifest.lineIds) {
      const record = await this.store.read(manifest.streamId, lineId);
      if (!record) {
        throw new Error(`[butui] cold-read-error: ${manifest.streamId}/${lineId}`);
      }
      restored.push(record);
    }
    return restored;
  }
}

function lineBytes(line: StreamLineRecord): number {
  return Buffer.byteLength(line.text);
}

function verifyRecord(
  expected: SpillRecord,
  restored: SpillRecord | undefined
): void {
  if (
    !restored ||
    restored.text !== expected.text ||
    restored.digest !== expected.digest
  ) {
    throw new Error(
      `[butui] spill verification failed: ${expected.streamId}/${expected.lineId}`
    );
  }
}

function spillKey(streamId: StreamId, lineId: LineId): string {
  return `${streamId}\u0000${lineId}`;
}
