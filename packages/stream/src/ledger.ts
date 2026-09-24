/**
 * StreamLedger —— v0.2 的权威流状态。
 *
 * 现有 StreamSource 适合“只增文本 + volatile tail”；这个 ledger 把真实 agent
 * 流需要的 append / replace-tail / finish / cancel 变成可验证状态：
 *
 *   - seq 连续；
 *   - 重复 op 幂等；
 *   - 缺口不猜测；
 *   - replace-tail 不允许越过 volatile tail 覆盖 stable line；
 *   - finish / cancel 后拒绝后续写入。
 */
import type { MemoryLedger, MemoryReservation } from "@butui/core";
import {
  StreamRetention,
  type RetentionPolicy,
  type SpillManifest,
  type SpillRecord,
  type SpillStore,
} from "./spill.ts";

export type StreamId = string;
export type LineId = string;
export type SessionRevision = number;

const HYDRATE_READ_BATCH = 1024;

export type StreamKind = "text" | "reasoning" | "tool" | "diff" | "status";
export type StreamPriority = 0 | 1 | 2 | 3;
export type StreamStatus = "open" | "finished" | "cancelled";

export interface TailAnchor {
  lineId: LineId;
  /** 行内 grapheme 索引；0 表示行首。 */
  grapheme: number;
}

export type StreamOperation =
  | { type: "append"; delta: string }
  | { type: "replace-tail"; from: TailAnchor | null; text: string }
  | { type: "finish"; digest?: string }
  | { type: "cancel"; reason: string };

export interface StreamEnvelope {
  sessionId: string;
  streamId: StreamId;
  seq: number;
  baseRevision: SessionRevision;
  kind: StreamKind;
  priority: StreamPriority;
  op: StreamOperation;
  createdAt: number;
}

export type StreamRejectReason =
  | "gap"
  | "conflict"
  | "closed"
  | "cancelled"
  | "anchor-outside-volatile-tail"
  | "budget-exceeded"
  | "unknown-stream";

export type StreamApplyResult =
  | { status: "applied"; revision: SessionRevision; linesAdded: number }
  | { status: "duplicate"; seq: number }
  | { status: "rejected"; reason: StreamRejectReason };

export interface StreamLineRecord {
  id: LineId;
  text: string;
  stableAtRevision: SessionRevision;
  digest: string;
  /** 已写入 cold storage；text 为空，需 hydrate 后恢复。 */
  spilled?: boolean;
}

export interface StreamTailLine {
  id: LineId;
  text: string;
  graphemeLength: number;
}

export interface StreamTombstone {
  streamId: StreamId;
  reason: string;
  atRevision: SessionRevision;
}

export interface StreamProjection {
  streamId: StreamId;
  status: StreamStatus;
  revision: SessionRevision;
  stableLines: readonly StreamLineRecord[];
  volatileTail: readonly StreamTailLine[];
  tombstones: readonly StreamTombstone[];
  /**
   * 已离开内存的 stable line segment。连续 ID 只存范围；多 stream 交错时
   * 优先使用 lineRuns 压缩。
   */
  spilledSegments: readonly SpilledSegment[];
}

export interface SpilledSegment {
  streamId: StreamId;
  firstLineId: LineId;
  lastLineId: LineId;
  count: number;
  bytes: number;
  /**
   * 非连续 LineId 的 arithmetic runs；例如 `line-1,line-3,line-5` 可表示为
   * `{ prefix: "line-", start: 1, step: 2, count: 3 }`。
   */
  lineRuns?: readonly LineIdRun[];
  /** 非规范数字 ID 无法形成 run 时的显式回退。 */
  lineIds?: readonly LineId[];
}

export interface LineIdRun {
  prefix: string;
  start: number;
  step: number;
  count: number;
}

export interface StreamLineWindow {
  streamId: StreamId;
  revision: SessionRevision;
  /** clamp 后的逻辑 stable-line 起始下标。 */
  offset: number;
  totalLines: number;
  lines: readonly StreamLineRecord[];
}

