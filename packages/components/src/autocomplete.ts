import type { SelectOption } from "./select.tsx";

export function filterAutocompleteOptions<T>(
  options: readonly SelectOption<T>[],
  query: string
): SelectOption<T>[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return options.filter(option => option.heading !== true && !option.disabled);
  }
  return options
    .map(option => ({ option, score: autocompleteScore(option, normalized) }))
    .filter(entry => entry.score >= 0 && entry.option.heading !== true)
    .sort((left, right) => left.score - right.score)
    .map(entry => entry.option);
}

function autocompleteScore<T>(
  option: SelectOption<T>,
  query: string
): number {
  const candidates = [
    option.label,
    String(option.value),
    option.description ?? "",
  ].map(value => value.toLocaleLowerCase());
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === query) best = Math.min(best, 0);
    else if (candidate.startsWith(query)) best = Math.min(best, 1);
    else if (candidate.includes(query)) best = Math.min(best, 2);
    else if (isSubsequence(query, candidate)) best = Math.min(best, 3);
  }
  return Number.isFinite(best) ? best : -1;
}

function isSubsequence(query: string, value: string): boolean {
  let index = 0;
  for (const char of value) {
    if (char === query[index]) index++;
    if (index === query.length) return true;
  }
  return query.length === 0;
}
