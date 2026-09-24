import type { KeyEvent } from "@butui/core";
import {
  CommandRegistry,
  type Command,
  type CommandRegistryOptions,
} from "./commands.ts";
import {
  formatKeySequence,
  formatKeyStroke,
  keyStrokeFromEvent,
  parseKeySequence,
  type KeyStroke,
} from "./keys.ts";

export interface BindingOptions {
  /** 只有该 scope 在栈里时才生效；未指定表示全局。 */
  scope?: string;
  /** 动态条件；返回 false 时继续找下一条绑定。 */
  when?: () => boolean;
  /** 越大越优先；scope 深度优先于 priority。 */
  priority?: number;
  /** 传给命令的参数。 */
  args?: unknown;
}

export interface KeyBinding {
  sequence: string;
  command: string;
  scope?: string;
  priority: number;
  when?: () => boolean;
  args?: unknown;
}

export interface KeyHelpEntry extends KeyBinding {
  title?: string;
  description?: string;
}

export interface KeyConflict {
  sequence: string;
  scope?: string;
  bindings: KeyHelpEntry[];
}

export interface KeymapOptions extends CommandRegistryOptions {
  commands?: CommandRegistry;
  /** chord 前缀等待多久自动提交精确绑定，默认 1000ms。 */
  chordTimeout?: number;
}

interface InternalBinding extends KeyBinding {
  strokes: KeyStroke[];
  order: number;
}

interface Candidate {
  binding: InternalBinding;
  scopeIndex: number;
}

/**
 * 作用域 keymap。
 *
 * 命令和按键分离：命令注册表负责执行，keymap 只负责「当前 scope 下哪个
 * command 应该被这个 KeyEvent 触发」。
 */
