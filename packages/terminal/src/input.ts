/**
 * 终端输入解码 —— SPEC §9.3 / §9.4。
 *
 * Bun 只给原始字节，解析是我们的活。支持：
 *   - UTF-8 文本（含 CJK / emoji，靠 TextDecoder 的流式解码）
 *   - 传统 CSI 功能键（`ESC [ A`、`ESC [ 1;5A` 等）
 *   - SGR 鼠标（1006，`ESC [ < b ; x ; y M/m`）
 *   - bracketed paste（2004，`ESC [ 200~` … `ESC [ 201~`）
 *   - focus in/out（1004）
 *   - Kitty keyboard protocol（`ESC [ code ; mods : event u`）
 *
 * 解析器是有状态的：一帧里被截断的转义序列会留在 buffer 里等下一帧。
 */
import {
  type ButuiEvent,
  type KeyEvent,
  type KeyModifiers,
  type MouseEvent,
  eventTarget,
} from "@butui/core";

const ESC = 0x1b;
const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

const CSI_FINAL = /[\x40-\x7e]/;

/** 传统 CSI 末位字母 → 键名 */
const CSI_KEYS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  H: "home",
  F: "end",
  Z: "tab", // shift+tab
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

/** `ESC [ n ~` → 键名 */
const TILDE_KEYS: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

/** 控制字符 → 键名 */
const CONTROL_KEYS: Record<string, string> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x03": "c",
  "\x04": "d",
  "\x1a": "z",
};

function modifiersOf(mask: number): KeyModifiers {
  // xterm 修饰键编码：1 + (shift:1 | alt:2 | ctrl:4 | meta:8)
  const bits = mask - 1;
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
    meta: (bits & 8) !== 0,
  };
}

export class InputDecoder {
  private decoder = new TextDecoder("utf-8", { fatal: false });
  private buffer = "";
  private pasting = false;
  private pasteBuffer = "";

  push(bytes: Uint8Array): ButuiEvent[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    return this.drain();
  }

  /** 把 buffer 里剩下的东西当普通输入处理（用于超时后 flush 单独的 ESC） */
  flush(): ButuiEvent[] {
    if (this.buffer === "\x1b") {
      this.buffer = "";
      return [this.key("escape", undefined, modifiersOf(1))];
    }
    return this.drain(true);
  }

  /** 是否还挂着不完整序列（用于决定要不要起 flush 定时器） */
  get pending(): boolean {
    return this.buffer.length > 0;
  }

  private drain(force = false): ButuiEvent[] {
    const events: ButuiEvent[] = [];

    while (this.buffer.length > 0) {
      // 1. bracketed paste
      if (this.pasting) {
        const end = this.buffer.indexOf(BRACKET_PASTE_END);
        if (end === -1) {
          this.pasteBuffer += this.buffer;
          this.buffer = "";
          break;
        }
        this.pasteBuffer += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + BRACKET_PASTE_END.length);
        this.pasting = false;
        const text = this.pasteBuffer;
        this.pasteBuffer = "";
        events.push({ type: "paste", text });
        continue;
      }
      if (this.buffer.startsWith(BRACKET_PASTE_START)) {
        this.buffer = this.buffer.slice(BRACKET_PASTE_START.length);
        this.pasting = true;
        continue;
      }

      // 2. 转义序列
      if (this.buffer.charCodeAt(0) === ESC) {
        const consumed = this.parseEscape(events, force);
        if (consumed === 0) break; // 不完整，等下一帧
        this.buffer = this.buffer.slice(consumed);
        continue;
      }

      // 3. 控制字符
      const ch = this.buffer[0];
      const code = this.buffer.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        this.buffer = this.buffer.slice(1);
        const name = CONTROL_KEYS[ch];
        if (name) {
          const mods = modifiersOf(code < 0x20 ? 5 : 1); // ctrl+letter
          if (code < 0x20 && name.length === 1) mods.ctrl = true;
          events.push(this.key(name, undefined, mods));
        }
        continue;
      }

