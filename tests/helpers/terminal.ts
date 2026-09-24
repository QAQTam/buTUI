import type { ButuiEvent } from "@butui/core";
import type { TuiSize, TuiTerminal } from "@butui/runtime";

/**
 * 假终端：不碰 TTY、不写 stdout，事件手动注入。
 *
 * `@butui/runtime` 的 `TuiTerminal` 是结构化接口，所以测试可以完全绕开真实
 * 终端 —— 这是「终端只在最外层」这条分层带来的直接好处。
 */
export class FakeTerminal implements TuiTerminal {
  output = "";
  writes = 0;
  started = false;
  stopped = false;
  size: TuiSize = { columns: 40, rows: 6 };
  colorDepth = "truecolor" as const;
  private events: Array<(event: ButuiEvent) => void> = [];
  private resizes: Array<(size: TuiSize) => void> = [];

  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  write(chunk: string): void {
    this.writes++;
    this.output += chunk;
  }
  onEvent(listener: (event: ButuiEvent) => void): () => void {
    this.events.push(listener);
    return () => {
      this.events = this.events.filter(l => l !== listener);
    };
  }
  onResize(listener: (size: TuiSize) => void): () => void {
    this.resizes.push(listener);
    return () => {
      this.resizes = this.resizes.filter(l => l !== listener);
    };
  }
  emit(event: ButuiEvent): void {
    for (const listener of [...this.events]) listener(event);
  }
  resize(size: TuiSize): void {
    this.size = size;
    for (const listener of [...this.resizes]) listener(size);
  }
}

/** 等一帧：runtime 用 queueMicrotask 合帧，sleep(0) 必然在它之后 */
export const tick = (): Promise<void> => Bun.sleep(0);