export interface StreamLedgerStats {
  streams: number;
  openStreams: number;
  stableLines: number;
  inMemoryLines: number;
  spilledLines: number;
  tailLines: number;
  tombstones: number;
  reservedBytes: number;
}

export interface OpenStreamMeta {
  streamId: StreamId;
  kind: StreamKind;
  priority: StreamPriority;
  createdAt: number;
}

export interface StreamLedgerOptions {
  /** 可选内存预算；不传时保持无预算行为。 */
  memory?: MemoryLedger;
  /** MemoryLedger owner，默认 butui-stream。 */
  memoryOwner?: string;
  /** 可选 cold storage；启用 applyWithSpill()。 */
  spill?: {
    store: SpillStore;
    policy?: RetentionPolicy;
  };
}

interface StreamState {
  meta: OpenStreamMeta;
  status: StreamStatus;
  revision: SessionRevision;
  lastSeq: number;
  stableLines: StreamLineRecord[];
  tailLines: StreamTailLine[];
  spilledSegments: SpilledSegmentState[];
  tombstones: StreamTombstone[];
  applied: Map<number, string>;
  memoryReservations: MemoryReservation[];
}

interface SpilledSegmentState {
  streamId: StreamId;
  firstLineId: LineId;
  lastLineId: LineId;
  count: number;
  bytes: number;
  lineRuns?: LineIdRun[];
  lineIds?: LineId[];
}

export class StreamLedger {
  private readonly streams = new Map<StreamId, StreamState>();
  private readonly memory?: MemoryLedger;
  private readonly memoryOwner: string;
  private readonly spillStore?: SpillStore;
  private readonly spillPolicy?: RetentionPolicy;
  private nextLineId = 1;

  constructor(options: StreamLedgerOptions = {}) {
    this.memory = options.memory;
    this.memoryOwner = options.memoryOwner ?? "butui-stream";
    this.spillStore = options.spill?.store;
    this.spillPolicy = options.spill?.policy;
  }

  open(meta: OpenStreamMeta): void {
    if (this.streams.has(meta.streamId)) return;
    this.streams.set(meta.streamId, {
      meta: { ...meta },
      status: "open",
      revision: 0,
      lastSeq: 0,
      stableLines: [],
      tailLines: [],
      spilledSegments: [],
      tombstones: [],
      applied: new Map(),
      memoryReservations: [],
    });
  }

  apply(envelope: StreamEnvelope): StreamApplyResult {
    const stream = this.streams.get(envelope.streamId);
    if (!stream) return { status: "rejected", reason: "unknown-stream" };
    if (stream.status === "cancelled") {
      return { status: "rejected", reason: "cancelled" };
    }
    if (stream.status === "finished") {
      return { status: "rejected", reason: "closed" };
    }

    const digest = digestEnvelope(envelope);
    if (envelope.seq <= stream.lastSeq) {
      const previous = stream.applied.get(envelope.seq);
      return previous === digest
        ? { status: "duplicate", seq: envelope.seq }
        : { status: "rejected", reason: "conflict" };
    }
    if (envelope.seq !== stream.lastSeq + 1) {
      return { status: "rejected", reason: "gap" };
    }

    const revision = Math.max(stream.revision + 1, envelope.baseRevision + 1);
    let linesAdded = 0;
    const bytes = operationBytes(envelope.op);
    let memoryReservation: MemoryReservation | undefined;
    if (this.memory && bytes > 0) {
      const decision = this.memory.reserve({
        owner: this.memoryOwner,
        class: "hot",
        bytes,
        priority: 1,
        spillable: true,
        reconstructible: true,
      });
      if (decision.status !== "granted") {
        return { status: "rejected", reason: "budget-exceeded" };
      }
      memoryReservation = decision.reservation;
      stream.memoryReservations.push(memoryReservation);
    }

    switch (envelope.op.type) {
      case "append":
        linesAdded = appendTailText(this, stream, envelope.op.delta, revision);
        break;
      case "replace-tail": {
        const replaced = replaceTail(
          this,
          stream,
          envelope.op.from,
          envelope.op.text,
          revision
        );
        if (replaced === undefined) {
          memoryReservation?.release();
          stream.memoryReservations = stream.memoryReservations.filter(
            reservation => reservation !== memoryReservation
          );
          return {
            status: "rejected",
            reason: "anchor-outside-volatile-tail",
          };
        }
        linesAdded = replaced;
        break;
      }
      case "finish":
        for (const line of stream.tailLines) {
          stream.stableLines.push({
            id: line.id,
            text: line.text,
            stableAtRevision: revision,
            digest: digestText(line.text),
          });
          linesAdded++;
        }
        stream.tailLines = [];
        stream.status = "finished";
        break;
      case "cancel":
        stream.tailLines = [];
        stream.status = "cancelled";
        stream.tombstones.push({
          streamId: stream.meta.streamId,
          reason: envelope.op.reason,
          atRevision: revision,
        });
        break;
    }

    stream.lastSeq = envelope.seq;
    stream.revision = revision;
    stream.applied.set(envelope.seq, digest);
    return { status: "applied", revision, linesAdded };
  }

