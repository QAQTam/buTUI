/**
 * FileSpillStore —— append-only NDJSON cold storage。
 *
 * 文件格式：
 *   {"type":"record","record":{...}}
 *   {"type":"delete","streamId":"...","lineId":"..."}
 *
 * 内存只保留 key → file offset 索引；read 使用 pread 读取目标记录，不把整个
 * spill 文件重新加载进内存。
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LineId, StreamId } from "./ledger.ts";
import type { SpillRecord, SpillStore } from "./spill.ts";

interface SpillIndexEntry {
  offset: number;
  length: number;
  bytes: number;
}

type SpillFileLine =
  | { type: "record"; record: SpillRecord }
  | { type: "delete"; streamId: StreamId; lineId: LineId };

export interface FileSpillStoreOptions {
  /** 可选：delete tombstone 超过此数量时 compact 文件。 */
  compactAfterDeletes?: number;
}

export class FileSpillStore implements SpillStore {
  private readonly index = new Map<string, SpillIndexEntry>();
  private readonly liveBytes = new Map<string, number>();
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
    const line = `${JSON.stringify({ type: "record", record } satisfies SpillFileLine)}\n`;
    const offset = this.size;
    appendFileSync(this.path, line, "utf8");
    this.size += Buffer.byteLength(line);
    const key = spillKey(record.streamId, record.lineId);
    this.index.set(key, {
      offset,
      length: Buffer.byteLength(line),
      bytes: record.bytes,
    });
    this.liveBytes.set(key, record.bytes);
  }

  read(streamId: StreamId, lineId: LineId): SpillRecord | undefined {
    const key = spillKey(streamId, lineId);
    const entry = this.index.get(key);
    if (!entry) return undefined;

    const buffer = Buffer.alloc(entry.length);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buffer, 0, entry.length, entry.offset);
    } finally {
      closeSync(fd);
    }
    const parsed = JSON.parse(buffer.toString("utf8")) as SpillFileLine;
    return parsed.type === "record" ? parsed.record : undefined;
  }

  delete(streamId: StreamId, lineId: LineId): void {
    const key = spillKey(streamId, lineId);
    if (!this.index.has(key)) return;
    const line = `${JSON.stringify({
      type: "delete",
      streamId,
      lineId,
    } satisfies SpillFileLine)}\n`;
    appendFileSync(this.path, line, "utf8");
    this.size += Buffer.byteLength(line);
    this.index.delete(key);
    this.liveBytes.delete(key);
    this.deletes++;
    if (
      this.options.compactAfterDeletes !== undefined &&
      this.deletes >= this.options.compactAfterDeletes
    ) {
      this.compact();
    }
  }

  stats(): { records: number; bytes: number; fileBytes: number; deletes: number } {
    let bytes = 0;
    for (const value of this.liveBytes.values()) bytes += value;
    return {
      records: this.index.size,
      bytes,
      fileBytes: this.size,
      deletes: this.deletes,
    };
  }

  /** 重写文件，只保留当前 live records。 */
  compact(): void {
    const records = [...this.index.keys()]
      .map(key => this.readByKey(key))
      .filter((record): record is SpillRecord => record !== undefined);
    rmSync(this.path, { force: true });
    this.index.clear();
    this.liveBytes.clear();
    this.deletes = 0;
    this.size = 0;
    for (const record of records) this.write(record);
  }

  private rebuildIndex(): void {
    const content = readFileSync(this.path);
    let offset = 0;
    while (offset < content.length) {
      const newline = content.indexOf(0x0a, offset);
      if (newline === -1) break;
      const length = newline - offset + 1;
      const line = content.subarray(offset, newline).toString("utf8");
      const parsed = JSON.parse(line) as SpillFileLine;
      if (parsed.type === "record") {
        const key = spillKey(parsed.record.streamId, parsed.record.lineId);
        this.index.set(key, {
          offset,
          length,
          bytes: parsed.record.bytes,
        });
        this.liveBytes.set(key, parsed.record.bytes);
      } else {
        const key = spillKey(parsed.streamId, parsed.lineId);
        this.index.delete(key);
        this.liveBytes.delete(key);
        this.deletes++;
      }
      offset += length;
    }
    this.size = statSync(this.path).size;
  }

  private readByKey(key: string): SpillRecord | undefined {
    const entry = this.index.get(key);
    if (!entry) return undefined;
    const buffer = Buffer.alloc(entry.length);
    const fd = openSync(this.path, "r");
    try {
      readSync(fd, buffer, 0, entry.length, entry.offset);
    } finally {
      closeSync(fd);
    }
    const parsed = JSON.parse(buffer.toString("utf8")) as SpillFileLine;
    return parsed.type === "record" ? parsed.record : undefined;
  }
}

function spillKey(streamId: StreamId, lineId: LineId): string {
  return `${streamId}\u0000${lineId}`;
}
