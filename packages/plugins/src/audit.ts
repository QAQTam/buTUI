import fs from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  seq: number;
  at: number;
  type: string;
  pluginId?: string;
  [key: string]: unknown;
}

export interface AuditEventInput {
  type: string;
  pluginId?: string;
  at?: number;
  [key: string]: unknown;
}

export interface AuditQuery {
  type?: string | readonly string[];
  pluginId?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface AuditLog {
  readonly size: number;
  record(event: AuditEventInput): AuditEvent;
  query(query?: AuditQuery): readonly AuditEvent[];
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AuditFs {
  appendFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  stat?(path: string): Promise<{ size: number }>;
  rename?(from: string, to: string): Promise<void>;
  readdir?(path: string): Promise<string[]>;
  rm?(path: string): Promise<void>;
}

export interface FileAuditLogOptions {
  path: string;
  now?: () => number;
  /** 内存中保留的最新事件数；默认 1,000。完整历史从文件查询。 */
  maxMemoryEvents?: number;
  /** 达到该字节数后滚动文件；不传表示不滚动。 */
  maxFileBytes?: number;
  /** 保留的 rotated 文件数；默认 5。 */
  retainedFiles?: number;
  onRotate?: (summary: AuditRotationSummary) => void;
  fs?: AuditFs;
}

export interface AuditRotationSummary {
  path: string;
  rotatedPath: string;
  events: number;
  bytes: number;
  at: number;
}

export interface AuditSink {
  write(events: readonly AuditEvent[]): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface MemoryAuditLogOptions {
  now?: () => number;
  maxEvents?: number;
}

export type AuditFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface HttpAuditSinkOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: AuditFetch;
}

export interface ReadAuditLogOptions extends AuditQuery {
  fs?: AuditFs;
}

const defaultFs: AuditFs = {
  async appendFile(path, data) {
    await fs.appendFile(path, data, "utf8");
  },
  async readFile(path) {
    return fs.readFile(path, "utf8");
  },
  async stat(path) {
    const value = await fs.stat(path);
    return { size: value.size };
  },
  async rename(from, to) {
    await fs.rename(from, to);
  },
  async readdir(path) {
    return fs.readdir(path);
  },
  async rm(path) {
    await fs.rm(path, { force: true });
  },
};

export function createMemoryAuditLog(
  options: MemoryAuditLogOptions = {}
): AuditLog {
  const now = options.now ?? (() => Date.now());
  const maxEvents = normalizeLimit(options.maxEvents ?? Number.MAX_SAFE_INTEGER);
  const events: AuditEvent[] = [];
  let nextSeq = 1;
  let disposed = false;

  return {
    get size() {
      return nextSeq - 1;
    },
    record(input) {
      if (disposed) throw new Error("[butui] audit log 已关闭");
      const event: AuditEvent = {
        ...input,
        seq: nextSeq++,
        at: input.at ?? now(),
      };
      events.push(event);
      if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
      return event;
    },
    query(query) {
      return queryAuditEvents(events, query);
    },
    async flush() {},
    async dispose() {
      disposed = true;
    },
  };
}

export function createFileAuditLog(
  options: FileAuditLogOptions
): AuditLog {
  const now = options.now ?? (() => Date.now());
  const io = options.fs ?? defaultFs;
  const maxMemoryEvents = normalizeLimit(options.maxMemoryEvents ?? 1_000);
  const maxFileBytes = normalizeOptionalLimit(options.maxFileBytes);
  const retainedFiles = normalizeRetention(options.retainedFiles ?? 5);
  const events: AuditEvent[] = [];
  let pending: AuditEvent[] = [];
  let nextSeq = 1;
  let scheduled = false;
  let disposed = false;
  let writeChain: Promise<void> = Promise.resolve();
  let fileBytes = 0;
  let fileBytesInitialized = false;
  let rotations = 0;

  const initializeFileBytes = async (): Promise<void> => {
    if (fileBytesInitialized) return;
    fileBytesInitialized = true;
    try {
      if (io.stat) {
        fileBytes = (await io.stat(options.path)).size;
      } else {
        fileBytes = byteLength(await io.readFile(options.path));
      }
    } catch {
      fileBytes = 0;
    }
  };

  const rotate = async (): Promise<AuditEvent> => {
    if (!io.rename || !io.readdir || !io.rm) {
      throw new Error(
        "[butui] audit fs must provide rename / readdir / rm for rotation"
      );
    }
    const rotatedPath = `${options.path}.${now()}-${++rotations}.ndjson`;
    await io.rename(options.path, rotatedPath);
    let rotatedEvents = 0;
    try {
      rotatedEvents = countAuditLines(await io.readFile(rotatedPath));
    } catch {
      // summary 可退化；rotation 本身已经成功。
    }
    const summary: AuditEvent = {
      seq: nextSeq++,
      at: now(),
      type: "audit.rotated",
      path: options.path,
      rotatedPath,
      events: rotatedEvents,
      bytes: fileBytes,
    };
    events.push(summary);
    if (events.length > maxMemoryEvents) {
      events.splice(0, events.length - maxMemoryEvents);
    }
    try {
      options.onRotate?.({
        path: options.path,
        rotatedPath,
        events: rotatedEvents,
        bytes: fileBytes,
        at: summary.at,
      });
    } catch {
      // rotation 已完成；诊断 callback 不能回滚文件操作。
    }
    await pruneRotatedFiles(io, options.path, retainedFiles);
    fileBytes = 0;
    return summary;
  };

  const flush = async (): Promise<void> => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) {
      await writeChain;
      return;
    }
    let attempted = batch;
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await initializeFileBytes();
        let output = batch;
        if (
          maxFileBytes !== undefined &&
          fileBytes > 0 &&
          fileBytes + byteLength(serializeAudit(batch)) > maxFileBytes
        ) {
          output = [...batch, await rotate()];
        }
        attempted = output;
        const data = serializeAudit(output);
        await io.appendFile(options.path, data);
        fileBytes += byteLength(data);
      })
      .catch(error => {
        pending = [...attempted, ...pending];
        throw error;
      });
    await writeChain;
  };

  const scheduleFlush = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void flush().catch(() => {});
    });
  };

  return {
    get size() {
      return nextSeq - 1;
    },
    record(input) {
      if (disposed) throw new Error("[butui] audit log 已关闭");
      const event: AuditEvent = {
        ...input,
        seq: nextSeq++,
        at: input.at ?? now(),
      };
      events.push(event);
      if (events.length > maxMemoryEvents) {
        events.splice(0, events.length - maxMemoryEvents);
      }
      pending.push(event);
      scheduleFlush();
      return event;
    },
    query(query) {
      return queryAuditEvents(events, query);
    },
    flush,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await flush();
    },
  };
}

