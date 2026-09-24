import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  seq: number;
  at: number;
  type: string;
  pluginId?: string;
  sourceId?: string;
  sourceSeq?: number;
  prevHash?: string;
  hash?: string;
  signature?: string;
  [key: string]: unknown;
}

export type AuditEventInput = {
  type: string;
  pluginId?: string;
  at?: number;
  [key: string]: unknown;
};

export interface AuditIntegrityOptions {
  /** 启用 prevHash / hash 链。 */
  hashChain?: boolean;
  /** 启用后对 hash 做 HMAC-SHA256，并写入 signature。 */
  signatureKey?: string | Uint8Array;
  /** 已有日志续写时的起始 seq；默认 1。 */
  startSeq?: number;
  /** 已有日志续写时的 head hash。 */
  startHash?: string;
}

export interface AuditVerificationOptions {
  signatureKey?: string | Uint8Array;
  requireChain?: boolean;
}

export interface AuditVerificationResult {
  valid: boolean;
  events: number;
  headHash?: string;
  failedSeq?: number;
  error?: string;
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

export interface FileAuditLogOptions extends AuditIntegrityOptions {
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

export interface AuditAckRange {
  from: number;
  to: number;
  /** 多 source 时标识缺口所属 source；单 source ack 可省略。 */
  sourceId?: string;
}

export interface AuditAck {
  /** 已持久化的最高 seq；可确认 batch 前缀。 */
  committedSeq?: number;
  /** 已持久化的最高 hash。 */
  committedHead?: string;
  /** 接收数量；与 committedSeq/head 冲突时取最小值。 */
  accepted?: number;
  /** 显式要求重试。 */
  retry?: boolean;
  /** 接收端确认缺失的 seq 范围。 */
  missing?: readonly AuditAckRange[];
  /** 服务端建议的退避时间。 */
  retryAfterMs?: number;
}

export interface AuditSinkContext {
  /** 确定性 batch id；远端可按此幂等去重。 */
  batchId: string;
  /** 从 0 开始的尝试次数。 */
  attempt: number;
}

export interface AuditSink {
  write(
    events: readonly AuditEvent[],
    context?: AuditSinkContext
  ): void | AuditAck | Promise<void | AuditAck>;
  close?(): void | Promise<void>;
}

export interface AuditSinkFanoutOptions {
  /** 首次失败后的额外尝试次数；默认 2。 */
  maxRetries?: number;
  /** 指数退避基准；默认 50ms。 */
  retryDelayMs?: number;
  /** 单次退避上限；默认 5s。 */
  maxRetryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface AuditDeduperOptions {
  /** 最多保留的去重 key；默认 10,000。 */
  maxEntries?: number;
}

export interface AuditDeduper {
  readonly size: number;
  accept(events: readonly AuditEvent[]): readonly AuditEvent[];
  clear(): void;
}

export interface AuditGap {
  sourceId: string;
  from: number;
  to: number;
}

export interface AuditOrderResult {
  committed: readonly AuditEvent[];
  pending: readonly AuditEvent[];
  duplicates: readonly AuditEvent[];
  gaps: readonly AuditGap[];
  watermarks: Readonly<Record<string, number>>;
}

export interface AuditPendingEvent {
  event: AuditEvent;
  receivedAt: number;
}

export interface AuditOrderState {
  watermarks: Readonly<Record<string, number>>;
  pending: readonly (AuditEvent | AuditPendingEvent)[];
}

export interface AuditOrderPruneOptions {
  /** pending 最长保留时间；超时后进入 expired。 */
  pendingTtlMs?: number;
  /** pending 总量上限；超限后淘汰最旧项。 */
  maxPendingEvents?: number;
  /** 每个 source 的 pending 上限；超限后淘汰最旧项。 */
  maxPendingPerSource?: number;
  now?: () => number;
}

export interface AuditOrderOptions extends AuditOrderPruneOptions {
  getSourceId?: (event: AuditEvent) => string;
  getSourceSeq?: (event: AuditEvent) => number;
  initialWatermarks?: Readonly<Record<string, number>>;
  initialState?: AuditOrderState;
  onState?: (state: AuditOrderState) => void | Promise<void>;
}

export interface AuditOrderResult {
  committed: readonly AuditEvent[];
  pending: readonly AuditEvent[];
  duplicates: readonly AuditEvent[];
  expired: readonly AuditEvent[];
  evicted: readonly AuditEvent[];
  gaps: readonly AuditGap[];
  watermarks: Readonly<Record<string, number>>;
}

export interface AuditOrderPruneResult {
  pending: readonly AuditEvent[];
  expired: readonly AuditEvent[];
  evicted: readonly AuditEvent[];
  watermarks: Readonly<Record<string, number>>;
}

export interface AuditOrderBuffer {
  accept(events: readonly AuditEvent[]): AuditOrderResult;
  prune(): AuditOrderPruneResult;
  compact(sourceId: string): boolean;
  watermark(sourceId: string): number;
  snapshot(): Readonly<Record<string, number>>;
  snapshotState(): AuditOrderState;
  flush(): Promise<void>;
  reset(): void;
}

export interface AuditReceiverResult extends AuditOrderResult {
  ack: AuditAck;
}

export interface AuditReceiver {
  readonly buffer: AuditOrderBuffer;
  receive(events: readonly AuditEvent[]): AuditReceiverResult;
  flush(): Promise<void>;
}

export interface AuditReceiver {
  readonly buffer: AuditOrderBuffer;
  receive(events: readonly AuditEvent[]): AuditReceiverResult;
  flush(): Promise<void>;
}

export interface AuditOrderStore {
  load(): Promise<AuditOrderState | undefined>;
  save(state: AuditOrderState): Promise<void>;
}

export interface AuditOrderStoreFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface FileAuditOrderStoreOptions {
  path: string;
  fs?: AuditOrderStoreFs;
}

export interface MemoryAuditLogOptions extends AuditIntegrityOptions {
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

const defaultOrderStoreFs: AuditOrderStoreFs = {
  async readFile(path) {
    return fs.readFile(path, "utf8");
  },
  async writeFile(path, data) {
    await fs.writeFile(path, data, "utf8");
  },
  async rename(from, to) {
    await fs.rename(from, to);
  },
};

export function createMemoryAuditLog(
  options: MemoryAuditLogOptions = {}
): AuditLog {
  const now = options.now ?? (() => Date.now());
  const maxEvents = normalizeLimit(options.maxEvents ?? Number.MAX_SAFE_INTEGER);
  const integrity = normalizeIntegrity(options);
  const events: AuditEvent[] = [];
  let nextSeq = options.startSeq ?? 1;
  let lastHash = options.startHash;
  let disposed = false;

  return {
    get size() {
      return nextSeq - 1;
    },
    record(input) {
      if (disposed) throw new Error("[butui] audit log 已关闭");
      const event = withAuditIntegrity(
        {
          ...input,
          seq: nextSeq++,
          at: input.at ?? now(),
        },
        lastHash,
        integrity
      );
      if (event.hash) lastHash = event.hash;
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
  const integrity = normalizeIntegrity(options);
  const events: AuditEvent[] = [];
  let pending: AuditEvent[] = [];
  let nextSeq = options.startSeq ?? 1;
  let lastHash = options.startHash;
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
    const summary = withAuditIntegrity(
      {
        seq: nextSeq++,
        at: now(),
        type: "audit.rotated",
        path: options.path,
        rotatedPath,
        events: rotatedEvents,
        bytes: fileBytes,
      },
      lastHash,
      integrity
    );
    if (summary.hash) lastHash = summary.hash;
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
      const event = withAuditIntegrity(
        {
          ...input,
          seq: nextSeq++,
          at: input.at ?? now(),
        },
        lastHash,
        integrity
      );
      if (event.hash) lastHash = event.hash;
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
  sinks: readonly AuditSink[],
  options: AuditSinkFanoutOptions = {}
): AuditLog {
  const queues = new Map<AuditSink, AuditEvent[]>();
  for (const sink of sinks) queues.set(sink, []);
  const maxRetries = normalizeRetries(options.maxRetries ?? 2);
  const retryDelayMs = normalizeDelay(options.retryDelayMs ?? 50);
  const maxRetryDelayMs = normalizeDelay(options.maxRetryDelayMs ?? 5_000);
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  let disposed = false;
  let flushPromise: Promise<void> | undefined;

  const performFlush = async (): Promise<void> => {
    const errors: Error[] = [];
    for (const [sink, queue] of queues) {
      let attempt = 0;
      let lastError: Error | undefined;
      while (queue.length > 0) {
        const batch = [...queue];
        let ack: AuditAck | void;
        try {
          ack = await sink.write(batch, {
            batchId: createAuditBatchId(batch),
            attempt,
          });
        } catch (error) {
          lastError = asError(error);
          if (attempt < maxRetries) {
            await sleep(backoffDelay(retryDelayMs, maxRetryDelayMs, attempt));
            attempt++;
            continue;
          }
          break;
        }

        const committed =
          ack?.retry && !hasAckCommit(ack)
            ? 0
            : resolveAckCount(ack, batch);
        if (committed > 0) queue.splice(0, committed);
        if (
          queue.length === 0 &&
          !ack?.retry &&
          !(ack?.missing && ack.missing.length > 0)
        ) {
          lastError = undefined;
          break;
        }
        lastError = new Error(
          `[butui] audit sink acknowledged ${committed}/${batch.length} events`
        );
        if (attempt < maxRetries) {
          await sleep(
            ack?.retryAfterMs ??
              backoffDelay(retryDelayMs, maxRetryDelayMs, attempt)
          );
          attempt++;
          continue;
        }
        break;
      }
      if (queue.length > 0) {
        errors.push(lastError ?? new Error("audit sink failed"));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "[butui] audit sink flush failed");
    }
  };

  const flushSinks = (): Promise<void> => {
    if (flushPromise) return flushPromise;
    flushPromise = performFlush().finally(() => {
      flushPromise = undefined;
    });
    return flushPromise;
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
    async write(events, context) {
      if (events.length === 0) return;
      const batchId = context?.batchId ?? createAuditBatchId(events);
      const first = events[0]!;
      const last = events[events.length - 1]!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson",
            "x-butui-audit-batch": batchId,
            "x-butui-audit-count": String(events.length),
            "x-butui-audit-first-seq": String(first.seq),
            ...(last.hash ? { "x-butui-audit-head": last.hash } : {}),
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
        const text = await response.text();
        if (!text.trim()) {
          return {
            accepted: events.length,
            committedSeq: last.seq,
            ...(last.hash ? { committedHead: last.hash } : {}),
          };
        }
        const value: unknown = JSON.parse(text);
        if (!isAuditAck(value)) {
          throw new Error("[butui] audit sink returned invalid ack");
        }
        return value;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createAuditBatchId(events: readonly AuditEvent[]): string {
  if (events.length === 0) return "empty";
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const digest = createHash("sha256")
    .update(serializeAudit(events))
    .digest("hex")
    .slice(0, 16);
  return `${first.seq}-${last.seq}-${digest}`;
}

export function createAuditDeduper(
  options: AuditDeduperOptions = {}
): AuditDeduper {
  const maxEntries = normalizeLimit(options.maxEntries ?? 10_000);
  const seen = new Map<string, true>();

  return {
    get size() {
      return seen.size;
    },
    accept(events) {
      const accepted: AuditEvent[] = [];
      for (const event of events) {
        const key = auditDedupeKey(event);
        if (seen.has(key)) continue;
        seen.set(key, true);
        if (seen.size > maxEntries) {
          const oldest = seen.keys().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        accepted.push(event);
      }
      return accepted;
    },
    clear() {
      seen.clear();
    },
  };
}

export function createAuditOrderBuffer(
  options: AuditOrderOptions = {}
): AuditOrderBuffer {
  const getSourceId = options.getSourceId ?? defaultAuditSourceId;
  const getSourceSeq = options.getSourceSeq ?? defaultAuditSourceSeq;
  const now = options.now ?? (() => Date.now());
  const pendingTtlMs = normalizeOptionalCount(options.pendingTtlMs);
  const maxPendingEvents = normalizeOptionalCount(options.maxPendingEvents);
  const maxPendingPerSource = normalizeOptionalCount(
    options.maxPendingPerSource
  );
  const initial = new Map<string, number>();
  for (const [sourceId, seq] of Object.entries(
    options.initialState?.watermarks ?? options.initialWatermarks ?? {}
  )) {
    initial.set(sourceId, normalizeWatermark(seq));
  }
  const watermarks = new Map(initial);
  const pending = new Map<string, Map<number, AuditPendingEvent>>();
  let persistChain: Promise<void> = Promise.resolve();

  for (const raw of options.initialState?.pending ?? []) {
    const entry = isAuditPendingEvent(raw)
      ? raw
      : { event: raw, receivedAt: now() };
    const sourceId = getSourceId(entry.event);
    const sourceSeq = normalizeSourceSeq(getSourceSeq(entry.event));
    if (sourceSeq <= (watermarks.get(sourceId) ?? 0)) continue;
    let queue = pending.get(sourceId);
    if (!queue) {
      queue = new Map();
      pending.set(sourceId, queue);
    }
    queue.set(sourceSeq, entry);
  }

  const snapshotState = (): AuditOrderState => ({
    watermarks: Object.fromEntries(watermarks),
    pending: [...pending.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, queue]) =>
        [...queue.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, entry]) => entry)
      ),
  });

  const persist = (): void => {
    if (!options.onState) return;
    const state = snapshotState();
    persistChain = persistChain
      .catch(() => {})
      .then(() => options.onState!(state));
  };

  const pruneInternal = (
    persistAfter: boolean
  ): { result: AuditOrderPruneResult; changed: boolean } => {
    const timestamp = now();
    const expired: AuditEvent[] = [];
    const evicted: AuditEvent[] = [];
    let changed = false;

    if (pendingTtlMs !== undefined) {
      for (const [sourceId, queue] of pending) {
        for (const [seq, entry] of queue) {
          if (timestamp - entry.receivedAt <= pendingTtlMs) continue;
          queue.delete(seq);
          expired.push(entry.event);
          changed = true;
        }
        if (queue.size === 0) pending.delete(sourceId);
      }
    }

    if (maxPendingPerSource !== undefined) {
      for (const [sourceId, queue] of pending) {
        const overflow = queue.size - maxPendingPerSource;
        if (overflow <= 0) continue;
        const oldest = [...queue.entries()]
          .sort(([, left], [, right]) => left.receivedAt - right.receivedAt)
          .slice(0, overflow);
        for (const [seq, entry] of oldest) {
          queue.delete(seq);
          evicted.push(entry.event);
        }
        changed = true;
        if (queue.size === 0) pending.delete(sourceId);
      }
    }

    if (maxPendingEvents !== undefined) {
      const all = [...pending.entries()].flatMap(([sourceId, queue]) =>
        [...queue.entries()].map(([seq, entry]) => ({
          sourceId,
          seq,
          entry,
        }))
      );
      const overflow = all.length - maxPendingEvents;
      if (overflow > 0) {
        const oldest = all
          .sort((left, right) => left.entry.receivedAt - right.entry.receivedAt)
          .slice(0, overflow);
        for (const item of oldest) {
          pending.get(item.sourceId)?.delete(item.seq);
          evicted.push(item.entry.event);
        }
        for (const [sourceId, queue] of pending) {
          if (queue.size === 0) pending.delete(sourceId);
        }
        changed = true;
      }
    }

    for (const [sourceId, watermark] of watermarks) {
      if (watermark === 0 && !pending.has(sourceId)) {
        watermarks.delete(sourceId);
        changed = true;
      }
    }

    if (changed && persistAfter) persist();
    return {
      result: {
        pending: [...pending.values()].flatMap(queue =>
          [...queue.values()].map(entry => entry.event)
        ),
        expired,
        evicted,
        watermarks: Object.fromEntries(watermarks),
      },
      changed,
    };
  };

  const accept = (events: readonly AuditEvent[]): AuditOrderResult => {
    const committed: AuditEvent[] = [];
    const duplicates: AuditEvent[] = [];
    const timestamp = now();
    for (const event of events) {
      const sourceId = getSourceId(event);
      const sourceSeq = normalizeSourceSeq(getSourceSeq(event));
      const watermark = watermarks.get(sourceId) ?? 0;
      if (sourceSeq <= watermark) {
        duplicates.push(event);
        continue;
      }
      let queue = pending.get(sourceId);
      if (!queue) {
        queue = new Map();
        pending.set(sourceId, queue);
      }
      if (queue.has(sourceSeq)) {
        duplicates.push(event);
        continue;
      }
      queue.set(sourceSeq, { event, receivedAt: timestamp });
      let next = (watermarks.get(sourceId) ?? 0) + 1;
      while (queue.has(next)) {
        committed.push(queue.get(next)!.event);
        queue.delete(next);
        next++;
      }
      watermarks.set(sourceId, next - 1);
      if (queue.size === 0) pending.delete(sourceId);
    }

    const cleanup = pruneInternal(false);
    const gaps: AuditGap[] = [];
    for (const [sourceId, queue] of pending) {
      const watermark = watermarks.get(sourceId) ?? 0;
      let cursor = watermark + 1;
      for (const seq of [...queue.keys()].sort((left, right) => left - right)) {
        if (seq > cursor) gaps.push({ sourceId, from: cursor, to: seq - 1 });
        cursor = seq + 1;
      }
    }
    persist();
    return {
      committed,
      pending: cleanup.result.pending,
      duplicates,
      expired: cleanup.result.expired,
      evicted: cleanup.result.evicted,
      gaps,
      watermarks: Object.fromEntries(watermarks),
    };
  };

  return {
    accept,
    prune() {
      const cleanup = pruneInternal(true);
      return cleanup.result;
    },
    compact(sourceId) {
      const queue = pending.get(sourceId);
      if (queue && queue.size > 0) return false;
      if (!watermarks.has(sourceId)) return false;
      watermarks.delete(sourceId);
      persist();
      return true;
    },
    watermark(sourceId) {
      return watermarks.get(sourceId) ?? 0;
    },
    snapshot() {
      return Object.fromEntries(watermarks);
    },
    snapshotState,
    flush() {
      return persistChain;
    },
    reset() {
      watermarks.clear();
      for (const [sourceId, seq] of initial) watermarks.set(sourceId, seq);
      pending.clear();
      persist();
    },
  };
}

export function createAuditReceiver(
  options: AuditOrderOptions = {}
): AuditReceiver {
  const getSourceId = options.getSourceId ?? defaultAuditSourceId;
  const buffer = createAuditOrderBuffer(options);
  return {
    buffer,
    receive(events) {
      const result = buffer.accept(events);
      const sources = new Set(result.committed.map(getSourceId));
      const last = result.committed[result.committed.length - 1];
      const ack: AuditAck = {
        accepted: result.committed.length,
        ...(result.gaps.length > 0
          ? { retry: true, missing: result.gaps }
          : {}),
        ...(last && sources.size <= 1
          ? {
              committedSeq: last.seq,
              ...(last.hash ? { committedHead: last.hash } : {}),
            }
          : {}),
      };
      return { ...result, ack };
    },
    flush() {
      return buffer.flush();
    },
  };
}

export function createFileAuditOrderStore(
  options: FileAuditOrderStoreOptions
): AuditOrderStore {
  const io = options.fs ?? defaultOrderStoreFs;
  let version = 0;
  return {
    async load() {
      let text: string;
      try {
        text = await io.readFile(options.path);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      const value: unknown = JSON.parse(text);
      if (!isAuditOrderState(value)) {
        throw new Error("[butui] invalid audit order state");
      }
      return value;
    },
    async save(state) {
      const temporary = `${options.path}.tmp-${process.pid}-${++version}`;
      await io.writeFile(temporary, JSON.stringify(state));
      await io.rename(temporary, options.path);
    },
  };
}

export async function openPersistentAuditReceiver(
  options: AuditOrderOptions & { store: AuditOrderStore }
): Promise<AuditReceiver> {
  const state = await options.store.load();
  return createAuditReceiver({
    ...options,
    ...(state ? { initialState: state } : {}),
    onState: async next => {
      await options.store.save(next);
      await options.onState?.(next);
    },
  });
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

export function verifyAuditEvents(
  events: readonly AuditEvent[],
  options: AuditVerificationOptions = {}
): AuditVerificationResult {
  const requireChain =
    options.requireChain ?? events.some(event => event.hash !== undefined);
  let previousHash = "";
  let expectedSeq = events[0]?.seq ?? 1;
  let processed = 0;

  for (const event of events) {
    if (event.seq !== expectedSeq) {
      return invalidAudit(event.seq, `expected seq ${expectedSeq}`, processed);
    }
    expectedSeq++;
    if (!requireChain) {
      processed++;
      continue;
    }
    if (!event.hash) {
      return invalidAudit(event.seq, "missing hash", processed);
    }
    if ((event.prevHash ?? "") !== previousHash) {
      return invalidAudit(event.seq, "prevHash mismatch", processed);
    }
    const expected = computeAuditDigest(
      withoutIntegrityFields(event),
      options.signatureKey
    );
    if (expected.hash !== event.hash) {
      return invalidAudit(event.seq, "hash mismatch", processed);
    }
    if (
      options.signatureKey !== undefined &&
      expected.signature !== event.signature
    ) {
      return invalidAudit(event.seq, "signature mismatch", processed);
    }
    previousHash = event.hash;
    processed++;
  }

  return {
    valid: true,
    events: events.length,
    ...(previousHash ? { headHash: previousHash } : {}),
  };
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

function normalizeRetries(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("[butui] maxRetries must be a non-negative number");
  }
  return Math.floor(value);
}

function normalizeDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("[butui] retry delay must be a non-negative number");
  }
  return Math.floor(value);
}

function auditDedupeKey(event: AuditEvent): string {
  const identity =
    event.hash ??
    createHash("sha256")
      .update(stableStringify(withoutIntegrityFields(event)))
      .digest("hex");
  return `${event.seq}:${identity}`;
}

function defaultAuditSourceId(event: AuditEvent): string {
  if (event.sourceId) return event.sourceId;
  if (event.pluginId) return `plugin:${event.pluginId}`;
  return "default";
}

function defaultAuditSourceSeq(event: AuditEvent): number {
  return event.sourceSeq ?? event.seq;
}

function normalizeSourceSeq(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("[butui] audit source seq must be a positive safe integer");
  }
  return value;
}

function normalizeWatermark(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("[butui] audit watermark must be a non-negative safe integer");
  }
  return value;
}

function backoffDelay(
  baseMs: number,
  maxMs: number,
  attempt: number
): number {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

function hasAckCommit(ack: AuditAck): boolean {
  return (
    ack.accepted !== undefined ||
    ack.committedSeq !== undefined ||
    ack.committedHead !== undefined
  );
}

function resolveAckCount(
  ack: AuditAck | void,
  batch: readonly AuditEvent[]
): number {  if (!ack) return batch.length;
  let committed = batch.length;
  if (ack.accepted !== undefined) {
    committed = Math.min(committed, ack.accepted);
  }
  if (ack.committedSeq !== undefined) {
    const count = batch.filter(event => event.seq <= ack.committedSeq!).length;
    committed = Math.min(committed, count);
  }
  if (ack.committedHead !== undefined) {
    let count = 0;
    for (const event of batch) {
      if (event.hash === ack.committedHead) {
        count = batch.indexOf(event) + 1;
        break;
      }
    }
    committed = Math.min(committed, count);
  }
  if (ack.missing) {
    const firstMissing = batch.findIndex(event =>
      ack.missing!.some(range => event.seq >= range.from && event.seq <= range.to)
    );
    if (firstMissing >= 0) committed = Math.min(committed, firstMissing);
  }
  return Math.max(0, committed);
}

function isAuditAck(value: unknown): value is AuditAck {
  if (!isRecord(value)) return false;
  const committedSeq = value.committedSeq;
  if (
    committedSeq !== undefined &&
    (typeof committedSeq !== "number" ||
      !Number.isSafeInteger(committedSeq) ||
      committedSeq < 0)
  ) {
    return false;
  }
  if (
    value.committedHead !== undefined &&
    typeof value.committedHead !== "string"
  ) {
    return false;
  }
  const accepted = value.accepted;
  if (
    accepted !== undefined &&
    (typeof accepted !== "number" ||
      !Number.isSafeInteger(accepted) ||
      accepted < 0)
  ) {
    return false;
  }
  if (value.retry !== undefined && typeof value.retry !== "boolean") {
    return false;
  }
  const retryAfterMs = value.retryAfterMs;
  if (
    retryAfterMs !== undefined &&
    (typeof retryAfterMs !== "number" ||
      !Number.isFinite(retryAfterMs) ||
      retryAfterMs < 0)
  ) {
    return false;
  }
  if (value.missing !== undefined) {
    if (!Array.isArray(value.missing)) return false;
    for (const range of value.missing) {
      if (!isRecord(range)) return false;
      const from = range.from;
      const to = range.to;
      if (
        typeof from !== "number" ||
        typeof to !== "number" ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from < 0 ||
        to < from ||
        (range.sourceId !== undefined && typeof range.sourceId !== "string")
      ) {
        return false;
      }
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAuditOrderState(value: unknown): value is AuditOrderState {
  if (!isRecord(value) || !isRecord(value.watermarks)) return false;
  if (!Array.isArray(value.pending)) return false;
  for (const seq of Object.values(value.watermarks)) {
    if (!Number.isSafeInteger(seq) || (seq as number) < 0) return false;
  }
  return value.pending.every(
    item => isAuditEvent(item) || isAuditPendingEvent(item)
  );
}

function isAuditPendingEvent(value: unknown): value is AuditPendingEvent {
  return (
    isRecord(value) &&
    isAuditEvent(value.event) &&
    typeof value.receivedAt === "number" &&
    Number.isFinite(value.receivedAt)
  );
}

function normalizeOptionalCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("[butui] audit order limit must be a non-negative number");
  }
  return Math.floor(value);
}

function isNotFound(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.code === "ENOENT" || value.code === "ENOTDIR")
  );
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

function normalizeIntegrity(
  options: AuditIntegrityOptions
): AuditIntegrityOptions {
  return {
    hashChain: options.hashChain === true || options.signatureKey !== undefined,
    ...(options.signatureKey !== undefined
      ? { signatureKey: options.signatureKey }
      : {}),
  };
}

function withAuditIntegrity(
  event: AuditEvent,
  previousHash: string | undefined,
  integrity: AuditIntegrityOptions
): AuditEvent {
  if (!integrity.hashChain) return event;
  const chained: AuditEvent = {
    ...event,
    prevHash: previousHash ?? "",
  };
  const digest = computeAuditDigest(chained, integrity.signatureKey);
  return {
    ...chained,
    hash: digest.hash,
    ...(digest.signature ? { signature: digest.signature } : {}),
  };
}

function computeAuditDigest(
  event: AuditEvent,
  signatureKey: string | Uint8Array | undefined
): { hash: string; signature?: string } {
  const hash = createHash("sha256")
    .update(stableStringify(event))
    .digest("hex");
  return {
    hash,
    ...(signatureKey !== undefined
      ? {
          signature: createHmac("sha256", signatureKey)
            .update(hash)
            .digest("hex"),
        }
      : {}),
  };
}

function withoutIntegrityFields(event: AuditEvent): AuditEvent {
  const { hash: _hash, signature: _signature, ...rest } = event;
  return rest;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function invalidAudit(
  failedSeq: number,
  error: string,
  events: number
): AuditVerificationResult {
  return {
    valid: false,
    events,
    failedSeq,
    error,
  };
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
