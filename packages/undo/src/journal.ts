/**
 * Workspace 变更日志 —— SPEC §8.4 的记录部分。
 *
 * 每个「会改工作区」的工具调用记一条 `WorkspaceChange`：
 *
 *     toolCallId / beforeHash / afterHash / patch / files / reversible
 *
 * 日志只追加、不改写，和 §4.3 的「追加式历史」保持一致。
 */
import type { Todo, ToolCall } from "@butui/agent";
import { type Patch, diffLines, hashContent, reversePatch } from "./patch.ts";

export interface FileChange {
  path: string;
  beforeHash: string;
  afterHash: string;
  /** 把 after 变回 before 的编辑脚本 */
  reverse: Patch;
  reversible: boolean;
}

export interface WorkspaceChange {
  id: string;
  toolCallId: string;
  turnId: string;
  reversible: boolean;
  /** 不可逆的原因（SPEC §8.5：git push / npm publish / curl POST …） */
  irreversibleReason?: string;
  files: FileChange[];
  /** 变更前的 todo 快照，供 undo 回滚（SPEC §8.4 第 5 步） */
  todoBefore?: Todo[];
  createdAt: number;
}

/** 从 before/after 文本构造一条文件变更 */
export function fileChange(
  path: string,
  before: string,
  after: string,
  reversible = true
): FileChange {
  return {
    path,
    beforeHash: hashContent(before),
    afterHash: hashContent(after),
    reverse: reversePatch(diffLines(before, after)),
    reversible,
  };
}

/** SPEC §8.5 的不可逆操作清单 —— 只做识别，不替调用方做决定 */
const IRREVERSIBLE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\s*git\s+push\b/, reason: "git push" },
  { pattern: /^\s*npm\s+publish\b/, reason: "npm publish" },
  { pattern: /^\s*(pnpm|yarn|bun)\s+publish\b/, reason: "package publish" },
  { pattern: /\bcurl\b.*\s(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i, reason: "远程写入" },
  { pattern: /\b(rm|rmdir)\s+-[rf]/, reason: "破坏性文件操作" },
  { pattern: /\bdocker\s+push\b/, reason: "镜像推送" },
];

/** 判断一个工具调用是否不可逆；返回原因或 undefined */
export function irreversibleReason(call: ToolCall): string | undefined {
  const command = typeof call.args === "object" && call.args !== null
    ? String((call.args as { command?: unknown }).command ?? "")
    : "";
  for (const { pattern, reason } of IRREVERSIBLE_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return undefined;
}

export class Journal {
  private readonly entries: WorkspaceChange[] = [];
  private sequence = 0;

  get changes(): readonly WorkspaceChange[] {
    return this.entries;
  }

  record(change: Omit<WorkspaceChange, "id" | "createdAt"> & { createdAt?: number }): WorkspaceChange {
    const entry: WorkspaceChange = {
      ...change,
      id: `wc${++this.sequence}`,
      createdAt: change.createdAt ?? 0,
    };
    this.entries.push(entry);
    return entry;
  }

  forToolCall(toolCallId: string): readonly WorkspaceChange[] {
    return this.entries.filter(change => change.toolCallId === toolCallId);
  }

  forTurns(turnIds: ReadonlySet<string>): readonly WorkspaceChange[] {
    return this.entries.filter(change => turnIds.has(change.turnId));
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}
