/**
 * Terminal mode journal。
 *
 * 记录哪些终端模式由 buTUI 打开，以及对应的恢复序列。所有恢复都走同一份
 * journal，避免 stop / signal / suspend 各写一套漏掉某个模式。
 */
export interface TerminalModeEntry {
  key: string;
  on: string;
  off: string;
}

export class TerminalModeJournal {
  private readonly entries = new Map<string, TerminalModeEntry>();
  private suspended = false;

  activate(key: string, on: string, off: string): void {
    this.entries.set(key, { key, on, off });
  }

  deactivate(key: string): void {
    this.entries.delete(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  snapshot(): readonly TerminalModeEntry[] {
    return [...this.entries.values()];
  }

  /** 临时关闭全部模式；保留 desired state，供 resume() 恢复。 */
  suspend(): string {
    if (this.suspended) return "";
    this.suspended = true;
    return this.offSequence();
  }

  /** suspend() 后按原顺序重新启用。 */
  resume(): string {
    if (!this.suspended) return "";
    this.suspended = false;
    return this.onSequence();
  }

  /** 最终恢复：逆序关闭并清空 journal。 */
  restore(): string {
    const sequence = this.suspended ? "" : this.offSequence();
    this.entries.clear();
    this.suspended = false;
    return sequence;
  }

  /** 当前未 suspend 时重新发送启用序列，用于外部写入后的修复。 */
  reapply(): string {
    if (this.suspended) return "";
    return this.onSequence();
  }

  private onSequence(): string {
    let out = "";
    for (const entry of this.entries.values()) out += entry.on;
    return out;
  }

  private offSequence(): string {
    let out = "";
    for (const entry of [...this.entries.values()].reverse()) out += entry.off;
    return out;
  }
}
