/**
 * 真实 PTY 下的 StreamWindow 合成负载压测。
 *
 * 父进程创建一个 Bun.Terminal，子进程在真实 PTY 中运行 createTuiApp +
 * StreamWindow，并持续注入 2000 chunk/s。子进程把指标写入临时文件，父进程
 * 读取后输出 JSON。
 *
 * 用法：
 *   bun --conditions=browser run scripts/transcript-pty-bench.tsx \
 *     --seconds=3 --chunks-per-second=2000
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModifiers, type KeyEvent } from "@butui/core";
import { StreamWindow } from "@butui/components";
import { createTuiApp } from "@butui/runtime";
import { StreamLedger, type StreamEnvelope } from "@butui/stream";
import { createSignal } from "solid-js";

function option(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix));
  if (!raw) return fallback;
  const parsed = Number(raw.slice(prefix.length));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  );
  return sorted[index]!;
}

function key(name: string): KeyEvent {
  return {
    type: "key",
    name,
    modifiers: createModifiers(),
    stopPropagation() {},
    preventDefault() {},
    get defaultPrevented() {
      return false;
    },
  } as KeyEvent;
}

async function runChild(): Promise<void> {
  const metricsPath = process.env.BUTUI_PTY_METRICS;
  if (!metricsPath) throw new Error("missing BUTUI_PTY_METRICS");
  const seconds = option("seconds", 3);
  const chunksPerSecond = option("chunks-per-second", 2_000);
  const viewportHeight = option("height", 20);
  const batchSize = Math.max(1, Math.ceil(chunksPerSecond / 250));
  const intervalMs = Math.max(1, Math.round((batchSize / chunksPerSecond) * 1000));
  const streamId = "pty-bench";
  const ledger = new StreamLedger();
  ledger.open({ streamId, kind: "text", priority: 1, createdAt: 0 });

  const [revision, setRevision] = createSignal(0);
  const [pulse, setPulse] = createSignal(0);
  const [chunks, setChunks] = createSignal(0);
  const inputLatencies: number[] = [];
  let frameCount = 0;
  let frameBytes = 0;
  let blockedFrames = 0;
  let seq = 1;
  let revisionValue = 0;
  let running = true;

  const app = createTuiApp({
    view: () => (
      <box>
        <text>{`pulse=${pulse()} chunks=${chunks()} revision=${revision()}`}</text>
        <StreamWindow
          ledger={ledger}
          streamId={streamId}
          width="100%"
          height={viewportHeight}
          follow
          revision={revision}
          scrollbar
          smooth
        />
      </box>
    ),
    render: { mode: "frame", fps: 120 },
    onKey: () => {
      setPulse(value => value + 1);
      return true;
    },
    afterDraw: (_frame, stats) => {
      frameCount++;
      frameBytes += stats.bytes;
      if (stats.blocked) blockedFrames++;
    },
  });

  const appendBatch = (): void => {
    const start = chunks();
    let delta = "";
    for (let index = 0; index < batchSize; index++) {
      const value = start + index;
      delta += `token-${value}${(value + 1) % 16 === 0 ? "\n" : " "}`;
    }
    const envelope: StreamEnvelope = {
      sessionId: "pty-bench",
      streamId,
      seq: seq++,
      baseRevision: revisionValue,
      kind: "text",
      priority: 1,
      op: { type: "append", delta },
      createdAt: Date.now(),
    };
    const result = ledger.apply(envelope);
    if (result.status !== "applied") {
      throw new Error(`append failed: ${JSON.stringify(result)}`);
    }
    revisionValue = result.revision;
    setChunks(value => value + batchSize);
    setRevision(result.revision);
  };

  const startedAt = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;
  const feed = setInterval(appendBatch, intervalMs);
  let inputPending = false;
  const input = setInterval(async () => {
    if (!running || inputPending) return;
    inputPending = true;
    const at = performance.now();
    app.send(key("x"));
    try {
      await Promise.race([
        app.waitUntilFrameFlushed(undefined, "drained"),
        Bun.sleep(250),
      ]);
      inputLatencies.push(performance.now() - at);
    } catch {
      // dispose / backpressure 终止期间的等待不算有效样本。
    } finally {
      inputPending = false;
    }
  }, 100);

  await Bun.sleep(seconds * 1000);
  running = false;
  clearInterval(feed);
  clearInterval(input);
  try {
    await Promise.race([
      app.waitUntilFrameFlushed(undefined, "drained"),
      Bun.sleep(250),
    ]);
  } catch {
    // 最后一次 feed 可能没有留下新 revision；指标仍可提交。
  }

  const stats = ledger.stats();
  const heapAfter = process.memoryUsage().heapUsed;
  const metrics = {
    seconds,
    chunksPerSecond,
    intervalMs,
    batchSize,
    chunks: chunks(),
    revision: revisionValue,
    frameCount,
    frameBytes,
    blockedFrames,
    inputSamples: inputLatencies.length,
    inputLatencyMs: {
      p50: percentile(inputLatencies, 0.5),
      p95: percentile(inputLatencies, 0.95),
      max: Math.max(0, ...inputLatencies),
    },
    ledger: stats,
    heapDeltaBytes: heapAfter - heapBefore,
    elapsedMs: performance.now() - startedAt,
  };

  writeFileSync(metricsPath, JSON.stringify(metrics));
  app.dispose();
  ledger.dispose();
  process.exit(0);
}

async function runParent(): Promise<void> {
  const seconds = option("seconds", 3);
  const chunksPerSecond = option("chunks-per-second", 2_000);
  const cols = option("cols", 100);
  const rows = option("rows", 32);
  const dir = mkdtempSync(join(tmpdir(), "butui-pty-bench-"));
  const metricsPath = join(dir, "metrics.json");
  let ptyBytes = 0;
  let outputTail = "";
  const terminal = new Bun.Terminal({
    cols,
    rows,
    name: "xterm-256color",
    data(_terminal, chunk) {
      ptyBytes += chunk.length;
      outputTail = (outputTail + chunk).slice(-4_096);
    },
  });

  try {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--conditions=browser",
        "run",
        import.meta.path,
        `--seconds=${seconds}`,
        `--chunks-per-second=${chunksPerSecond}`,
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        BUTUI_PTY_CHILD: "1",
        BUTUI_PTY_METRICS: metricsPath,
      },
      terminal,
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`PTY child exited ${exitCode}\n${outputTail}`);
    }
    const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
    console.log(
      JSON.stringify(
        {
          cols,
          rows,
          ptyBytes,
          ...metrics,
        },
        null,
        2
      )
    );
  } finally {
    terminal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.env.BUTUI_PTY_CHILD === "1") {
  await runChild();
} else {
  await runParent();
}
