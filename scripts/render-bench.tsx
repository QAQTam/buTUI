/**
 * 高频流式 chunk 合帧基准。
 *
 *   bun --conditions=browser run scripts/render-bench.tsx
 *
 * 用 1ms tick、每 tick 2 个 chunk 模拟 2000 tok/s。对比默认 microtask、
 * frame 合帧和 smooth reveal 的终端写入次数 / 字节数。
 */
import type { ButuiEvent } from "@butui/core";
import { createTuiApp, type TuiSize, type TuiTerminal } from "@butui/runtime";
import { StreamText, createTextStream } from "@butui/stream";

class BenchTerminal implements TuiTerminal {
  size: TuiSize = { columns: 80, rows: 20 };
  colorDepth = "truecolor" as const;
  writes = 0;
  bytes = 0;

  start(): void {}
  stop(): void {}
  write(chunk: string): void {
    this.writes++;
    this.bytes += chunk.length;
  }
  onEvent(_listener: (event: ButuiEvent) => void): () => void {
    return () => {};
  }
  onResize(_listener: (size: TuiSize) => void): () => void {
    return () => {};
  }
}

const TICKS = 1000;
const CHUNKS_PER_TICK = 2;

async function run(mode: "microtask" | "frame" | "smooth") {
  const terminal = new BenchTerminal();
  const source = createTextStream({ width: 80 });
  const app = createTuiApp({
    terminal,
    view: () =>
      mode === "smooth" ? (
        <StreamText
          source={source}
          smooth={{ speed: 160, catchUpMs: 180, reducedMotion: false }}
        />
      ) : (
        <StreamText source={source} />
      ),
    ...(mode === "frame" ? { render: { mode: "frame" as const, fps: 60 } } : {}),
    onQuit: () => {},
  });

  terminal.writes = 0;
  terminal.bytes = 0;
  const started = performance.now();

  for (let tick = 0; tick < TICKS; tick++) {
    source.push("a");
    source.push("b");
    await Bun.sleep(1);
  }
  source.flush();
  await Bun.sleep(mode === "smooth" ? 500 : mode === "frame" ? 25 : 5);

  const elapsed = performance.now() - started;
  app.dispose();
  return {
    chunks: TICKS * CHUNKS_PER_TICK,
    elapsed,
    writes: terminal.writes,
    bytes: terminal.bytes,
  };
}

console.log("模拟：2000 chunks/s（1000 tick × 2 chunk，1ms/tick）\n");
console.log("| 模式 | 用时 | chunk/s | 终端写入 | 写入字节 |");
console.log("|---|---:|---:|---:|---:|");

for (const mode of ["microtask", "frame", "smooth"] as const) {
  const result = await run(mode);
  console.log(
    `| ${mode} | ${result.elapsed.toFixed(1)} ms | ${Math.round(
      (result.chunks / result.elapsed) * 1000
    )} | ${result.writes} | ${result.bytes} |`
  );
}
