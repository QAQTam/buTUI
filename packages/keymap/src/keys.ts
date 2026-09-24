import type { KeyEvent } from "@butui/core";

export interface KeyStroke {
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

const MODIFIER_ALIASES: Record<string, keyof Omit<KeyStroke, "name">> = {
  ctrl: "ctrl",
  control: "ctrl",
  c: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
  s: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
};

const NAME_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  space: " ",
  spacebar: " ",
  pgup: "pageup",
  pgdn: "pagedown",
  del: "delete",
  ins: "insert",
};

/**
 * 解析单键绑定，如 `ctrl+k` / `shift+tab` / `escape` / `space`。
 *
 * 多键 chord（空格分隔的序列）暂不支持，会明确抛错而不是静默误解。
 */
export function parseKeyStroke(input: string): KeyStroke {
  const raw = input.trim();
  if (!raw) throw new Error("Key binding must be non-empty");
  if (/\s/.test(raw)) {
    throw new Error(
      `Multi-stroke key sequence is not supported yet: "${input}"`
    );
  }

  let body = raw;
  let name: string;
  if (body === "+") {
    name = "+";
  } else if (body.endsWith("+")) {
    body = body.slice(0, -1);
    name = "+";
  } else {
    const parts = body.split("+").map(part => part.trim()).filter(Boolean);
    const last = parts.pop();
    if (!last) throw new Error(`Invalid key binding: "${input}"`);
    name = last;
    body = parts.join("+");
  }

  const stroke: KeyStroke = {
    name: normalizeKeyName(name),
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };
  if (body) {
    for (const part of body.split("+").filter(Boolean)) {
      const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
      if (!modifier) {
        throw new Error(`Unknown key modifier "${part}" in "${input}"`);
      }
      stroke[modifier] = true;
    }
  }
  return stroke;
}

export function formatKeyStroke(stroke: KeyStroke): string {
  const parts: string[] = [];
  if (stroke.ctrl) parts.push("ctrl");
  if (stroke.alt) parts.push("alt");
  if (stroke.shift) parts.push("shift");
  if (stroke.meta) parts.push("meta");
  parts.push(stroke.name === " " ? "space" : stroke.name);
  return parts.join("+");
}

export function keyStrokeFromEvent(event: KeyEvent): KeyStroke {
  const name = normalizeKeyName(event.name);
  const inferredShift =
    event.name.length === 1 && event.name !== event.name.toLowerCase();
  return {
    name,
    ctrl: event.modifiers.ctrl,
    alt: event.modifiers.alt,
    shift: event.modifiers.shift || inferredShift,
    meta: event.modifiers.meta,
  };
}

export function matchesKeyStroke(event: KeyEvent, stroke: KeyStroke): boolean {
  const actual = keyStrokeFromEvent(event);
  return (
    actual.name === stroke.name &&
    actual.ctrl === stroke.ctrl &&
    actual.alt === stroke.alt &&
    actual.shift === stroke.shift &&
    actual.meta === stroke.meta
  );
}

function normalizeKeyName(name: string): string {
  const lower = name.toLowerCase();
  if (NAME_ALIASES[lower]) return NAME_ALIASES[lower];
  if (name.length === 1) return lower;
  return lower;
}