      // 4. 普通文本：按 grapheme 切，避免把 emoji 拆开
      const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(this.buffer)];
      const first = graphemes[0];
      if (!first) break;
      this.buffer = this.buffer.slice(first.segment.length);
      events.push(this.key(first.segment, first.segment, modifiersOf(1)));
    }

    return events;
  }

  /** 返回消费掉的字符数；0 表示需要更多数据 */
  private parseEscape(events: ButuiEvent[], force: boolean): number {
    const rest = this.buffer;
    if (rest.length === 1) {
      if (force) {
        events.push(this.key("escape", undefined, modifiersOf(1)));
        return 1;
      }
      return 0;
    }

    const second = rest[1];

    // ESC [ ... — CSI
    if (second === "[") {
      let end = -1;
      for (let i = 2; i < rest.length; i++) {
        if (CSI_FINAL.test(rest[i])) {
          end = i;
          break;
        }
      }
      if (end === -1) return force ? this.consumeAsEscape(events, rest.length) : 0;
      const body = rest.slice(2, end);
      const final = rest[end];
      return this.handleCsi(body, final, events) ?? end + 1;
    }

    // ESC O x — SS3（应用光标模式下的功能键）
    if (second === "O") {
      if (rest.length < 3) return force ? this.consumeAsEscape(events, rest.length) : 0;
      const name = CSI_KEYS[rest[2]];
      if (name) events.push(this.key(name, undefined, modifiersOf(1)));
      return 3;
    }

    // ESC + 字符 — alt+char
    const grapheme = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(rest.slice(1))][0];
    if (!grapheme) return force ? 1 : 0;
    const mods = modifiersOf(1);
    mods.alt = true;
    events.push(this.key(grapheme.segment, grapheme.segment, mods));
    return 1 + grapheme.segment.length;
  }

  /** 整段当 escape 处理，返回消费长度 */
  private consumeAsEscape(events: ButuiEvent[], length: number): number {
    events.push(this.key("escape", undefined, modifiersOf(1)));
    return length;
  }

  /** 返回实际消费的字符数，null 表示按 CSI 长度消费 */
  private handleCsi(body: string, final: string, events: ButuiEvent[]): number | null {
    // SGR 鼠标：`<b;x;yM` / `<b;x;ym`
    if (body.startsWith("<") && (final === "M" || final === "m")) {
      const [b, x, y] = body.slice(1).split(";").map(Number);
      const buttonCode = b & 0b11;
      const motion = (b & 0b0100000) !== 0;
      const wheel = (b & 0b1000000) !== 0;
      // 鼠标的修饰键位是 4/8/16（shift/meta/ctrl），不是键盘那套 1/2/4；
      // 直接 1 + (b & 0b11100) 会把 shift 认成 ctrl。
      const mouseBits =
        ((b & 0b00100) !== 0 ? 1 : 0) |
        ((b & 0b01000) !== 0 ? 8 : 0) |
        ((b & 0b10000) !== 0 ? 4 : 0);
      const mods = modifiersOf(1 + mouseBits);
      let action: MouseEvent["action"] = final === "m" ? "release" : "press";
      let button: MouseEvent["button"] = "none";
      let wheelDir: MouseEvent["wheel"];
      if (wheel) {
        // 低位 0/1/2/3 = 上/下/左/右（xterm 的 64..67）
        action = "wheel";
        wheelDir = (["up", "down", "left", "right"] as const)[buttonCode];
      } else if (motion) {
        // 1002 模式下 b=32+button 表示「按住某键移动」；b=35 表示无按键移动。
        action = "move";
        button =
          buttonCode === 0
            ? "left"
            : buttonCode === 1
              ? "middle"
              : buttonCode === 2
                ? "right"
                : "none";
      } else if (buttonCode === 0) button = "left";
      else if (buttonCode === 1) button = "middle";
      else if (buttonCode === 2) button = "right";
      events.push(
        eventTarget({
          type: "mouse" as const,
          action,
          button,
          ...(wheelDir ? { wheel: wheelDir } : {}),
          x: Math.max(0, x - 1),
          y: Math.max(0, y - 1),
          modifiers: mods,
        }) as MouseEvent
      );
      return null;
    }

    // focus in / out
    if (body === "" && (final === "I" || final === "O")) {
      events.push({ type: "focus", target: undefined });
      return null;
    }

    // Kitty keyboard protocol：`code;mods:event u`
    if (final === "u") {
      const [codePart, rest] = body.split(":");
      const [keyCode, modPart] = codePart.split(";");
      const mods = modPart ? modifiersOf(Number(modPart)) : modifiersOf(1);
      const name = kittyKeyName(Number(keyCode));
      if (name) {
        if (rest === "3") return null; // release 事件先忽略
        events.push(this.key(name, name.length === 1 ? name : undefined, mods));
      }
      return null;
    }

    // `n ~` 形式
    if (final === "~") {
      const [n] = body.split(";");
      const name = TILDE_KEYS[Number(n)];
      if (name) events.push(this.key(name, undefined, modifiersOf(1)));
      return null;
    }

    // 字母结尾：`A`、`1;5A`、`3~` 等
    const name = CSI_KEYS[final];
    if (name) {
      const parts = body.split(";");
      const mods = parts.length > 1 ? modifiersOf(Number(parts[parts.length - 1])) : modifiersOf(1);
      if (final === "Z") mods.shift = true;
      events.push(this.key(name, undefined, mods));
      return null;
    }

    return null;
  }

  private key(name: string, text: string | undefined, modifiers: KeyModifiers): KeyEvent {
    return eventTarget({
      type: "key" as const,
      name,
      text,
      modifiers,
    }) as KeyEvent;
  }
}

function kittyKeyName(code: number): string | undefined {
  switch (code) {
    case 13:
      return "enter";
    case 9:
      return "tab";
    case 27:
      return "escape";
    case 127:
      return "backspace";
    case 57344:
      return "escape";
    case 57345:
      return "enter";
    case 57346:
      return "tab";
    case 57347:
      return "backspace";
    case 57348:
      return "insert";
    case 57349:
      return "delete";
    case 57350:
      return "left";
    case 57351:
      return "right";
    case 57352:
      return "up";
    case 57353:
      return "down";
    case 57354:
      return "pageup";
    case 57355:
      return "pagedown";
    case 57356:
      return "home";
    case 57357:
      return "end";
    default:
      if (code >= 32 && code < 0x110000) return String.fromCodePoint(code);
      return undefined;
  }
}
