/**
 * 终端层 —— SPEC §6 的 `@butui/terminal` / §9.3。
 *
 * 只做 Bun 没帮我们做的事：raw mode、备用屏、鼠标 / paste / focus 开关、
 * resize、能力探测。宽度和折行交给 Bun 原生 API。
 *
 * 所有能力都是渐进增强的：不支持时安静降级（SPEC §4.4）。
 */
import type {
  ButuiEvent,
  ColorDepth,
  KeyEvent,
  MouseEvent,
  MousePointerStyle,
  PasteEvent,
} from "@butui/core";
import { InputDecoder } from "./input.ts";
import {
  TerminalArbiter,
  type TerminalLease,
} from "./arbiter.ts";

export * from "./input.ts";
export * from "./arbiter.ts";

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
  /** 1003 会持续上报无按键移动，hover 需要但事件量更高 */
  mouseHoverOn: `${ESC}?1000h${ESC}?1002h${ESC}?1003h${ESC}?1006h`,
  mouseOff: `${ESC}?1000l${ESC}?1002l${ESC}?1003l${ESC}?1006l`,
  pasteOn: `${ESC}?2004h`,
  pasteOff: `${ESC}?2004l`,
  focusOn: `${ESC}?1004h`,
  focusOff: `${ESC}?1004l`,
  /** Kitty keyboard protocol：渐进增强，不支持时终端会忽略 */
  kittyKeysOn: `${ESC}>1u`,
  kittyKeysOff: `${ESC}<u`,
} as const;

export type ClipboardTarget = "clipboard" | "primary";

export interface OscTransportOptions {
  /**
   * 多路复用器透传。
   *
   * `"auto"` 在 `$TMUX` 存在时自动包一层 tmux passthrough；`"none"` 直接发
   * OSC。终端不支持对应能力时会安静忽略 —— 这个 API 只能表示「已尝试」。
   */
  multiplexer?: "auto" | "tmux" | "none";
  /** 结束符。BEL 兼容面最广；部分终端只认 ST（`ESC \`）。 */
  terminator?: "bel" | "st";
}

export interface Osc52Options extends OscTransportOptions {
  target?: ClipboardTarget;
}

export interface Osc22Options extends OscTransportOptions {}

function wrapOsc(sequence: string, options: OscTransportOptions): string {
  const mode =
    options.multiplexer === "auto"
      ? process.env.TMUX
        ? "tmux"
        : "none"
      : (options.multiplexer ?? "none");
  if (mode !== "tmux") return sequence;
  // tmux DCS passthrough：内部的 ESC 必须写两遍。
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

function oscEnd(options: OscTransportOptions): string {
  return options.terminator === "st" ? "\x1b\\" : "\x07";
}

/**
 * 生成 OSC 52 剪贴板序列。
 *
 * 文本先按 UTF-8 编码再 base64，避免换行 / 控制字符破坏 OSC；调用方把它写进
 * 终端即可。tmux 下需要 passthrough，否则外层 tmux 会吞掉 OSC。
 */
export function osc52(text: string, options: Osc52Options = {}): string {
  const target = options.target === "primary" ? "p" : "c";
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const sequence = `\x1b]52;${target};${encoded}${oscEnd(options)}`;
  return wrapOsc(sequence, options);
}

/**
 * 生成 OSC 22 鼠标指针形状序列。
 *
 * `auto` 在协议层没有含义，统一写 `default`；具体节点是否显示 pointer 由
 * runtime 解析。终端不支持时忽略，不需要 ACK。
 */
export function osc22(
  shape: MousePointerStyle,
  options: Osc22Options = {}
): string {
  const value = shape === "auto" ? "default" : shape;
  return wrapOsc(`\x1b]22;${value}${oscEnd(options)}`, options);
}

export interface TerminalSessionOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  altScreen?: boolean;
  mouse?: boolean;
  /**
   * `"drag"` 只开 1002（按键拖动上报），`"hover"` 额外开 1003
   * （无按键移动也上报）。hover 更灵敏但事件量明显更高。
   */
  mouseMotion?: "drag" | "hover";
  bracketedPaste?: boolean;
  focusEvents?: boolean;
  kittyKeyboard?: boolean;
  /** 允许 OSC 22 指针形状；stop 时自动恢复 default */
  mousePointer?: boolean;
  /** 单独的 ESC 按键等待多久算「真的按了 ESC」 */
  escapeTimeout?: number;
  /** 注入共享 TerminalArbiter；不传时 TerminalSession 自建一个。 */
  arbiter?: TerminalArbiter;
  /** frame lease owner，默认 terminal-session。 */
  leaseOwner?: string;
}

export interface TerminalWriteOptions {
  kind?: "frame" | "append" | "control";
  frameId?: number;
}