export function withAuditSinks(
  log: AuditLog,
  sinks: readonly AuditSink[]
): AuditLog {
  const queues = new Map<AuditSink, AuditEvent[]>();
  for (const sink of sinks) queues.set(sink, []);
  let disposed = false;

  const flushSinks = async (): Promise<void> => {
    const errors: Error[] = [];
    for (const [sink, queue] of queues) {
      if (queue.length === 0) continue;
      const batch = [...queue];
      try {
        await sink.write(batch);
        queue.splice(0, batch.length);
      } catch (error) {
        errors.push(asError(error));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "[butui] audit sink flush failed");
    }
  };

  return {
    get size() {
      return log.size;
    },
    record(input) {
      if (disposed) throw new Error("[butui] audit log 已关闭");
      const event = log.record(input);
      for (const queue of queues.values()) queue.push(event);
      return event;
    },
    query(query) {
      return log.query(query);
    },
    async flush() {
      const errors: Error[] = [];
      try {
        await log.flush();
      } catch (error) {
        errors.push(asError(error));
      }
      try {
        await flushSinks();
      } catch (error) {
        errors.push(asError(error));
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "[butui] audit flush failed");
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const errors: Error[] = [];
      try {
        await log.dispose();
      } catch (error) {
        errors.push(asError(error));
      }
      try {
        await flushSinks();
      } catch (error) {
        errors.push(asError(error));
      }
      for (const sink of queues.keys()) {
        try {
          await sink.close?.();
        } catch (error) {
          errors.push(asError(error));
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "[butui] audit sink dispose failed");
      }
    },
  };
}

export function createHttpAuditSink(
  options: HttpAuditSinkOptions
): AuditSink {
  const request = options.fetch ?? fetch;
  const timeoutMs = normalizeOptionalLimit(options.timeoutMs) ?? 5_000;
  return {
    async write(events) {
      if (events.length === 0) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson",
            ...options.headers,
          },
          body: serializeAudit(events),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            `[butui] audit sink returned ${response.status} ${response.statusText}`
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function readAuditLog(
  path: string,
  options: ReadAuditLogOptions = {}
): Promise<readonly AuditEvent[]> {
  const io = options.fs ?? defaultFs;
  const text = await io.readFile(path);
  const events: AuditEvent[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `[butui] invalid audit JSON at line ${index + 1}: ${asError(error).message}`
      );
    }
    if (!isAuditEvent(value)) {
      throw new Error(`[butui] invalid audit event at line ${index + 1}`);
    }
    events.push(value);
  }
  return queryAuditEvents(events, options);
}

export function queryAuditEvents(
  events: readonly AuditEvent[],
  query: AuditQuery = {}
): readonly AuditEvent[] {
  const types =
    query.type === undefined
      ? undefined
      : new Set(typeof query.type === "string" ? [query.type] : query.type);
  const limit = query.limit === undefined ? undefined : normalizeLimit(query.limit);
  const result: AuditEvent[] = [];
  for (const event of events) {
    if (types && !types.has(event.type)) continue;
    if (query.pluginId !== undefined && event.pluginId !== query.pluginId) continue;
    if (query.since !== undefined && event.at < query.since) continue;
    if (query.until !== undefined && event.at > query.until) continue;
    result.push(event);
    if (limit !== undefined && result.length >= limit) break;
  }
  return result;
}

export function safeRecordAudit(
  audit: AuditLog | undefined,
  event: AuditEventInput
): void {
  try {
    audit?.record(event);
  } catch {
    // 审计失败不能反向破坏受审计操作本身。
  }
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as { seq?: unknown }).seq) &&
    typeof (value as { at?: unknown }).at === "number" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(value));
}

function normalizeOptionalLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("[butui] audit limit must be a positive finite number");
  }
  return Math.floor(value);
}

function normalizeRetention(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("[butui] retainedFiles must be a non-negative number");
  }
  return Math.floor(value);
}

function serializeAudit(events: readonly AuditEvent[]): string {
  return events.map(event => `${JSON.stringify(event)}\n`).join("");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function countAuditLines(value: string): number {
  let count = 0;
  for (const line of value.split("\n")) {
    if (line) count++;
  }
  return count;
}

async function pruneRotatedFiles(
  io: AuditFs,
  filePath: string,
  retainedFiles: number
): Promise<void> {
  if (!io.readdir || !io.rm) return;
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  const entries = (await io.readdir(dir))
    .filter(entry => entry.startsWith(prefix) && entry.endsWith(".ndjson"))
    .sort();
  const remove = entries.slice(0, Math.max(0, entries.length - retainedFiles));
  for (const entry of remove) {
    await io.rm(path.join(dir, entry));
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
