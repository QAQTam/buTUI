import type { SelectOption } from "./select.tsx";

export interface MultiSelectOptions<T> {
  options: () => readonly SelectOption<T>[];
  values: () => readonly T[];
  onChange?: (
    values: readonly T[],
    option?: SelectOption<T>
  ) => void;
}

export interface MultiSelectModel<T> {
  values(): readonly T[];
  selected(value: T): boolean;
  toggle(value: T): boolean;
  setSelected(value: T, selected: boolean): boolean;
  selectAll(): void;
  clear(): void;
  invert(): void;
}

export function createMultiSelect<T>(
  options: MultiSelectOptions<T>
): MultiSelectModel<T> {
  const values = (): readonly T[] => options.values();
  const selected = (value: T): boolean => values().includes(value);
  const selectable = (option: SelectOption<T> | undefined): boolean =>
    option !== undefined && option.heading !== true && option.disabled !== true;

  const commit = (
    next: readonly T[],
    option?: SelectOption<T>
  ): void => {
    options.onChange?.(next, option);
  };

  return {
    values,
    selected,
    toggle(value) {
      const option = options.options().find(item => item.value === value);
      if (!selectable(option)) return false;
      const next = selected(value)
        ? values().filter(item => item !== value)
        : [...values(), value];
      commit(next, option);
      return true;
    },
    setSelected(value, enabled) {
      const option = options.options().find(item => item.value === value);
      if (!selectable(option)) return false;
      if (selected(value) === enabled) return false;
      const next = enabled
        ? [...values(), value]
        : values().filter(item => item !== value);
      commit(next, option);
      return true;
    },
    selectAll() {
      const next = options
        .options()
        .filter(selectable)
        .map(option => option.value);
      if (
        next.length === values().length &&
        next.every(value => values().includes(value))
      ) {
        return;
      }
      commit(next);
    },
    clear() {
      if (values().length === 0) return;
      commit([]);
    },
    invert() {
      const next = options
        .options()
        .filter(selectable)
        .filter(option => !selected(option.value))
        .map(option => option.value);
      commit(next);
    },
  };
}
