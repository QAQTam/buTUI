/**
 * 终端层 —— SPEC §6 的 `@butui/terminal` / §9.3。
 *
 * 只做 Bun 没帮我们做的事：raw mode、备用屏、鼠标 / paste / focus 开关、
 * resize、能力探测。宽度和折行交给 Bun 原生 API。
 *
 * 所有能力都是渐进增强的：不支持时安静降级（SPEC §4.4）。
 */
import type { ButuiEvent, ColorDepth, KeyEvent, MouseEvent, PasteEvent } from "@butui/core";
import { InputDecoder } from "./input.ts";

export * from "./input.ts";

const ESC = "\x1b[";

export function isTTY(stream: { isTTY?: boolean } = process.stdout): boolean {
  return stream.isTTY === true;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function terminalSize(): TerminalSize {
  const columns = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return {
    columns: columns > 0 ? columns : 80,
    rows: rows > 0 ? rows : 24,
  };
}

/**
 * 颜色能力探测（SPEC §9.3）。
 * 顺序：NO_COLOR / TERM=dumb → none；COLORTERM=truecolor → truecolor；
 * TERM 含 256color → 256；否则 16。
 */
export function detectColorDepth(env: Record<string, string | undefined> = process.env): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const term = env.TERM ?? "";
  if (term === "" || term === "dumb") return "none";
  const colorterm = env.COLORTERM ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (/truecolor|24bit/.test(term)) return "truecolor";
  if (/256color/.test(term)) return "256";
  return "16";
}

// ── 控制序列 ────────────────────────────────────────────────────────────────

export const CONTROL = {
  altScreenOn: `${ESC}?1049h`,
  altScreenOff: `${ESC}?1049l`,
  cursorHide: `${ESC}?25l`,
  cursorShow: `${ESC}?25h`,
  mouseOn: `${ESC}?1000h${ESC}?1002h${ESC}?1006h`,
  mouseOff: `${ESC}?1000l${ESC}?1002l${ESC}?1006l`,
  pasteOn: `${ESC}?2004h`,
  pasteOff: `${ESC}?2004l`,
  focusOn: `${ESC}?1004h`,
  focusOff: `${ESC}?1004l`,
  /** Kitty keyboard protocol：渐进增强，不支持时终端会忽略 */
  kittyKeysOn: `${ESC}>1u`,
  kittyKeysOff: `${ESC}<u`,
} as const;

export interface TerminalSessionOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  altScreen?: boolean;
  mouse?: boolean;
  bracketedPaste?: boolean;
  focusEvents?: boolean;
  kittyKeyboard?: boolean;
  /** 单独的 ESC 按键等待多久算「真的按了 ESC」 */
  escapeTimeout?: number;
}

export class TerminalSession {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly options: Required<Omit<TerminalSessionOptions, "stdin" | "stdout">>;
  private readonly decoder = new InputDecoder();
  private listeners = new Set<(event: ButuiEvent) => void>();
  private resizeListeners = new Set<(size: TerminalSize) => void>();
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private disposers: Array<() => void> = [];

  constructor(options: TerminalSessionOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.options = {
      altScreen: options.altScreen ?? true,
      mouse: options.mouse ?? true,
      bracketedPaste: options.bracketedPaste ?? true,
      focusEvents: options.focusEvents ?? true,
      kittyKeyboard: options.kittyKeyboard ?? false,
      escapeTimeout: options.escapeTimeout ?? 25,
    };
  }

  get size(): TerminalSize {
    return {
      columns: this.stdout.columns && this.stdout.columns > 0 ? this.stdout.columns : 80,
      rows: this.stdout.rows && this.stdout.rows > 0 ? this.stdout.rows : 24,
    };
  }

  get colorDepth(): ColorDepth {
    return detectColorDepth();
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (this.options.altScreen) this.write(CONTROL.altScreenOn);
    this.write(CONTROL.cursorHide);
    if (this.options.mouse) this.write(CONTROL.mouseOn);
    if (this.options.bracketedPaste) this.write(CONTROL.pasteOn);
    if (this.options.focusEvents) this.write(CONTROL.focusOn);
    if (this.options.kittyKeyboard) this.write(CONTROL.kittyKeysOn);

    this.setRawMode(true);

    const onData = (chunk: Buffer | Uint8Array) => {
      const events = this.decoder.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      for (const event of events) this.emit(event);
      this.scheduleEscapeFlush();
    };
    this.stdin.on("data", onData);
    this.disposers.push(() => this.stdin.off("data", onData));

    const onResize = () => {
      const size = this.size;
      for (const listener of this.resizeListeners) listener(size);
    };
    process.on("SIGWINCH", onResize);
    this.disposers.push(() => process.off("SIGWINCH", onResize));

    // 退出时一定要把终端还原，否则用户 shell 会坏掉
    const onExit = () => this.stop();
    process.on("exit", onExit);
    this.disposers.push(() => process.off("exit", onExit));
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.escapeTimer) clearTimeout(this.escapeTimer);

    if (this.options.kittyKeyboard) this.write(CONTROL.kittyKeysOff);
    if (this.options.focusEvents) this.write(CONTROL.focusOff);
    if (this.options.bracketedPaste) this.write(CONTROL.pasteOff);
    if (this.options.mouse) this.write(CONTROL.mouseOff);
    this.write(CONTROL.cursorShow);
    if (this.options.altScreen) this.write(CONTROL.altScreenOff);
    this.setRawMode(false);
  }

  /** 直接写原始字节（渲染器用） */
  write(chunk: string): void {
    this.stdout.write(chunk);
  }

  onEvent(listener: (event: ButuiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onKey(listener: (event: KeyEvent) => void): () => void {
    return this.onEvent(event => {
      if (event.type === "key") listener(event);
    });
  }

  onMouse(listener: (event: MouseEvent) => void): () => void {
    return this.onEvent(event => {
      if (event.type === "mouse") listener(event);
    });
  }

  onPaste(listener: (event: PasteEvent) => void): () => void {
    return this.onEvent(event => {
      if (event.type === "paste") listener(event);
    });
  }

  onResize(listener: (size: TerminalSize) => void): () => void {
    this.resizeListeners.add(listener);
    return () => this.resizeListeners.delete(listener);
  }

  private emit(event: ButuiEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private scheduleEscapeFlush(): void {
    if (!this.decoder.pending) return;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = setTimeout(() => {
      for (const event of this.decoder.flush()) this.emit(event);
    }, this.options.escapeTimeout);
    // 不要因为一个 25ms 定时器把进程钉住
    (this.escapeTimer as unknown as { unref?: () => void }).unref?.();
  }

  private setRawMode(enabled: boolean): void {
    const stdin = this.stdin as NodeJS.ReadStream & { setRawMode?: (v: boolean) => void };
    if (typeof stdin.setRawMode === "function") {
      try {
        stdin.setRawMode(enabled);
      } catch {
        // 非 TTY 环境下 setRawMode 会抛；测试 / 管道场景忽略
      }
    }
    if (enabled) stdin.resume?.();
  }
}