export interface RawLeaseContext {
  lease: TerminalLease;
  /** raw owner 直接写终端；返回 false 表示底层 backpressure。 */
  write(bytes: string | Uint8Array): boolean;
  /** raw 期间直接订阅 stdin 字节，不再经过 UI InputDecoder。 */
  onInput(listener: (chunk: Uint8Array) => void): () => void;
}

export class TerminalSession {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly options: Required<
    Omit<
      TerminalSessionOptions,
      "stdin" | "stdout" | "arbiter" | "leaseOwner"
    >
  >;
  private readonly arbiter: TerminalArbiter;
  private readonly leaseOwner: string;
  private lease: TerminalLease | undefined;
  private readonly decoder = new InputDecoder();
  private listeners = new Set<(event: ButuiEvent) => void>();
  private resizeListeners = new Set<(size: TerminalSize) => void>();
  private drainListeners = new Set<() => void>();
  private rawInputListeners = new Set<(chunk: Uint8Array) => void>();
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private disposers: Array<() => void> = [];
  private mousePointerStyle: MousePointerStyle | undefined;

  constructor(options: TerminalSessionOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.leaseOwner = options.leaseOwner ?? "terminal-session";
    this.arbiter =
      options.arbiter ??
      new TerminalArbiter({
        write: bytes =>
          typeof bytes === "string"
            ? this.stdout.write(bytes)
            : this.stdout.write(Buffer.from(bytes)),
        onDrain: listener => {
          if (typeof this.stdout.on !== "function") return () => {};
          this.stdout.on("drain", listener);
          return () => this.stdout.off("drain", listener);
        },
      });
    this.options = {
      altScreen: options.altScreen ?? true,
      mouse: options.mouse ?? true,
      mouseMotion: options.mouseMotion ?? "drag",
      bracketedPaste: options.bracketedPaste ?? true,
      focusEvents: options.focusEvents ?? true,
      kittyKeyboard: options.kittyKeyboard ?? false,
      mousePointer: options.mousePointer ?? true,
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

  get outputArbiter(): TerminalArbiter {
    return this.arbiter;
  }

  get frameLease(): TerminalLease | undefined {
    return this.lease;
  }

  /** 暂停 frame lease，把终端交给 raw / 子进程。 */
  async suspend(reason = "suspend"): Promise<void> {
    if (!this.lease) return;
    await this.arbiter.suspend(this.lease, reason);
  }

  /** 恢复 frame lease；恢复后调用方应强制 full damage。 */
  async resume(): Promise<void> {
    if (!this.lease) return;
    await this.arbiter.resume(this.lease);
  }

  requiresFullDamage(): boolean {
    return this.arbiter.requiresFullDamage();
  }

  /**
   * 临时把终端交给 raw owner（子进程 / 调试器）。
   * 无论 callback 成功或抛错，都会释放 raw lease 并恢复 frame lease。
   */
  async withRawLease<T>(
    owner: string,
    reason: string,
    run: (context: RawLeaseContext) => Promise<T> | T
  ): Promise<T> {
    const shouldResume = this.lease !== undefined;
    await this.suspend(reason);
    let raw: TerminalLease | undefined;
    const rawInputs = new Set<(chunk: Uint8Array) => void>();
    try {
      raw = await this.arbiter.acquire({
        owner,
        kind: "raw",
        reason,
        priority: Number.MAX_SAFE_INTEGER,
      });
      return await run({
        lease: raw,
        write: bytes => {
          const receipt = this.arbiter.write(raw!, {
            kind: "append",
            bytes,
          });
          return receipt.accepted && !receipt.blocked;
        },
        onInput: listener => {
          const wrapped = (chunk: Uint8Array) => listener(chunk);
          rawInputs.add(wrapped);
          this.rawInputListeners.add(wrapped);
          return () => {
            rawInputs.delete(wrapped);
            this.rawInputListeners.delete(wrapped);
          };
        },
      });
    } finally {
      for (const listener of rawInputs) this.rawInputListeners.delete(listener);
      if (raw) await this.arbiter.release(raw);
      if (shouldResume) await this.resume();
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lease = this.arbiter.tryAcquire({
      owner: this.leaseOwner,
      kind: "frame",
      reason: "terminal-session",
    });

    if (this.options.altScreen) this.write(CONTROL.altScreenOn, { kind: "control" });
    this.write(CONTROL.cursorHide, { kind: "control" });
    if (this.options.mouse) {
      this.write(
        this.options.mouseMotion === "hover"
          ? CONTROL.mouseHoverOn
          : CONTROL.mouseOn,
        { kind: "control" }
      );
    }
    if (this.options.bracketedPaste) this.write(CONTROL.pasteOn, { kind: "control" });
    if (this.options.focusEvents) this.write(CONTROL.focusOn, { kind: "control" });
    if (this.options.kittyKeyboard) this.write(CONTROL.kittyKeysOn, { kind: "control" });

    this.setRawMode(true);

    const onData = (chunk: Buffer | Uint8Array) => {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (this.rawInputListeners.size > 0) {
        for (const listener of [...this.rawInputListeners]) listener(bytes);
        return;
      }
      const events = this.decoder.push(bytes);
      for (const event of events) this.emit(event);
      this.scheduleEscapeFlush();
    };
    this.stdin.on("data", onData);
    this.disposers.push(() => this.stdin.off("data", onData));

    const onDrain = () => {
      for (const listener of [...this.drainListeners]) listener();
    };
    if (typeof this.stdout.on === "function") {
      this.stdout.on("drain", onDrain);
      this.disposers.push(() => this.stdout.off("drain", onDrain));
    }

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

    if (this.options.kittyKeyboard) this.write(CONTROL.kittyKeysOff, { kind: "control" });
    if (this.options.focusEvents) this.write(CONTROL.focusOff, { kind: "control" });
    if (this.options.bracketedPaste) this.write(CONTROL.pasteOff, { kind: "control" });
    if (this.options.mouse) this.write(CONTROL.mouseOff, { kind: "control" });
    if (this.mousePointerStyle !== undefined) this.setMousePointer("default");
    this.write(CONTROL.cursorShow, { kind: "control" });
    if (this.options.altScreen) this.write(CONTROL.altScreenOff, { kind: "control" });
    const lease = this.lease;
    this.lease = undefined;
    if (lease) void this.arbiter.release(lease);
    this.setRawMode(false);
  }

  /**
   * 写终端输出。
   *
   * 默认按 frame 输出；控制序列显式传 `"control"`，日志 / 外部追加传
   * `"append"`。lease 不可用时回退到原有 stdout.write，保持 v0.1 兼容。
   */
  write(
    chunk: string,
    options: TerminalWriteOptions = {}
  ): boolean | void {
    if (!this.lease) return this.stdout.write(chunk);
    const receipt = this.arbiter.write(this.lease, {
      kind: options.kind ?? "frame",
      ...(options.frameId !== undefined ? { frameId: options.frameId } : {}),
      bytes: chunk,
    });
    return receipt.accepted && !receipt.blocked;
  }

  /** 设置 OSC 22 指针形状；相同形状不重复写，stop 时恢复 default。 */
  setMousePointer(style: MousePointerStyle): void {
    if (!this.options.mousePointer) return;
    const normalized = style === "auto" ? "default" : style;
    if (this.mousePointerStyle === normalized) return;
    this.mousePointerStyle = normalized;
    this.write(osc22(normalized, { multiplexer: "auto" }), { kind: "control" });
  }

  /**
   * 尝试把文本写进系统剪贴板（OSC 52）。
   *
   * 返回 `true` 只表示序列已写出，不表示终端真的接受了 —— 大多数终端没有
   * 确认通道。需要严格确认的场景应接系统剪贴板库。
   */
  copy(text: string, options: Osc52Options = {}): boolean {
    if (text.length === 0) return false;
    this.write(osc52(text, options), { kind: "control" });
    return true;
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

  /** stdout 写缓冲排空后通知；不支持的 stdout 永远不通知。 */
  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
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

export interface PtyRunOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
  /** PTY 与子进程建立后、等待退出前的钩子。 */
  onReady?: (terminal: Bun.Terminal) => void;
}

/**
 * 在 raw lease 内运行一个 Bun PTY 子进程。
 *
 * 子进程输出直接写回宿主终端；raw 期间的宿主 stdin 字节直接转发给 PTY，
 * 不再经过 InputDecoder / UI 事件层。
 */
export async function runPtyWithRawLease(
  session: TerminalSession,
  owner: string,
  reason: string,
  options: PtyRunOptions
): Promise<number> {
  if (typeof Bun.Terminal !== "function") {
    throw new Error("[butui] 当前 Bun 不支持 Bun.Terminal");
  }

  return session.withRawLease(owner, reason, async context => {
    const terminal = new Bun.Terminal({
      cols: options.cols ?? session.size.columns,
      rows: options.rows ?? session.size.rows,
      ...(options.name ? { name: options.name } : {}),
      data(_terminal, chunk) {
        context.write(chunk);
      },
    });
    let unsubscribeInput: (() => void) | undefined;
    const unsubscribeResize = session.onResize(size => {
      try {
        terminal.resize(size.columns, size.rows);
      } catch {
        // 子进程退出和 PTY close 存在竞态；resize 失败不能影响 lease 恢复。
      }
    });
    try {
      const process = Bun.spawn({
        cmd: options.cmd,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        terminal,
      });
      unsubscribeInput = context.onInput(chunk => terminal.write(chunk));
      options.onReady?.(terminal);
      return await process.exited;
    } finally {
      unsubscribeInput?.();
      unsubscribeResize();
      terminal.close();
    }
  });
}