  /**
   * apply 的 spill-aware 版本。
   *
   * 只有 budget-exceeded 且配置了 spill store 时才尝试释放 cold 空间，然后
   * 用同一个 envelope 重试；其他拒绝原因原样返回。
   */
  async applyWithSpill(envelope: StreamEnvelope): Promise<StreamApplyResult> {
    const first = this.apply(envelope);
    if (
      first.status !== "rejected" ||
      first.reason !== "budget-exceeded" ||
      !this.spillStore
    ) {
      return first;
    }

    await this.spillOldest(envelope.streamId, operationBytes(envelope.op));
    return this.apply(envelope);
  }

  /** 把已 spill 的 stable line 重新读回内存。 */
  async hydrate(streamId: StreamId, lineIds?: readonly LineId[]): Promise<number> {
    if (!this.spillStore) {
      throw new Error("[butui] stream 未配置 spill store");
    }
    const stream = this.streams.get(streamId);
    if (!stream) return 0;
    if (lineIds && stream.spilledSegments.length > 0) {
      throw new Error("[butui] partial hydrate of spilled segments 尚未支持");
    }

    const wanted = lineIds ? new Set(lineIds) : undefined;
    const targets = stream.stableLines.filter(
      line => line.spilled && (!wanted || wanted.has(line.id))
    );
    let hydrated = 0;
    if (targets.length > 0) {
      const records = await readSpillRecordsInBatches(
        this.spillStore,
        streamId,
        targets.map(line => line.id)
      );
      for (let index = 0; index < targets.length; index++) {
        const line = targets[index]!;
        const record = records[index]!;
        line.text = record.text;
        line.digest = record.digest;
        delete line.spilled;
        hydrated++;
      }
    }

    if (wanted || stream.spilledSegments.length === 0) return hydrated;

    const restored: StreamLineRecord[] = [];
    for (const segment of stream.spilledSegments) {
      for (let start = 0; start < segment.count; start += HYDRATE_READ_BATCH) {
        const count = Math.min(HYDRATE_READ_BATCH, segment.count - start);
        const ids = segmentLineIdsSlice(segment, start, count);
        const records = await readSpillRecords(this.spillStore, streamId, ids);
        for (let index = 0; index < ids.length; index++) {
          const record = records[index]!;
          restored.push({
            id: ids[index]!,
            text: record.text,
            stableAtRevision: record.stableAtRevision,
            digest: record.digest,
          });
        }
      }
    }
    stream.stableLines = [...restored, ...stream.stableLines];
    stream.spilledSegments = [];
    return hydrated + restored.length;
  }

  /**
   * 只读取指定 cold lines，不改变 ledger 状态。
   *
   * 这是 viewport / replay 的推荐路径；需要修改内存状态时使用 hydrate()。
   */
  async readCold(
    streamId: StreamId,
    lineIds: readonly LineId[]
  ): Promise<readonly StreamLineRecord[]> {
    if (!this.spillStore) {
      throw new Error("[butui] stream 未配置 spill store");
    }
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`[butui] unknown stream: ${streamId}`);
    if (lineIds.length === 0) return [];

