/**
 * Command Palette 的纯过滤 / 排序模型。
 *
 * 不依赖 UI：应用可以复用同一套评分给 WebUI 或自定义结果列表。
 */
import type { Command } from "@butui/keymap";

export interface CommandFilterOptions {
  /** 是否保留 `when()` 为 false 的命令；默认 false。 */
  includeDisabled?: boolean;
  /** 最多返回多少条；不传不限制。 */
  limit?: number;
}

/** 文本匹配分数；不匹配返回 -Infinity。 */
export function commandTextScore(text: string, query: string): number {
  const source = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;
  if (source === needle) return 1000;
  if (source.startsWith(needle)) return 800 - source.length;
  const at = source.indexOf(needle);
  if (at !== -1) return 600 - at * 2 - source.length;

  let cursor = 0;
  let gap = 0;
  for (const char of needle) {
    const found = source.indexOf(char, cursor);
    if (found === -1) return Number.NEGATIVE_INFINITY;
    gap += Math.max(0, found - cursor);
    cursor = found + 1;
  }
  return 300 - gap * 2 - source.length;
}

export function commandScore(command: Command, query: string): number {
  const needle = query.trim();
  if (!needle) return 0;
  const title = command.title ?? command.id;
  const scores = [
    commandTextScore(title, needle) * 1.2,
    commandTextScore(command.id, needle),
    command.description ? commandTextScore(command.description, needle) * 0.65 : Number.NEGATIVE_INFINITY,
  ];
  return Math.max(...scores);
}

export function filterCommands(
  commands: readonly Command[],
  query: string,
  options: CommandFilterOptions = {}
): Command[] {
  const filtered = commands
    .filter(command => options.includeDisabled === true || !command.when || command.when())
    .map(command => ({ command, score: commandScore(command, query) }))
    .filter(entry => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const leftTitle = left.command.title ?? left.command.id;
      const rightTitle = right.command.title ?? right.command.id;
      const byTitle = leftTitle.localeCompare(rightTitle);
      return byTitle !== 0 ? byTitle : left.command.id.localeCompare(right.command.id);
    })
    .map(entry => entry.command);
  return options.limit === undefined
    ? filtered
    : filtered.slice(0, Math.max(0, Math.floor(options.limit)));
}
