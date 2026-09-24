/**
 * FileSpillStore —— append-only NDJSON cold storage。
 *
 * 文件格式：
 *   {"type":"record","record":{...}}
 *   {"type":"delete","streamId":"...","lineId":"..."}
 *
 * 对 `line-N` 这类规范数字 LineId 使用按 chunk 分配的 numeric offset/length 索引，
 * 避免为每条 cold record 保留字符串 key 的 Map 项；稀疏编号不会分配巨型数组。
 * 非数字或超过 4GiB offset 的记录才回退到普通 Map。
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { LineId, StreamId } from "./ledger.ts";
import type { SpillRecord, SpillStore } from "./spill.ts";

interface SpillIndexEntry {
  offset: number;
  length: number;
  bytes: number;
}

interface NumericChunk {
  offsets: Uint32Array;
  lengths: Uint32Array;
  present: Uint8Array;
}

interface NumericIndex {
  chunks: Map<number, NumericChunk>;
}

type NumericLineId = { prefix: string; number: number };

const NUMERIC_CHUNK_BITS = 10;
const NUMERIC_CHUNK_SIZE = 1 << NUMERIC_CHUNK_BITS;
const NUMERIC_CHUNK_MASK = NUMERIC_CHUNK_SIZE - 1;
const MAX_UINT32 = 0xffff_ffff;
const READ_CHUNK_BYTES = 64 * 1024;

type SpillFileLine =
  | { type: "record"; record: SpillRecord }
  | { type: "delete"; streamId: StreamId; lineId: LineId };

export interface FileSpillStoreOptions {
  /** 可选：delete tombstone 超过此数量时 compact 文件。 */
  compactAfterDeletes?: number;
}

export class FileSpillStore implements SpillStore {
  private readonly numericIndexes = new Map<
    StreamId,
    Map<string, NumericIndex>
  >();
  private readonly fallbackIndex = new Map<string, SpillIndexEntry>();
  private liveCount = 0;
  private liveBytes = 0;
  private deletes = 0;
  private size = 0;

