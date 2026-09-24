import fs from "node:fs/promises";

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
}

export interface FileAuditLogOptions {
  path: string;
  now?: () => number;
  /** 内存中保留的最新事件数；默认 1,000。完整历史从文件查询。 */
  maxMemoryEvents?: number;
  fs?: AuditFs;
}

export interface MemoryAuditLogOptions {
  now?: () => number;
  maxEvents?: number;
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
  const events: AuditEvent[] = [];
  let pending: AuditEvent[] = [];
  let nextSeq = 1;
  let scheduled = false;
  let disposed = false;
  let writeChain: Promise<void> = Promise.resolve();

  const flush = async (): Promise<void> => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) {
      await writeChain;
      return;
    }
    const data = batch.map(event => `${JSON.stringify(event)}\n`).join("");
    writeChain = writeChain
      .catch(() => {})
      .then(() => io.appendFile(options.path, data))
      .catch(error => {
        pending = [...batch, ...pending];
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

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
