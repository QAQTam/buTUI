/**
 * agent-demo 的 transcript 适配器。
 *
 * 它把 AgentEvent 转成 StreamLedger 的 append op，给 <StreamWindow> 提供
 * 可滚动、可 retention 的稳定行；未完成的最后一行继续以 volatile tail 展示。
 * 这不是新的 agent 状态源：Session 仍负责语义状态，ledger 只负责长文本投影。
 */
import type { AgentEvent } from "@butui/agent";
import { MemoryLedger } from "@butui/core";
import {
  MemorySpillStore,
  StreamLedger,
  type StreamId,
} from "@butui/stream";
import { createSignal } from "solid-js";

export interface Transcript {
  readonly ledger: StreamLedger;
  readonly streamId: StreamId;
  readonly revision: () => number;
  ingest(event: AgentEvent): void;
  flush(): Promise<void>;
  dispose(): void;
}

export interface TranscriptOptions {
  streamId?: StreamId;
  /** JS heap 预算；超过后 stable line 会进入 spill。 */
  memoryBytes?: number;
  /** spill 后保留在内存的 stable bytes。 */
  retainedBytes?: number;
}

export function createTranscript(options: TranscriptOptions = {}): Transcript {
  const streamId = options.streamId ?? "agent-transcript";
  const memoryBytes = Math.max(64 * 1024, options.memoryBytes ?? 2 * 1024 * 1024);
  const retainedBytes = Math.min(
    memoryBytes,
    Math.max(32 * 1024, options.retainedBytes ?? memoryBytes / 2)
  );
  const memory = new MemoryLedger({ totalBytes: memoryBytes });
  const ledger = new StreamLedger({
    memory,
    memoryOwner: "agent-demo-transcript",
    spill: {
      store: new MemorySpillStore(),
      policy: { maxBytes: retainedBytes },
    },
  });
  ledger.open({ streamId, kind: "text", priority: 1, createdAt: 0 });

  const [revision, setRevision] = createSignal(0);
  let seq = 1;
  let closed = false;
  let chain = Promise.resolve();

  const enqueue = (delta: string): void => {
    if (delta === "" || closed) return;
    chain = chain.then(async () => {
      const current = ledger.project(streamId).revision;
      const result = await ledger.applyWithSpill({
        sessionId: "agent-demo",
        streamId,
        seq: seq++,
        baseRevision: current,
        kind: "text",
        priority: 1,
        op: { type: "append", delta },
        createdAt: Date.now(),
      });
      if (result.status !== "applied") {
        throw new Error(`[agent-demo] transcript append ${result.status}`);
      }
      setRevision(result.revision);
    });
  };

  return {
    ledger,
    streamId,
    revision,
    ingest(event) {
      switch (event.type) {
        case "text.delta":
          enqueue(event.delta);
          return;
        case "turn.start":
          enqueue("\n");
          return;
        case "tool.start":
          enqueue(`\n[tool] ${event.call.name}\n`);
          return;
        case "tool.result":
          enqueue(
            `[tool] ${event.result.status}${
              event.result.output ? `: ${event.result.output}` : ""
            }\n`
          );
          return;
        case "permission.request":
          enqueue(`\n[permission] ${event.request.detail}\n`);
          return;
        case "error":
          enqueue(`\n[error] ${event.message}\n`);
          return;
        case "turn.end":
          enqueue("\n");
          return;
        default:
          return;
      }
    },
    async flush() {
      await chain;
    },
    dispose() {
      if (closed) return;
      closed = true;
      chain = chain
        .then(async () => {
          const current = ledger.project(streamId).revision;
          await ledger.applyWithSpill({
            sessionId: "agent-demo",
            streamId,
            seq: seq++,
            baseRevision: current,
            kind: "text",
            priority: 1,
            op: { type: "finish" },
            createdAt: Date.now(),
          });
          ledger.dispose();
        })
        .catch(() => {
          ledger.dispose();
        });
    },
  };
}