    const explicitSets = new Map<SpilledSegmentState, Set<LineId>>();
    for (const lineId of lineIds) {
      const segment = stream.spilledSegments.find(candidate => {
        if (candidate.lineRuns) return runsContainLineId(candidate.lineRuns, lineId);
        if (!candidate.lineIds) return rangeContainsLineId(candidate, lineId);
        let ids = explicitSets.get(candidate);
        if (!ids) {
          ids = new Set(candidate.lineIds);
          explicitSets.set(candidate, ids);
        }
        return ids.has(lineId);
      });
      if (!segment) {
        throw new Error(`[butui] line-not-cold: ${streamId}/${lineId}`);
      }
    }

    const records = await readSpillRecordsInBatches(
      this.spillStore,
      streamId,
      lineIds
    );
    return records.map(record => ({
      id: record.lineId,
      text: record.text,
      stableAtRevision: record.stableAtRevision,
      digest: record.digest,
    }));
  }

  /**
   * 按逻辑 stable-line 下标读取窗口，自动混合 spilled segments 与 hot lines。
   *
   * 这是 renderer / replay adapter 应消费的 viewport 原语；不会 hydrate 或修改
   * ledger。
   */
  async readStableRange(
    streamId: StreamId,
    offset: number,
    count: number
  ): Promise<StreamLineWindow> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`[butui] unknown stream: ${streamId}`);

    const spilledLines = stream.spilledSegments.reduce(
      (sum, segment) => sum + segment.count,
      0
    );
    const totalLines = spilledLines + stream.stableLines.length;
    const start = clampIndex(offset, totalLines);
    const requested = Number.isFinite(count)
      ? Math.max(0, Math.floor(count))
      : totalLines - start;
    const end = Math.min(totalLines, start + requested);
    const lines = new Array<StreamLineRecord | undefined>(end - start);
    const coldIds: LineId[] = [];
    const coldSlots: number[] = [];

    let cursor = 0;
    for (const segment of stream.spilledSegments) {
      if (cursor >= end) break;
      const segmentEnd = cursor + segment.count;
      const overlapStart = Math.max(start, cursor);
      const overlapEnd = Math.min(end, segmentEnd);
      if (overlapStart < overlapEnd) {
        const ids = segmentLineIdsSlice(
          segment,
          overlapStart - cursor,
          overlapEnd - overlapStart
        );
        for (let index = 0; index < ids.length; index++) {
          coldIds.push(ids[index]!);
          coldSlots.push(overlapStart - start + index);
        }
      }
      cursor = segmentEnd;
    }

    if (coldIds.length > 0) {
      if (!this.spillStore) {
        throw new Error("[butui] stream 未配置 spill store");
      }
      const records = await readSpillRecordsInBatches(
        this.spillStore,
        streamId,
        coldIds
      );
      for (let index = 0; index < records.length; index++) {
        const record = records[index]!;
        lines[coldSlots[index]!] = {
          id: record.lineId,
          text: record.text,
          stableAtRevision: record.stableAtRevision,
          digest: record.digest,
        };
      }
    }

    const hotStart = Math.max(start, spilledLines);
    for (let index = hotStart; index < end; index++) {
      const line = stream.stableLines[index - spilledLines]!;
      lines[index - start] = {
        id: line.id,
        text: line.text,
        stableAtRevision: line.stableAtRevision,
        digest: line.digest,
      };
    }

    for (let index = 0; index < lines.length; index++) {
      if (!lines[index]) {
        throw new Error(`[butui] stable window 缺失 slot: ${streamId}/${start + index}`);
      }
    }

    return {
      streamId,
      revision: stream.revision,
      offset: start,
      totalLines,
      lines: lines as StreamLineRecord[],
    };
  }

  private async spillOldest(
    streamId: StreamId,
    neededBytes: number
  ): Promise<SpillManifest> {
    const stream = this.streams.get(streamId);
    if (!stream || !this.spillStore) {
      throw new Error("[butui] spill 不可用");
    }

    const candidates = stream.stableLines.filter(line => !line.spilled);
    const totalStableBytes = candidates.reduce(
      (sum, line) => sum + Buffer.byteLength(line.text),
      0
    );
    const maxBytes = this.spillPolicy?.maxBytes ?? Number.POSITIVE_INFINITY;
    const targetBytes = Math.max(
      neededBytes,
      Number.isFinite(maxBytes) ? totalStableBytes - maxBytes : 0
    );

    const spillLines: StreamLineRecord[] = [];
    let spillBytes = 0;
    for (const line of candidates) {
      spillLines.push(line);
      spillBytes += Buffer.byteLength(line.text);
      if (spillBytes >= targetBytes) break;
    }
    if (spillLines.length === 0) {
      throw new Error("[butui] 没有可 spill 的 stable line");
    }

    const retention = new StreamRetention(this.spillStore, {
      maxBytes: 0,
      ...(this.spillPolicy?.keepTailLines !== undefined
        ? { keepTailLines: this.spillPolicy.keepTailLines }
        : {}),
    });
    const result = await retention.spill(streamId, spillLines);
    const ids = new Set(spillLines.map(line => line.id));
    stream.stableLines = stream.stableLines.filter(line => !ids.has(line.id));
    appendSpilledSegment(stream, result.manifest);

    let released = 0;
    while (
      stream.memoryReservations.length > 0 &&
      released < result.manifest.bytes
    ) {
      const reservation = stream.memoryReservations.shift()!;
      released += reservation.bytes;
      reservation.release();
    }
    return result.manifest;
  }

  project(streamId: StreamId): StreamProjection {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`[butui] unknown stream: ${streamId}`);
    return {
      streamId,
      status: stream.status,
      revision: stream.revision,
      stableLines: stream.stableLines,
      volatileTail: stream.tailLines,
      tombstones: stream.tombstones,
      spilledSegments: stream.spilledSegments,
    };
  }

  stats(): StreamLedgerStats {
    let openStreams = 0;
    let inMemoryLines = 0;
    let spilledLines = 0;
    let tailLines = 0;
    let tombstones = 0;
    let reservedBytes = 0;
    for (const stream of this.streams.values()) {
      if (stream.status === "open") openStreams++;
      inMemoryLines += stream.stableLines.length;
      spilledLines += stream.spilledSegments.reduce(
        (sum, segment) => sum + segment.count,
        0
      );
      tailLines += stream.tailLines.length;
      tombstones += stream.tombstones.length;
      for (const reservation of stream.memoryReservations) {
        reservedBytes += reservation.bytes;
      }
    }
    return {
      streams: this.streams.size,
      openStreams,
      stableLines: inMemoryLines + spilledLines,
      inMemoryLines,
      spilledLines,
      tailLines,
      tombstones,
      reservedBytes,
    };
  }

  dispose(): void {
    for (const stream of this.streams.values()) {
      for (const reservation of stream.memoryReservations) reservation.release();
      stream.memoryReservations = [];
    }
    this.streams.clear();
  }

  lineId(): LineId {
    return `line-${this.nextLineId++}`;
  }
}

