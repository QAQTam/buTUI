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
  /** 已离开内存的连续 stable line 范围；不含逐行 LineId 数组。 */
  spilledSegments: readonly SpilledSegment[];
}

export interface SpilledSegment {
  streamId: StreamId;
  firstLineId: LineId;
  lastLineId: LineId;
  count: number;
  bytes: number;
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
  spilledSegments: SpilledSegment[];
  tombstones: StreamTombstone[];
  applied: Map<number, string>;
  memoryReservations: MemoryReservation[];
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
      const range = spilledSegmentRange(segment);
      for (let start = 0; start < segment.count; start += HYDRATE_READ_BATCH) {
        const count = Math.min(HYDRATE_READ_BATCH, segment.count - start);
        const ids = Array.from(
          { length: count },
          (_, index) => `${range.prefix}${range.start + start + index}`
        );
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
  const match = /(\d+)$/.exec(segment.firstLineId);
  if (!match) {
    throw new Error(
      `[butui] spilled segment 缺少可推导的 LineId: ${segment.firstLineId}`
    );
  }
  const start = Number(match[1]);
  const prefix = segment.firstLineId.slice(0, match.index);
  if (`${prefix}${start + segment.count - 1}` !== segment.lastLineId) {
    throw new Error(`[butui] spilled segment 不连续: ${segment.streamId}`);
  }
  return { prefix, start };
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
  const previous = stream.spilledSegments[stream.spilledSegments.length - 1];
  if (previous && previous.streamId === manifest.streamId) {
    previous.lastLineId = manifest.lastLineId;
    previous.count += manifest.count;
    previous.bytes += manifest.bytes;
    return;
  }
  stream.spilledSegments.push({
    streamId: manifest.streamId,
    firstLineId: manifest.firstLineId,
    lastLineId: manifest.lastLineId,
    count: manifest.count,
    bytes: manifest.bytes,
  });
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