  constructor(
    readonly path: string,
    private readonly options: FileSpillStoreOptions = {}
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) this.rebuildIndex();
  }

  write(record: SpillRecord): void {
    this.writeMany([record]);
  }

  writeMany(records: readonly SpillRecord[]): void {
    if (records.length === 0) return;

    const encoded: string[] = new Array(records.length);
    const lengths = new Uint32Array(records.length);
    let nextOffset = this.size;
    for (let index = 0; index < records.length; index++) {
      const line = `${JSON.stringify({
        type: "record",
        record: records[index],
      } satisfies SpillFileLine)}\n`;
      const length = Buffer.byteLength(line);
      if (length > MAX_UINT32) {
        throw new Error(`[butui] spill record 超过 4GiB: ${records[index]!.lineId}`);
      }
      encoded[index] = line;
      lengths[index] = length;
      nextOffset += length;
    }

    appendFileSync(this.path, encoded.join(""), "utf8");
    let offset = this.size;
    for (let index = 0; index < records.length; index++) {
      const length = lengths[index]!;
      this.indexRecord(records[index]!, offset, length);
      offset += length;
    }
    this.size = nextOffset;
  }

  read(streamId: StreamId, lineId: LineId): SpillRecord | undefined {
    const entry = this.locate(streamId, lineId);
    return entry ? this.readAt(entry.offset, entry.length) : undefined;
  }

  readMany(
    streamId: StreamId,
    lineIds: readonly LineId[]
  ): (SpillRecord | undefined)[] {
    if (lineIds.length === 0) return [];
    const fd = openSync(this.path, "r");
    try {
      return lineIds.map(lineId => {
        const entry = this.locate(streamId, lineId);
        return entry ? this.readAt(entry.offset, entry.length, fd) : undefined;
      });
    } finally {
      closeSync(fd);
    }
  }

  delete(streamId: StreamId, lineId: LineId): void {
    const record = this.read(streamId, lineId);
    if (!record) return;
    const line = `${JSON.stringify({
      type: "delete",
      streamId,
      lineId,
    } satisfies SpillFileLine)}\n`;
    appendFileSync(this.path, line, "utf8");
    this.size += Buffer.byteLength(line);
    this.removeIndex(streamId, lineId);
    this.deletes++;
    if (
      this.options.compactAfterDeletes !== undefined &&
      this.deletes >= this.options.compactAfterDeletes
    ) {
      this.compact();
    }
  }

  stats(): { records: number; bytes: number; fileBytes: number; deletes: number } {
    return {
      records: this.liveCount,
      bytes: this.liveBytes,
      fileBytes: this.size,
      deletes: this.deletes,
    };
  }

  /** 重写文件，只保留当前 live records。 */
  compact(): void {
    if (!existsSync(this.path)) return;

    const temporaryPath = `${this.path}.compact-${process.pid}`;
    const source = openSync(this.path, "r");
    const target = openSync(temporaryPath, "w");
    const output = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let outputLength = 0;

    const flush = (): void => {
      if (outputLength === 0) return;
      writeAll(target, output, 0, outputLength);
      outputLength = 0;
    };

    try {
      this.scanFile(line => {
        const parsed = JSON.parse(line.text) as SpillFileLine;
        if (parsed.type !== "record") return;
        if (!this.isLive(parsed.record, line.offset)) return;

        const encoded = Buffer.from(`${line.text}\n`, "utf8");
        if (outputLength + encoded.length > output.length) flush();
        if (encoded.length > output.length) {
          writeAll(target, encoded, 0, encoded.length);
          return;
        }
        encoded.copy(output, outputLength);
        outputLength += encoded.length;
      }, source);
      flush();
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    } finally {
      closeSync(source);
      closeSync(target);
    }

    rmSync(this.path, { force: true });
    renameSync(temporaryPath, this.path);
    this.resetIndex();
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.resetIndex();
    this.scanFile(line => {
      const parsed = JSON.parse(line.text) as SpillFileLine;
      if (parsed.type === "record") {
        this.indexRecord(parsed.record, line.offset, line.length);
      } else {
        const record = this.read(parsed.streamId, parsed.lineId);
        if (record) {
          this.removeIndex(parsed.streamId, parsed.lineId);
          this.deletes++;
        }
      }
    });
    this.size = statSync(this.path).size;
  }

  private resetIndex(): void {
    this.numericIndexes.clear();
    this.fallbackIndex.clear();
    this.liveCount = 0;
    this.liveBytes = 0;
    this.deletes = 0;
    this.size = 0;
  }

  private scanFile(
    onLine: (line: { text: string; offset: number; length: number }) => void,
    providedFd?: number
  ): void {
    const fd = providedFd ?? openSync(this.path, "r");
    const shouldClose = providedFd === undefined;
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let carry = "";
    let offset = 0;
    try {
      while (true) {
        const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const text = carry + decoder.write(buffer.subarray(0, bytesRead));
        let start = 0;
        let newline = text.indexOf("\n", start);
        while (newline !== -1) {
          const lineText = text.slice(start, newline);
          const length = Buffer.byteLength(lineText) + 1;
          onLine({ text: lineText, offset, length });
          offset += length;
          start = newline + 1;
          newline = text.indexOf("\n", start);
        }
        carry = text.slice(start);
      }
    } finally {
      if (shouldClose) closeSync(fd);
    }
  }

  private isLive(record: SpillRecord, offset: number): boolean {
    return this.locate(record.streamId, record.lineId)?.offset === offset;
  }

  private indexRecord(
    record: SpillRecord,
    offset: number,
    length: number
  ): void {
    const numeric = parseNumericLineId(record.lineId);
    if (numeric && offset <= MAX_UINT32) {
      this.removeFallback(record.streamId, record.lineId);
      this.removeNumeric(record.streamId, record.lineId);
      const indexes = this.numericIndexesFor(record.streamId);
      let index = indexes.get(numeric.prefix);
      if (!index) {
        index = { chunks: new Map() };
        indexes.set(numeric.prefix, index);
      }
      const zeroBased = numeric.number - 1;
      const chunkIndex = Math.floor(zeroBased / NUMERIC_CHUNK_SIZE);
      let chunk = index.chunks.get(chunkIndex);
      if (!chunk) {
        chunk = {
          offsets: new Uint32Array(NUMERIC_CHUNK_SIZE),
          lengths: new Uint32Array(NUMERIC_CHUNK_SIZE),
          present: new Uint8Array(NUMERIC_CHUNK_SIZE),
        };
        index.chunks.set(chunkIndex, chunk);
      }
      const at = zeroBased & NUMERIC_CHUNK_MASK;
      chunk.offsets[at] = offset;
      chunk.lengths[at] = length;
      chunk.present[at] = 1;
      this.liveCount++;
      this.liveBytes += record.bytes;
      return;
    }

    this.removeNumeric(record.streamId, record.lineId);
    this.removeFallback(record.streamId, record.lineId);
    const key = spillKey(record.streamId, record.lineId);
    this.fallbackIndex.set(key, {
      offset,
      length,
      bytes: record.bytes,
    });
    this.liveCount++;
    this.liveBytes += record.bytes;
  }

  private removeIndex(streamId: StreamId, lineId: LineId): void {
    if (this.removeFallback(streamId, lineId)) return;
    this.removeNumeric(streamId, lineId);
  }

  private locate(
    streamId: StreamId,
    lineId: LineId
  ): { offset: number; length: number } | undefined {
    const fallback = this.fallbackIndex.get(spillKey(streamId, lineId));
    if (fallback) return fallback;

    const numeric = parseNumericLineId(lineId);
    if (!numeric) return undefined;
    const zeroBased = numeric.number - 1;
    const chunk = this.numericIndexes
      .get(streamId)
      ?.get(numeric.prefix)
      ?.chunks.get(Math.floor(zeroBased / NUMERIC_CHUNK_SIZE));
    const at = zeroBased & NUMERIC_CHUNK_MASK;
    if (!chunk || chunk.present[at] === 0) return undefined;
    return {
      offset: chunk.offsets[at]!,
      length: chunk.lengths[at]!,
    };
  }

  private numericIndexesFor(streamId: StreamId): Map<string, NumericIndex> {
    let indexes = this.numericIndexes.get(streamId);
    if (!indexes) {
      indexes = new Map();
      this.numericIndexes.set(streamId, indexes);
    }
    return indexes;
  }

  private removeNumeric(
    streamId: StreamId,
    lineId: LineId
  ): SpillRecord | undefined {
    const numeric = parseNumericLineId(lineId);
    if (!numeric) return undefined;
    const zeroBased = numeric.number - 1;
    const indexes = this.numericIndexes.get(streamId);
    const index = indexes?.get(numeric.prefix);
    const chunk = index?.chunks.get(Math.floor(zeroBased / NUMERIC_CHUNK_SIZE));
    const at = zeroBased & NUMERIC_CHUNK_MASK;
    if (!chunk || chunk.present[at] === 0) return undefined;

    chunk.present[at] = 0;
    const previous = this.readAt(chunk.offsets[at]!, chunk.lengths[at]!);
    this.liveCount--;
    this.liveBytes -= previous?.bytes ?? 0;
    return previous;
  }

  private removeFallback(
    streamId: StreamId,
    lineId: LineId
  ): SpillIndexEntry | undefined {
    const key = spillKey(streamId, lineId);
    const previous = this.fallbackIndex.get(key);
    if (!previous) return undefined;
    this.fallbackIndex.delete(key);
    this.liveCount--;
    this.liveBytes -= previous.bytes;
    return previous;
  }

  private readAt(
    offset: number,
    length: number,
    existingFd?: number
  ): SpillRecord | undefined {
    const buffer = Buffer.allocUnsafe(length);
    const fd = existingFd ?? openSync(this.path, "r");
    try {
      let read = 0;
      while (read < length) {
        const bytesRead = readSync(
          fd,
          buffer,
          read,
          length - read,
          offset + read
        );
        if (bytesRead === 0) {
          throw new Error(`[butui] spill file 在 offset ${offset} 处截断`);
        }
        read += bytesRead;
      }
    } finally {
      if (existingFd === undefined) closeSync(fd);
    }
    const parsed = JSON.parse(buffer.toString("utf8")) as SpillFileLine;
    return parsed.type === "record" ? parsed.record : undefined;
  }
}

function parseNumericLineId(lineId: LineId): NumericLineId | undefined {
  const match = /^(.*?)(\d+)$/.exec(lineId);
  if (!match) return undefined;
  const digits = match[2]!;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  if (digits !== String(number)) return undefined;
  return { prefix: match[1] ?? "", number };
}

function writeAll(
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number
): void {
  let written = 0;
  while (written < length) {
    written += writeSync(
      fd,
      buffer,
      offset + written,
      length - written
    );
  }
}

function spillKey(streamId: StreamId, lineId: LineId): string {
  return `${streamId}\u0000${lineId}`;
}
