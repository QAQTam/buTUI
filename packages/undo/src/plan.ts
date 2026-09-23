/**
 * Undo 计划 —— SPEC §8.3 的预览 + §8.4 的执行顺序。
 *
 * 关键点：**预览是本地算出来的**，不依赖 agent 告诉 UI「会影响什么」。
 * buTUI 自己持有 workspace 日志，所以能精确列出：
 *
 *     Messages: 4 条将被移出当前分支
 *     Files:    3 个文件将被反向 patch
 *     Todo:     2 项状态将回滚
 *     Irreversible: npm publish
 *     Conflicts: 1 个文件已被外部修改
 */
import type { AgentMessage, Todo, Turn } from "@butui/agent";
import type { WorkspaceChange } from "./journal.ts";
import { applyPatch, hashContent } from "./patch.ts";

export interface UndoPlanInput {
  /** 目标消息 id（点击消息后选中的那个） */
  target: string;
  messages: readonly AgentMessage[];
  turns: readonly Turn[];
  todos: readonly Todo[];
  changes: readonly WorkspaceChange[];
  /** 当前分支；只影响「哪些消息会被移出」的统计 */
  branchId?: string;
  /** 读取文件当前内容；`undefined` 表示文件不存在 */
  read?: (path: string) => string | undefined;
}

export interface UndoPlan {
  target: string;
  targetMsgId: number;
  /** 将被移出当前分支的消息 id */
  messages: string[];
  /** 将被反向 patch 的文件 */
  files: string[];
  /** 回滚后的 todo（取最早那个快照） */
  todos: Todo[];
  /** 不可逆、无法撤销的操作 */
  irreversible: string[];
  /** 已被外部修改、无法安全反向 patch 的文件 */
  conflicts: string[];
  /** 逆序的应用顺序（后发生的先撤） */
  changes: WorkspaceChange[];
}

export function planUndo(input: UndoPlanInput): UndoPlan {
  const target = input.messages.find(m => m.id === input.target);
  const targetMsgId = target?.msgid ?? Number.POSITIVE_INFINITY;

  const messages = input.messages
    .filter(m => m.msgid > targetMsgId)
    .filter(m => input.branchId === undefined || m.branchId === input.branchId)
    .map(m => m.id);

  const turnIds = new Set(
    input.turns.filter(t => t.startMsgId > targetMsgId).map(t => t.id)
  );
  // 后发生的先撤
  const changes = input.changes.filter(c => turnIds.has(c.turnId)).slice().reverse();

  const files: string[] = [];
  const irreversible: string[] = [];
  const conflicts: string[] = [];
  let todos: Todo[] | undefined;
  /**
   * 每个文件只需要校验「最后一次改动」的 afterHash。
   *
   * 链式修改（v1→v2→v3）里，只有 v3 是当前应该看到的内容；拿 c1 的
   * afterHash(v2) 去比当前内容必然误报冲突。撤销过程中会按逆序逐级回退，
   * 每一步的中间态由 applyUndo 用暂存内容校验。
   */
  const lastChangeForFile = new Map<string, (typeof changes)[number]["files"][number]>();

  // todo 要回滚到**最早**那个快照（= 这批变更发生之前的状态），
  // 所以按时间正序找第一个，而不是跟着 changes 的逆序走。
  for (const change of input.changes) {
    if (!turnIds.has(change.turnId) || !change.reversible) continue;
    if (change.todoBefore) {
      todos = change.todoBefore;
      break;
    }
  }

  for (const change of changes) {
    if (!change.reversible) {
      irreversible.push(change.irreversibleReason ?? `${change.toolCallId} 不可撤销`);
      continue;
    }
    for (const file of change.files) {
      if (!files.includes(file.path)) files.push(file.path);
    }
  }

  // 按时间正序找每个文件的最后一次改动
  for (const change of input.changes) {
    if (!turnIds.has(change.turnId) || !change.reversible) continue;
    for (const file of change.files) lastChangeForFile.set(file.path, file);
  }

  // SPEC §8.4 第 1~2 步：当前内容 hash 与记录的 afterHash 不一致 → 冲突
  if (input.read) {
    for (const [path, file] of lastChangeForFile) {
      const current = input.read(path);
      if (current === undefined || hashContent(current) !== file.afterHash) conflicts.push(path);
    }
  }

  return {
    target: input.target,
    targetMsgId,
    messages,
    files,
    todos: todos ?? [...input.todos],
    irreversible,
    conflicts,
    changes,
  };
}