export class Keymap {
  readonly commands: CommandRegistry;
  private bindings: InternalBinding[] = [];
  private scopeStack: string[] = [];
  private listeners = new Set<() => void>();
  private order = 0;
  private readonly offCommands: () => void;
  private readonly chordTimeout: number;
  private pendingStrokes: KeyStroke[] = [];
  private pendingEvent: KeyEvent | undefined;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: KeymapOptions = {}) {
    this.commands = options.commands ?? new CommandRegistry(options);
    this.chordTimeout = Math.max(1, options.chordTimeout ?? 1000);
    this.offCommands = this.commands.subscribe(() => this.notify());
  }

  bind(sequence: string, command: string, options: BindingOptions = {}): () => void {
    const strokes = parseKeySequence(sequence);
    const binding: InternalBinding = {
      sequence: formatKeySequence(strokes),
      command,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      priority: options.priority ?? 0,
      ...(options.when ? { when: options.when } : {}),
      ...("args" in options ? { args: options.args } : {}),
      strokes,
      order: this.order++,
    };
    this.bindings.push(binding);
    this.notify();
    return () => {
      const index = this.bindings.indexOf(binding);
      if (index === -1) return;
      this.bindings.splice(index, 1);
      this.notify();
    };
  }

  /** 注册命令并绑定一个或多个按键，返回一次性清理函数。 */
  bindCommand(
    command: Command,
    sequences: string | readonly string[],
    options: BindingOptions = {}
  ): () => void {
    const removeCommand = this.commands.register(command);
    const removers: Array<() => void> = [];
    try {
      for (const sequence of Array.isArray(sequences) ? sequences : [sequences]) {
        removers.push(this.bind(sequence, command.id, options));
      }
    } catch (error) {
      for (const remove of removers.reverse()) remove();
      removeCommand();
      throw error;
    }
    return () => {
      for (const remove of removers.reverse()) remove();
      removeCommand();
    };
  }

  unbind(
    sequence: string,
    options: { scope?: string; command?: string } = {}
  ): number {
    const canonical = formatKeySequence(parseKeySequence(sequence));
    const before = this.bindings.length;
    this.bindings = this.bindings.filter(binding => {
      if (binding.sequence !== canonical) return true;
      if (options.scope !== undefined && binding.scope !== options.scope) return true;
      if (options.command !== undefined && binding.command !== options.command) {
        return true;
      }
      return false;
    });
    const removed = before - this.bindings.length;
    if (removed > 0) this.notify();
    return removed;
  }

  pushScope(scope: string): () => void {
    if (!scope) throw new Error("Scope must be non-empty");
    this.clearPending();
    this.scopeStack.push(scope);
    this.notify();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.scopeStack.lastIndexOf(scope);
      if (index !== -1) this.scopeStack.splice(index, 1);
      this.notify();
    };
  }

  popScope(scope?: string): boolean {
    const index =
      scope === undefined ? this.scopeStack.length - 1 : this.scopeStack.lastIndexOf(scope);
    if (index < 0) return false;
    this.clearPending();
    this.scopeStack.splice(index, 1);
    this.notify();
    return true;
  }

  setScopes(scopes: readonly string[]): void {
    this.clearPending();
    this.scopeStack = [...scopes];
    this.notify();
  }

  scopes(): readonly string[] {
    return [...this.scopeStack];
  }

  /**
   * 处理一次按键。命中并成功执行命令时 `preventDefault()` 并返回 true。
   *
   * chord 前缀本身也返回 true（消费该键）；如果同一前缀还有精确绑定，会等待
   * `chordTimeout` 或 `flushPending()`，避免 `g` / `g g` 共存时误触。
   */
  handle(event: KeyEvent): boolean {
    const stroke = keyStrokeFromEvent(event);

    if (this.pendingStrokes.length > 0) {
      const combined = [...this.pendingStrokes, stroke];
      const matched = this.match(combined);
      if (matched.exact.length > 0 || matched.prefixes.length > 0) {
        this.pendingStrokes = combined;
        this.pendingEvent = event;
        if (matched.exact.length > 0 && matched.prefixes.length === 0) {
          const executed = this.executeCandidates(matched.exact, event);
          this.clearPending();
          return executed;
        }
        this.schedulePendingTimeout();
        return true;
      }

      this.flushPending();
    }

    const matched = this.match([stroke]);
    if (matched.prefixes.length > 0) {
      this.pendingStrokes = [stroke];
      this.pendingEvent = event;
      this.schedulePendingTimeout();
      return true;
    }
    return matched.exact.length > 0
      ? this.executeCandidates(matched.exact, event)
      : false;
  }

  /** 当前未完成的 chord 前缀；没有时返回 undefined。 */
  pendingSequence(): string | undefined {
    return this.pendingStrokes.length > 0
      ? formatKeySequence(this.pendingStrokes)
      : undefined;
  }

  /** 立即提交当前前缀的精确绑定（如果有），用于测试或显式超时。 */
  flushPending(): boolean {
    const event = this.pendingEvent;
    const pending = [...this.pendingStrokes];
    if (!event || pending.length === 0) {
      this.clearPending();
      return false;
    }
    const matched = this.match(pending);
    const executed =
      matched.exact.length > 0
        ? this.executeCandidates(matched.exact, event)
        : false;
    this.clearPending();
    return executed;
  }

  private match(sequence: readonly KeyStroke[]): {
    exact: Candidate[];
    prefixes: Candidate[];
  } {
    const candidates = this.bindings
      .filter(binding => this.startsWith(binding.strokes, sequence))
      .filter(binding => !binding.when || binding.when())
      .map(binding => ({
        binding,
        scopeIndex: binding.scope ? this.scopeStack.lastIndexOf(binding.scope) : -1,
      }))
      .filter(candidate => candidate.binding.scope === undefined || candidate.scopeIndex !== -1)
      .sort((left, right) => {
        if (left.scopeIndex !== right.scopeIndex) {
          return right.scopeIndex - left.scopeIndex;
        }
        if (left.binding.priority !== right.binding.priority) {
          return right.binding.priority - left.binding.priority;
        }
        return right.binding.order - left.binding.order;
      });

    return {
      exact: candidates.filter(candidate => candidate.binding.strokes.length === sequence.length),
      prefixes: candidates.filter(candidate => candidate.binding.strokes.length > sequence.length),
    };
  }

  private startsWith(full: readonly KeyStroke[], prefix: readonly KeyStroke[]): boolean {
    if (full.length < prefix.length) return false;
    return prefix.every((stroke, index) => sameStroke(stroke, full[index]!));
  }

  private executeCandidates(candidates: readonly Candidate[], event: KeyEvent): boolean {
    for (const { binding } of candidates) {
      if (
        this.commands.execute(binding.command, {
          event,
          source: "keymap",
          ...("args" in binding ? { args: binding.args } : {}),
        })
      ) {
        event.preventDefault();
        return true;
      }
    }
    return false;
  }

  private schedulePendingTimeout(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.flushPending();
    }, this.chordTimeout);
    (this.pendingTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pendingStrokes = [];
    this.pendingEvent = undefined;
  }

  help(): KeyHelpEntry[] {
    return [...this.bindings]
      .sort((left, right) => {
        const bySequence = left.sequence.localeCompare(right.sequence);
        if (bySequence !== 0) return bySequence;
        return (left.scope ?? "").localeCompare(right.scope ?? "");
      })
      .map(binding => this.helpEntry(binding));
  }

  /**
   * 静态冲突：同一 sequence + scope 下有多条无 `when` 的绑定。
   * 有 `when` 的绑定按动态分派处理，不报冲突。
   */
  conflicts(): KeyConflict[] {
    const groups = new Map<string, InternalBinding[]>();
    for (const binding of this.bindings) {
      const key = `${binding.sequence}\0${binding.scope ?? ""}`;
      const group = groups.get(key);
      if (group) group.push(binding);
      else groups.set(key, [binding]);
    }

    const conflicts: KeyConflict[] = [];
    for (const group of groups.values()) {
      const unconditional = group.filter(binding => !binding.when);
      if (unconditional.length < 2) continue;
      conflicts.push({
        sequence: group[0]!.sequence,
        ...(group[0]!.scope !== undefined ? { scope: group[0]!.scope } : {}),
        bindings: group.map(binding => this.helpEntry(binding)),
      });
    }
    return conflicts;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.clearPending();
    if (this.bindings.length === 0) return;
    this.bindings = [];
    this.notify();
  }

  dispose(): void {
    this.clear();
    this.offCommands();
    this.listeners.clear();
  }

  private helpEntry(binding: InternalBinding): KeyHelpEntry {
    const command = this.commands.get(binding.command);
    return {
      sequence: binding.sequence,
      command: binding.command,
      ...(binding.scope !== undefined ? { scope: binding.scope } : {}),
      priority: binding.priority,
      ...(binding.when ? { when: binding.when } : {}),
      ...("args" in binding ? { args: binding.args } : {}),
      ...(command?.title !== undefined ? { title: command.title } : {}),
      ...(command?.description !== undefined
        ? { description: command.description }
        : {}),
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Error in keymap listener:", error);
      }
    }
  }
}

export function createKeymap(options: KeymapOptions = {}): Keymap {
  return new Keymap(options);
}

function sameStroke(left: KeyStroke, right: KeyStroke): boolean {
  return (
    left.name === right.name &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift &&
    left.meta === right.meta
  );
}