function spilledSegmentRange(segment: SpilledSegment): {
  prefix: string;
  start: number;
} {
  const first = parseSequentialLineId(segment.firstLineId);
  if (!first) {
    throw new Error(
      `[butui] spilled segment 缺少可推导的 LineId: ${segment.firstLineId}`
    );
  }
  if (
    `${first.prefix}${first.number + segment.count - 1}` !== segment.lastLineId
  ) {
    throw new Error(`[butui] spilled segment 不连续: ${segment.streamId}`);
  }
  return { prefix: first.prefix, start: first.number };
}

function rangeContainsLineId(segment: SpilledSegment, lineId: LineId): boolean {
  const range = spilledSegmentRange(segment);
  const parsed = parseSequentialLineId(lineId);
  return (
    parsed !== undefined &&
    parsed.prefix === range.prefix &&
    parsed.number >= range.start &&
    parsed.number < range.start + segment.count
  );
}

async function readSpillRecordsInBatches(
  store: SpillStore,
  streamId: StreamId,
  lineIds: readonly LineId[]
): Promise<SpillRecord[]> {
  const records: SpillRecord[] = [];
  for (let start = 0; start < lineIds.length; start += HYDRATE_READ_BATCH) {
    const batch = lineIds.slice(start, start + HYDRATE_READ_BATCH);
    records.push(...(await readSpillRecords(store, streamId, batch)));
  }
  return records;
}

