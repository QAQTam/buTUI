import type { KeyEvent } from "@butui/core";

export interface CommandContext {
  command: Command;
  registry: CommandRegistry;
  event?: KeyEvent;
  args?: unknown;
  source?: string;
}

export interface Command {
  id: string;
  title?: string;
  description?: string;
  /** 返回 false 时命令不可执行；keymap 会继续找下一条绑定。 */
  when?: () => boolean;
  run: (context: CommandContext) => void | Promise<void>;
}

export interface CommandErrorEvent {
  commandId: string;
  error: Error;
  timestamp: number;
}

export interface CommandRegistryOptions {
  onError?: (event: CommandErrorEvent) => void;
}

/** identity helper：给命令作者类型提示，不改变运行时对象。 */
export function defineCommand(command: Command): Command {
  return command;
}

/**
 * 命令注册表。
 *
 * 命令本身不认识按键；Keymap 只引用 command id。这样同一个命令可以同时由
 * 快捷键、命令面板、鼠标按钮触发。
 */
export class CommandRegistry {
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();
  private readonly onError?: (event: CommandErrorEvent) => void;

  constructor(options: CommandRegistryOptions = {}) {
    this.onError = options.onError;
  }

  register(command: Command): () => void {
    if (!command.id) throw new Error("Command id must be non-empty");
    if (this.commands.has(command.id)) {
      throw new Error(`Command "${command.id}" is already registered`);
    }
    this.commands.set(command.id, command);
    this.notify();
    return () => {
      this.unregister(command.id);
    };
  }

  unregister(id: string): boolean {
    const removed = this.commands.delete(id);
    if (removed) this.notify();
    return removed;
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  list(): readonly Command[] {
    return [...this.commands.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }

  /**
   * 执行命令。找不到或 `when()` 返回 false 时返回 false。
   *
   * 同步抛错与异步 rejection 都进入 `onError`，不会炸掉调用方。
   */
  execute(
    id: string,
    context: Omit<CommandContext, "command" | "registry"> = {}
  ): boolean {
    const command = this.commands.get(id);
    if (!command) return false;
    if (command.when && !command.when()) return false;

    try {
      const result = command.run({
        ...context,
        command,
        registry: this,
      });
      if (isPromiseLike(result)) {
        void result.catch(error => this.reportError(id, error));
      }
      return true;
    } catch (error) {
      this.reportError(id, error);
      return false;
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    if (this.commands.size === 0) return;
    this.commands.clear();
    this.notify();
  }

  private reportError(commandId: string, error: unknown): void {
    this.onError?.({
      commandId,
      error: normalizeError(error),
      timestamp: Date.now(),
    });
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Error in command registry listener:", error);
      }
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error(`Unknown command error: ${String(error)}`);
}
