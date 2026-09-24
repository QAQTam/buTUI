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
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { LineId, StreamId } from "./ledger.ts";
import type { SpillRecord, SpillStore } from "./spill.ts";
import { DEFAULT_RETENTION_POLICY } from "./retention-policy.ts";

interface SpillIndexEntry {
  offset: number;
  length: number;
  bytes: number;
}

interface NumericChunk {
  offsets: Uint32Array;
  lengths: Uint32Array;
  present: Uint8Array;
  dirty: boolean;
}

interface NumericIndex {
  id: string;
  chunks: Map<number, NumericChunk>;
  filePath?: string;
}

interface NumericLruEntry {
  index: NumericIndex;
  chunkIndex: number;
  chunk: NumericChunk;
}

type NumericLineId = { prefix: string; number: number };

const NUMERIC_CHUNK_BITS = 10;
const NUMERIC_CHUNK_SIZE = 1 << NUMERIC_CHUNK_BITS;
const NUMERIC_CHUNK_MASK = NUMERIC_CHUNK_SIZE - 1;
const NUMERIC_CHUNK_BYTES =
  NUMERIC_CHUNK_SIZE * Uint32Array.BYTES_PER_ELEMENT * 2 + NUMERIC_CHUNK_SIZE;
const MAX_UINT32 = 0xffff_ffff;
const READ_CHUNK_BYTES = 64 * 1024;

type SpillFileLine =
  | { type: "record"; record: SpillRecord }
  | { type: "delete"; streamId: StreamId; lineId: LineId };

export interface FileSpillStoreOptions {
  /** 可选：delete tombstone 超过此数量时 compact 文件。 */
  compactAfterDeletes?: number;
  /** 可选：numeric chunk index 的磁盘目录。 */
  indexPath?: string;
  /** 内存保留的 numeric chunk 数；配置 indexPath 后默认 64。 */
  indexCacheChunks?: number;
}

export class FileSpillStore implements SpillStore {
  private readonly numericIndexes = new Map<
    StreamId,
    Map<string, NumericIndex>
  >();
  private readonly fallbackIndex = new Map<string, SpillIndexEntry>();
  private readonly numericChunkLru = new Map<string, NumericLruEntry>();
  private readonly indexPath?: string;
  private readonly indexCacheChunks: number;
  private readonly compactAfterDeletes: number;
  private liveCount = 0;
  private liveBytes = 0;
  private deletes = 0;
  private size = 0;