async function readSpillRecords(
  store: SpillStore,
  streamId: StreamId,
  lineIds: readonly LineId[]
): Promise<SpillRecord[]> {
  if (store.readMany) {
    const records = await store.readMany(streamId, lineIds);
    if (records.length !== lineIds.length) {
      throw new Error(
        `[butui] cold-read-error: ${streamId} returned ${records.length}/${lineIds.length} records`
      );
    }
    return records.map((record, index) => {
      if (!record) {
        throw new Error(`[butui] cold-read-error: ${streamId}/${lineIds[index]}`);
      }
      return record;
    });
  }

  const records: SpillRecord[] = [];
  for (const lineId of lineIds) {
    const record = await store.read(streamId, lineId);
    if (!record) {
      throw new Error(`[butui] cold-read-error: ${streamId}/${lineId}`);
    }
    records.push(record);
  }
  return records;
}

function appendSpilledSegment(
  stream: StreamState,
  manifest: SpillManifest
): void {
  if (manifest.count === 0 || !manifest.firstLineId || !manifest.lastLineId) return;
  if (manifest.lineIds.length !== manifest.count) {
    throw new Error(`[butui] spill manifest count 不一致: ${manifest.streamId}`);
  }

  const previous = stream.spilledSegments[stream.spilledSegments.length - 1];
  if (!previous || previous.streamId !== manifest.streamId) {
    stream.spilledSegments.push(createSpilledSegment(manifest));
    return;
  }

  if (
    !previous.lineIds &&
    !previous.lineRuns &&
    lineIdsAreContiguous(manifest.lineIds) &&
    rangesAreAdjacent(previous, manifest)
  ) {
    previous.lastLineId = manifest.lastLineId;
    previous.count += manifest.count;
    previous.bytes += manifest.bytes;
    return;
  }

  const previousRuns = segmentRuns(previous);
  const manifestRuns = lineIdsToRuns(manifest.lineIds);
  if (previousRuns && manifestRuns) {
    previous.lineRuns = mergeRuns(previousRuns, manifestRuns);
    previous.lineIds = undefined;
  } else {
    previous.lineIds = materializeSegmentLineIds(previous);
    previous.lineRuns = undefined;
    for (const lineId of manifest.lineIds) previous.lineIds.push(lineId);
  }
  previous.lastLineId = manifest.lastLineId;
  previous.count += manifest.count;
  previous.bytes += manifest.bytes;
}

function createSpilledSegment(manifest: SpillManifest): SpilledSegmentState {
  const segment: SpilledSegmentState = {
    streamId: manifest.streamId,
    firstLineId: manifest.firstLineId!,
    lastLineId: manifest.lastLineId!,
    count: manifest.count,
    bytes: manifest.bytes,
  };
  if (lineIdsAreContiguous(manifest.lineIds)) return segment;

  const runs = lineIdsToRuns(manifest.lineIds);
  if (runs && runs.length * 2 <= manifest.lineIds.length) {
    segment.lineRuns = runs;
  } else {
    segment.lineIds = [...manifest.lineIds];
  }
  return segment;
}

function segmentRuns(segment: SpilledSegmentState): LineIdRun[] | undefined {
  if (segment.lineRuns) return segment.lineRuns.map(run => ({ ...run }));
  if (segment.lineIds) return lineIdsToRuns(segment.lineIds);
  const range = spilledSegmentRange(segment);
  return [
    {
      prefix: range.prefix,
      start: range.start,
      step: 1,
      count: segment.count,
    },
  ];
}

