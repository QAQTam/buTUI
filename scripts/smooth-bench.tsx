/**
 * Smooth reveal 的 120fps 内存 / CPU 基准。
 *
 *   bun --conditions=browser run scripts/smooth-bench.tsx
 *
 * 内存测试先建好 source，再测 smooth wrapper 的增量；wrapper 只保存行引用和
 * 未 reveal 行的宽度缓存，不复制文本。CPU 测试手动跑 120fps tick，避免墙钟抖动。
 */
import { AnimationScheduler } from "@butui/solid";
import { createSmoothStream, createTextStream } from "@butui/stream";

function manualScheduler() {
  const scheduler = new AnimationScheduler({ fps: 120, now: () => 0 });
  scheduler.stop();
  return scheduler;
}

const LINE_COUNT = 20_000;
const source = createTextStream({ width: 80 });
for (let i = 0; i < LINE_COUNT; i++) {
  source.push(`line ${i} · ${"x".repeat(i % 24)}\n`);
}

Bun.gc?.(true);
const beforeWrapper = process.memoryUsage().heapUsed;
const memoryScheduler = manualScheduler();
const memoryView = createSmoothStream(source, {
  fps: 120,
  speed: 160,
  reducedMotion: false,
  scheduler: memoryScheduler,
});
memoryScheduler.stop();
memoryView.finish();
Bun.gc?.(true);
const afterWrapper = process.memoryUsage().heapUsed;
const wrapperBytes = Math.max(0, afterWrapper - beforeWrapper);
memoryView.dispose();

const cpuScheduler = manualScheduler();
const cpuSource = createTextStream({ width: 80 });
const cpuView = createSmoothStream(cpuSource, {
  fps: 120,
  speed: 160,
  catchUpMs: 180,
  maxColumnsPerFrame: 128,
  reducedMotion: false,
  scheduler: cpuScheduler,
});
cpuScheduler.stop();
cpuSource.push("x".repeat(4000));

const started = performance.now();
for (let tick = 0; tick < 240; tick++) {
  cpuScheduler.tick((tick * 1000) / 120);
}
const elapsed = performance.now() - started;
const stats = cpuView.stats;
const lag = cpuView.lag();
cpuView.dispose();

console.log("Smooth reveal · 120fps\n");
console.log("| 指标 | 数值 |");
console.log("|---|---:|");
console.log(`| source 行数 | ${LINE_COUNT} |`);
console.log(`| wrapper 增量内存 | ${(wrapperBytes / 1024).toFixed(1)} KiB |`);
console.log(`| 每行增量 | ${(wrapperBytes / LINE_COUNT).toFixed(1)} B |`);
console.log(`| 手动 240 tick 用时 | ${elapsed.toFixed(2)} ms |`);
console.log(`| smooth tick | ${stats.smoothTicks ?? 0} |`);
console.log(`| 实际 render | ${stats.smoothRenders ?? 0} |`);
console.log(`| 跳过无效帧 | ${stats.smoothSkippedTicks ?? 0} |`);
console.log(`| 最终 lag | ${lag.toFixed(1)} cols |`);
