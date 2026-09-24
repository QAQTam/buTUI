/**
 * StreamSource → StreamLedger adapter。
 *
 * v0.1 的 StreamSource 继续负责增量折行和 Solid 更新；ledger 作为并行的权威
 * 事件日志记录 append / finish。这样现有组件不需要重写，又能逐步获得 revision、
 * gap / conflict、replace-tail 和 cancel 语义。
 */
import {
  StreamLedger,
  type StreamApplyResult,
  type StreamEnvelope,
  type StreamKind,
  type StreamPriority,
  type StreamProjection,
  type TailAnchor,
} from "./ledger.ts";
import type { StreamSource } from "./source.ts";

export interface ReplaceableStreamSource extends StreamSource {
  /** 可选扩展；不支持时 adapter 不会假装已经改写画面。 */
  replaceTail?(from: TailAnchor | null, text: string): void;
  /** 可选扩展；不支持时 adapter 不会假装已经取消。 */
  cancel?(reason: string): void;
}

export interface LedgerStreamAdapterOptions {
  sessionId?: string;
  streamId?: string;
  kind?: StreamKind;
  priority?: StreamPriority;
  ledger?: StreamLedger;
  createdAt?: number;
}

export interface LedgerStreamAdapter extends StreamSource {
  readonly ledger: StreamLedger;
  projection(): StreamProjection;
  replaceTail(from: TailAnchor | null, text: string): StreamApplyResult;
  cancel(reason: string): StreamApplyResult;
}

export function createLedgerAdapter(
  source: ReplaceableStreamSource,
  options: LedgerStreamAdapterOptions = {}
): LedgerStreamAdapter {
  const ledger = options.ledger ?? new StreamLedger();
  const sessionId = options.sessionId ?? "local";
  const streamId = options.streamId ?? "stream";
  const kind = options.kind ?? "text";
  const priority = options.priority ?? 1;
  let createdAt = options.createdAt ?? 0;
  let seq = 1;
  let closed = false;

  ledger.open({ streamId, kind, priority, createdAt });

  const apply = (
    op: StreamEnvelope["op"]
  ): StreamApplyResult => {
    const revision = ledger.project(streamId).revision;
    const result = ledger.apply({
      sessionId,
      streamId,
      seq,
      baseRevision: revision,
      kind,
      priority,
      op,
      createdAt: createdAt++,
    });
    if (result.status === "applied") seq++;
    return result;
  };

  return {
    ledger,
    lines: source.lines,
    tail: source.tail.bind(source),
    version: source.version.bind(source),
    push(delta) {
      if (closed) throw new Error("[butui] ledger stream 已关闭");
      const result = apply({ type: "append", delta });
      if (result.status !== "applied") {
        throw new Error(`[butui] stream append rejected: ${result.status}`);
      }
      source.push(delta);
    },
    flush() {
      if (closed) {
        source.flush();
        return;
      }
      const result = apply({ type: "finish" });
      if (result.status !== "applied") {
        throw new Error(`[butui] stream finish rejected: ${result.status}`);
      }
      closed = true;
      source.flush();
    },
    get frozen() {
      return source.frozen;
    },
    get stats() {
      const projection = ledger.project(streamId);
      return {
        ...source.stats,
        ledgerRevision: projection.revision,
        ledgerStableLines: projection.stableLines.length,
        ledgerTailLines: projection.volatileTail.length,
      };
    },
    ...(source.onChange ? { onChange: source.onChange.bind(source) } : {}),
    projection() {
      return ledger.project(streamId);
    },
    replaceTail(from, text) {
      if (!source.replaceTail) {
        throw new Error("[butui] source 不支持 replace-tail");
      }
      const result = apply({ type: "replace-tail", from, text });
      if (result.status === "applied") source.replaceTail(from, text);
      return result;
    },
    cancel(reason) {
      if (!source.cancel) {
        throw new Error("[butui] source 不支持 cancel");
      }
      const result = apply({ type: "cancel", reason });
      if (result.status === "applied") {
        closed = true;
        source.cancel(reason);
      }
      return result;
    },
  };
}