function mergeRuns(previous: LineIdRun[], next: readonly LineIdRun[]): LineIdRun[] {
  const merged = previous;
  for (const run of next) {
    const last = merged[merged.length - 1];
    const contiguous =
      last !== undefined &&
      last.prefix === run.prefix &&
      last.start + last.step * last.count === run.start;
    if (contiguous && last!.step === run.step) {
      last!.count += run.count;
    } else if (contiguous && run.count === 1) {
      last!.count++;
    } else if (
      last?.count === 1 &&
      last.prefix === run.prefix &&
      last.start + run.step === run.start
    ) {
      last.step = run.step;
      last.count = run.count + 1;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function materializeSegmentLineIds(segment: SpilledSegmentState): LineId[] {
  if (segment.lineIds) return [...segment.lineIds];
  if (segment.lineRuns) {
    return segmentLineIdsSlice(segment, 0, segment.count);
  }
  const range = spilledSegmentRange(segment);
  return Array.from(
    { length: segment.count },
    (_, index) => `${range.prefix}${range.start + index}`
  );
}

function segmentLineIdsSlice(
  segment: SpilledSegmentState,
  start: number,
  count: number
): LineId[] {
  if (segment.lineIds) return segment.lineIds.slice(start, start + count);
  if (segment.lineRuns) return sliceRuns(segment.lineRuns, start, count);

  const range = spilledSegmentRange(segment);
  return Array.from(
    { length: count },
    (_, index) => `${range.prefix}${range.start + start + index}`
  );
}

function sliceRuns(
  runs: readonly LineIdRun[],
  start: number,
  count: number
): LineId[] {
  const lineIds: LineId[] = [];
  let skip = start;
  for (const run of runs) {
    if (skip >= run.count) {
      skip -= run.count;
      continue;
    }
    const runOffset = skip;
    const take = Math.min(count - lineIds.length, run.count - runOffset);
    for (let index = 0; index < take; index++) {
      lineIds.push(
        `${run.prefix}${run.start + (runOffset + index) * run.step}`
      );
    }
    skip = 0;
    if (lineIds.length === count) break;
  }
  return lineIds;
}

function lineIdsToRuns(lineIds: readonly LineId[]): LineIdRun[] | undefined {
  const parsed = lineIds.map(parseSequentialLineId);
  if (parsed.some(value => value === undefined)) return undefined;

  const runs: LineIdRun[] = [];
  let index = 0;
  while (index < parsed.length) {
    const first = parsed[index]!;
    const second = parsed[index + 1];
    if (!second || second.prefix !== first.prefix) {
      runs.push({ prefix: first.prefix, start: first.number, step: 1, count: 1 });
      index++;
      continue;
    }

    const step = second.number - first.number;
    if (step <= 0) {
      runs.push({ prefix: first.prefix, start: first.number, step: 1, count: 1 });
      index++;
      continue;
    }

    let end = index + 2;
    while (end < parsed.length) {
      const before = parsed[end - 1]!;
      const current = parsed[end]!;
      if (
        current.prefix !== first.prefix ||
        current.number - before.number !== step
      ) {
        break;
      }
      end++;
    }
    runs.push({
      prefix: first.prefix,
      start: first.number,
      step,
      count: end - index,
    });
    index = end;
  }
  return runs;
}

function rangesAreAdjacent(
  previous: SpilledSegmentState,
  manifest: SpillManifest
): boolean {
  const previousEnd = parseSequentialLineId(previous.lastLineId);
  const nextStart = parseSequentialLineId(manifest.firstLineId!);
  return (
    previousEnd !== undefined &&
    nextStart !== undefined &&
    previousEnd.prefix === nextStart.prefix &&
    previousEnd.number + 1 === nextStart.number
  );
}

function lineIdsAreContiguous(lineIds: readonly LineId[]): boolean {
  if (lineIds.length <= 1) return true;
  const first = parseSequentialLineId(lineIds[0]!);
  if (!first) return false;
  for (let index = 1; index < lineIds.length; index++) {
    if (lineIds[index] !== `${first.prefix}${first.number + index}`) return false;
  }
  return true;
}

function runsContainLineId(
  runs: readonly LineIdRun[],
  lineId: LineId
): boolean {
  const parsed = parseSequentialLineId(lineId);
  if (!parsed) return false;
  return runs.some(run => {
    if (run.prefix !== parsed.prefix) return false;
    const distance = parsed.number - run.start;
    return (
      distance >= 0 &&
      distance < run.step * run.count &&
      distance % run.step === 0
    );
  });
}

function clampIndex(value: number, total: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(total, Math.max(0, Math.floor(value)));
}

function parseSequentialLineId(
  lineId: LineId
): { prefix: string; number: number } | undefined {
  const match = /^(.*?)(\d+)$/.exec(lineId);
  if (!match) return undefined;
  const digits = match[2]!;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 0) return undefined;
  if (digits !== String(number)) return undefined;
  return { prefix: match[1] ?? "", number };
}

function appendTailText(
  ledger: StreamLedger,
  stream: StreamState,
  text: string,
  revision: SessionRevision,
  firstLineId?: LineId
): number {
  if (text === "") return 0;

  const segments = text.split("\n");
  let linesAdded = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const isFinal = index === segments.length - 1;

    if (isFinal && segment === "" && text.endsWith("\n")) break;
    appendToTail(ledger, stream, segment, index === 0 ? firstLineId : undefined);
    if (!isFinal) {
      commitTailLine(stream, revision);
      linesAdded++;
    }
  }
  return linesAdded;
}

function appendToTail(
  ledger: StreamLedger,
  stream: StreamState,
  text: string,
  lineId?: LineId
): void {
  const last = stream.tailLines[stream.tailLines.length - 1];
  if (last) {
    last.text += text;
    last.graphemeLength = graphemeCount(last.text);
    return;
  }
  stream.tailLines.push({
    id: lineId ?? ledger.lineId(),
    text,
    graphemeLength: graphemeCount(text),
  });
}

function commitTailLine(stream: StreamState, revision: SessionRevision): void {
  const line = stream.tailLines.pop();
  if (!line) return;
  stream.stableLines.push({
    id: line.id,
    text: line.text,
    stableAtRevision: revision,
    digest: digestText(line.text),
  });
}

function replaceTail(
  ledger: StreamLedger,
  stream: StreamState,
  from: TailAnchor | null,
  text: string,
  revision: SessionRevision
): number | undefined {
  if (from === null) {
    stream.tailLines = [];
    return appendTailText(ledger, stream, text, revision);
  }

  const index = stream.tailLines.findIndex(line => line.id === from.lineId);
  if (index === -1) return undefined;
  const line = stream.tailLines[index]!;
  if (!Number.isInteger(from.grapheme) || from.grapheme < 0) return undefined;
  if (from.grapheme > line.graphemeLength) return undefined;

  const graphemes = splitGraphemes(line.text);
  const prefix = graphemes.slice(0, from.grapheme).join("");
  stream.tailLines = stream.tailLines.slice(0, index);
  return appendTailText(
    ledger,
    stream,
    prefix + text,
    revision,
    line.id
  );
}

function graphemeCount(text: string): number {
  return splitGraphemes(text).length;
}

function splitGraphemes(text: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
    part => part.segment
  );
}

function operationBytes(op: StreamOperation): number {
  switch (op.type) {
    case "append":
      return Buffer.byteLength(op.delta);
    case "replace-tail":
      return Buffer.byteLength(op.text);
    default:
      return 0;
  }
}

function digestEnvelope(envelope: StreamEnvelope): string {  return digestText(
    JSON.stringify({
      streamId: envelope.streamId,
      seq: envelope.seq,
      baseRevision: envelope.baseRevision,
      kind: envelope.kind,
      priority: envelope.priority,
      op: envelope.op,
    })
  );
}

function digestText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