  constructor(
    readonly path: string,
    options: FileSpillStoreOptions = {}
  ) {
    this.indexPath = options.indexPath;
    this.indexCacheChunks = this.indexPath
      ? Math.max(
          1,
          Math.floor(
            options.indexCacheChunks ??
              DEFAULT_RETENTION_POLICY.indexCacheChunks
          )
        )
      : Number.POSITIVE_INFINITY;
    this.compactAfterDeletes = Math.max(
      0,
      Math.floor(
        options.compactAfterDeletes ??
          DEFAULT_RETENTION_POLICY.compactAfterDeletes
      )
    );
    mkdirSync(dirname(path), { recursive: true });
    if (this.indexPath) mkdirSync(this.indexPath, { recursive: true });
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
      this.compactAfterDeletes > 0 &&
      this.deletes >= this.compactAfterDeletes
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

  /** 把内存中的 dirty numeric chunks 刷到磁盘。 */
  flush(): void {
    for (const indexes of this.numericIndexes.values()) {
      for (const index of indexes.values()) {
        for (const [chunkIndex, chunk] of index.chunks) {
          if (chunk.dirty) this.writeNumericChunk(index, chunkIndex, chunk);
        }
      }
    }
  }

  /**
   * 释放索引内存；`remove=true` 时删除 spill file 和 numeric index sidecar。
   * append-only 文件本身是恢复源，崩溃后由构造函数重新扫描，不依赖 dirty index。
   */
  dispose(options: { remove?: boolean } = {}): void {
    this.flush();
    if (options.remove) {
      rmSync(this.path, { force: true });
      for (const indexes of this.numericIndexes.values()) {
        for (const index of indexes.values()) {
          if (index.filePath) rmSync(index.filePath, { force: true });
        }
      }
    }
    this.numericIndexes.clear();
    this.fallbackIndex.clear();
    this.numericChunkLru.clear();
    this.liveCount = 0;
    this.liveBytes = 0;
    this.deletes = 0;
    this.size = 0;
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
    this.numericChunkLru.clear();
    if (this.indexPath) {
      rmSync(this.indexPath, { recursive: true, force: true });
      mkdirSync(this.indexPath, { recursive: true });
    }
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
      const index = this.numericIndexFor(record.streamId, numeric.prefix);
      const zeroBased = numeric.number - 1;
      const chunkIndex = Math.floor(zeroBased / NUMERIC_CHUNK_SIZE);
      const chunk = this.numericChunkFor(index, chunkIndex, true)!;
      const at = zeroBased & NUMERIC_CHUNK_MASK;
      chunk.offsets[at] = offset;
      chunk.lengths[at] = length;
      chunk.present[at] = 1;
      chunk.dirty = true;
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
    const index = this.numericIndexes
      .get(streamId)
      ?.get(numeric.prefix);
    if (!index) return undefined;
    const chunk = this.numericChunkFor(
      index,
      Math.floor(zeroBased / NUMERIC_CHUNK_SIZE),
      false
    );
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

  private numericIndexFor(
    streamId: StreamId,
    prefix: string
  ): NumericIndex {
    const indexes = this.numericIndexesFor(streamId);
    let index = indexes.get(prefix);
    if (!index) {
      index = {
        id: `${streamId}\u0000${prefix}`,
        chunks: new Map(),
        ...(this.indexPath
          ? {
              filePath: join(
                this.indexPath,
                `${encodeURIComponent(streamId)}.${encodeURIComponent(prefix)}.idx`
              ),
            }
          : {}),
      };
      indexes.set(prefix, index);
    }
    return index;
  }

  private numericChunkFor(
    index: NumericIndex,
    chunkIndex: number,
    create: boolean
  ): NumericChunk | undefined {
    const existing = index.chunks.get(chunkIndex);
    if (existing) {
      this.touchNumericChunk(index, chunkIndex, existing);
      return existing;
    }

    const loaded = this.readNumericChunk(index, chunkIndex);
    if (loaded) {
      index.chunks.set(chunkIndex, loaded);
      this.touchNumericChunk(index, chunkIndex, loaded);
      this.evictNumericChunks();
      return loaded;
    }
    if (!create) return undefined;

    const created: NumericChunk = {
      offsets: new Uint32Array(NUMERIC_CHUNK_SIZE),
      lengths: new Uint32Array(NUMERIC_CHUNK_SIZE),
      present: new Uint8Array(NUMERIC_CHUNK_SIZE),
      dirty: false,
    };
    index.chunks.set(chunkIndex, created);
    this.touchNumericChunk(index, chunkIndex, created);
    this.evictNumericChunks();
    return index.chunks.get(chunkIndex);
  }

  private touchNumericChunk(
    index: NumericIndex,
    chunkIndex: number,
    chunk: NumericChunk
  ): void {
    const key = `${index.id}\u0000${chunkIndex}`;
    this.numericChunkLru.delete(key);
    this.numericChunkLru.set(key, { index, chunkIndex, chunk });
  }

  private evictNumericChunks(): void {
    while (this.numericChunkLru.size > this.indexCacheChunks) {
      const oldest = this.numericChunkLru.entries().next().value as
        | [string, NumericLruEntry]
        | undefined;
      if (!oldest) return;
      const [key, entry] = oldest;
      if (entry.chunk.dirty) {
        this.writeNumericChunk(entry.index, entry.chunkIndex, entry.chunk);
      }
      entry.index.chunks.delete(entry.chunkIndex);
      this.numericChunkLru.delete(key);
    }
  }

  private readNumericChunk(
    index: NumericIndex,
    chunkIndex: number
  ): NumericChunk | undefined {
    if (!index.filePath || !existsSync(index.filePath)) return undefined;
    const fd = openSync(index.filePath, "r");
    try {
      const buffer = Buffer.alloc(NUMERIC_CHUNK_BYTES);
      const bytesRead = readSync(
        fd,
        buffer,
        0,
        NUMERIC_CHUNK_BYTES,
        chunkIndex * NUMERIC_CHUNK_BYTES
      );
      if (bytesRead === 0) return undefined;

      const offsets = new Uint32Array(NUMERIC_CHUNK_SIZE);
      const lengths = new Uint32Array(NUMERIC_CHUNK_SIZE);
      const offsetsBytes = NUMERIC_CHUNK_SIZE * Uint32Array.BYTES_PER_ELEMENT;
      for (let at = 0; at < NUMERIC_CHUNK_SIZE; at++) {
        const offset = at * Uint32Array.BYTES_PER_ELEMENT;
        offsets[at] = buffer.readUInt32LE(offset);
        lengths[at] = buffer.readUInt32LE(offsetsBytes + offset);
      }
      const present = new Uint8Array(
        buffer.subarray(offsetsBytes * 2, NUMERIC_CHUNK_BYTES)
      );
      return { offsets, lengths, present, dirty: false };
    } finally {
      closeSync(fd);
    }
  }

  private writeNumericChunk(
    index: NumericIndex,
    chunkIndex: number,
    chunk: NumericChunk
  ): void {
    if (!index.filePath) return;
    mkdirSync(dirname(index.filePath), { recursive: true });
    const fd = openSync(
      index.filePath,
      existsSync(index.filePath) ? "r+" : "w+"
    );
    try {
      const buffer = Buffer.alloc(NUMERIC_CHUNK_BYTES);
      const offsetsBytes = NUMERIC_CHUNK_SIZE * Uint32Array.BYTES_PER_ELEMENT;
      for (let at = 0; at < NUMERIC_CHUNK_SIZE; at++) {
        const offset = at * Uint32Array.BYTES_PER_ELEMENT;
        buffer.writeUInt32LE(chunk.offsets[at]!, offset);
        buffer.writeUInt32LE(chunk.lengths[at]!, offsetsBytes + offset);
      }
      buffer.set(chunk.present, offsetsBytes * 2);
      writeSync(
        fd,
        buffer,
        0,
        NUMERIC_CHUNK_BYTES,
        chunkIndex * NUMERIC_CHUNK_BYTES
      );
      chunk.dirty = false;
    } finally {
      closeSync(fd);
    }
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
    if (!index) return undefined;
    const chunk = this.numericChunkFor(
      index,
      Math.floor(zeroBased / NUMERIC_CHUNK_SIZE),
      false
    );
    const at = zeroBased & NUMERIC_CHUNK_MASK;
    if (!chunk || chunk.present[at] === 0) return undefined;

    chunk.present[at] = 0;
    chunk.dirty = true;
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
