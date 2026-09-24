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

export type StreamId = string;
export type LineId = string;
export type SessionRevision = number;

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
}

export interface StreamLedgerStats {
  streams: number;
  openStreams: number;
  stableLines: number;
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
}

interface StreamState {
  meta: OpenStreamMeta;
  status: StreamStatus;
  revision: SessionRevision;
  lastSeq: number;
  stableLines: StreamLineRecord[];
  tailLines: StreamTailLine[];
  tombstones: StreamTombstone[];
  applied: Map<number, string>;
  memoryReservations: MemoryReservation[];
}

export class StreamLedger {
  private readonly streams = new Map<StreamId, StreamState>();
  private readonly memory?: MemoryLedger;
  private readonly memoryOwner: string;
  private nextLineId = 1;

  constructor(options: StreamLedgerOptions = {}) {
    this.memory = options.memory;
    this.memoryOwner = options.memoryOwner ?? "butui-stream";
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
    };
  }

  stats(): StreamLedgerStats {
    let openStreams = 0;
    let stableLines = 0;
    let tailLines = 0;
    let tombstones = 0;
    let reservedBytes = 0;
    for (const stream of this.streams.values()) {
      if (stream.status === "open") openStreams++;
      stableLines += stream.stableLines.length;
      tailLines += stream.tailLines.length;
      tombstones += stream.tombstones.length;
      for (const reservation of stream.memoryReservations) {
        reservedBytes += reservation.bytes;
      }
    }
    return {
      streams: this.streams.size,
      openStreams,
      stableLines,
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