/** 把计划转成 UI 展示用的 effects（SPEC §8.3 的 Undo Preview 列表） */
export function planEffects(plan: UndoPlan): Array<{
  kind: "messages" | "files" | "todo" | "permission";
  description: string;
  count?: number;
  irreversible?: boolean;
}> {
  const effects: Array<{
    kind: "messages" | "files" | "todo" | "permission";
    description: string;
    count?: number;
    irreversible?: boolean;
  }> = [];

  if (plan.messages.length) {
    effects.push({
      kind: "messages",
      description: `${plan.messages.length} 条消息将移出当前分支`,
      count: plan.messages.length,
    });
  }
  if (plan.files.length) {
    effects.push({
      kind: "files",
      description: `${plan.files.length} 个文件将被反向 patch`,
      count: plan.files.length,
    });
  }
  if (plan.todos.length) {
    effects.push({ kind: "todo", description: `todo 将回滚到变更前状态`, count: plan.todos.length });
  }
  for (const reason of plan.irreversible) {
    effects.push({ kind: "permission", description: reason, irreversible: true });
  }
  for (const path of plan.conflicts) {
    effects.push({ kind: "files", description: `${path} 已被外部修改`, irreversible: true });
  }
  return effects;
}

export interface WorkspaceFs {
  read(path: string): string | undefined;
  write(path: string, text: string): void;
}

export interface ApplyUndoResult {
  ok: boolean;
  mode: "branch" | "revert";
  /** 实际被反向 patch 的文件 */
  applied: string[];
  /** 因外部修改而无法安全撤销的文件 */
  conflicts: string[];
  /** 被跳过的不可逆操作 */
  skipped: string[];
}

/**
 * 执行 undo。
 *
 * - `mode: "branch"`：只切分支，不动工作区（SPEC §8.2 的默认语义）
 * - `mode: "revert"`：按逆序应用 reverse patch（SPEC §8.4）
 *
 * revert 是**全有或全无**的：只要有冲突就一个文件都不写，避免留下半截状态。
 * 真正的写入顺序仍然是「后发生的先撤」。
 */
export function applyUndo(
  plan: UndoPlan,
  fs: WorkspaceFs,
  mode: "branch" | "revert"
): ApplyUndoResult {
  if (mode === "branch") {
    return { ok: true, mode, applied: [], conflicts: plan.conflicts, skipped: plan.irreversible };
  }

  if (plan.conflicts.length > 0) {
    return { ok: false, mode, applied: [], conflicts: plan.conflicts, skipped: plan.irreversible };
  }

  // 先算出所有文件的最终内容，全部成功才落盘
  const staged = new Map<string, string>();
  const applied: string[] = [];

  for (const change of plan.changes) {
    if (!change.reversible) continue;
    for (const file of change.files) {
      const current = staged.get(file.path) ?? fs.read(file.path);
      if (current === undefined) {
        return { ok: false, mode, applied: [], conflicts: [file.path], skipped: plan.irreversible };
      }
      if (hashContent(current) !== file.afterHash) {
        return { ok: false, mode, applied: [], conflicts: [file.path], skipped: plan.irreversible };
      }
      const result = applyPatch(current, file.reverse);
      if (!result.ok) {
        return { ok: false, mode, applied: [], conflicts: [file.path], skipped: plan.irreversible };
      }
      staged.set(file.path, result.text);
      if (!applied.includes(file.path)) applied.push(file.path);
    }
  }

  for (const [path, text] of staged) fs.write(path, text);
  return { ok: true, mode, applied, conflicts: [], skipped: plan.irreversible };
}
