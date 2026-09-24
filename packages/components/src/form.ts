import { createSignal } from "solid-js";

export type FormErrors<T extends object> = Partial<
  Record<keyof T, string | undefined>
>;

export interface FormOptions<T extends object> {
  initialValues: T;
  validate?: (
    values: Readonly<T>
  ) => FormErrors<T> | Promise<FormErrors<T>>;
  onSubmit?: (values: Readonly<T>) => void | Promise<void>;
}

export interface FormModel<T extends object> {
  values(): Readonly<T>;
  value<K extends keyof T>(key: K): T[K];
  setValue<K extends keyof T>(key: K, value: T[K]): void;
  setValues(values: Partial<T>): void;
  reset(values?: Partial<T>): void;
  errors(): FormErrors<T>;
  error<K extends keyof T>(key: K): string | undefined;
  touch<K extends keyof T>(key: K, touched?: boolean): void;
  touched<K extends keyof T>(key: K): boolean;
  dirty(): boolean;
  valid(): boolean;
  submitting(): boolean;
  submitted(): boolean;
  validate(): Promise<boolean>;
  submit(): Promise<boolean>;
}

export function createForm<T extends object>(
  options: FormOptions<T>
): FormModel<T> {
  const initial = { ...options.initialValues } as T;
  const [revision, bumpRevision] = createSignal(0);
  const [submitting, setSubmitting] = createSignal(false);
  const [submitted, setSubmitted] = createSignal(false);
  let current: Readonly<T> = { ...initial };
  let currentErrors: FormErrors<T> = {};
  let touchedKeys = new Set<keyof T>();
  const values = (): Readonly<T> => (revision(), current);
  const errors = (): FormErrors<T> => (revision(), currentErrors);

  const validate = async (): Promise<boolean> => {
    currentErrors = options.validate
      ? await options.validate(values())
      : {};
    bumpRevision(value => value + 1);
    return Object.values(currentErrors).every(value => !value);
  };

  return {
    values,
    value(key) {
      return values()[key];
    },
    setValue(key, value) {
      current = { ...current, [key]: value };
      setSubmitted(false);
      bumpRevision(value => value + 1);
    },
    setValues(next) {
      current = { ...current, ...next };
      setSubmitted(false);
      bumpRevision(value => value + 1);
    },
    reset(next = {}) {
      current = { ...initial, ...next };
      currentErrors = {};
      touchedKeys = new Set();
      setSubmitting(false);
      setSubmitted(false);
      bumpRevision(value => value + 1);
    },
    errors,
    error(key) {
      return errors()[key];
    },
    touch(key, value = true) {
      if (value) touchedKeys.add(key);
      else touchedKeys.delete(key);
      bumpRevision(current => current + 1);
    },
    touched(key) {
      revision();
      return touchedKeys.has(key);
    },
    dirty() {
      const value = values();
      return (Object.keys(initial) as Array<keyof T>).some(
        key => value[key] !== initial[key]
      );
    },
    valid() {
      return Object.values(errors()).every(value => !value);
    },
    submitting,
    submitted,
    validate,
    async submit() {
      if (submitting()) return false;
      setSubmitting(true);
      try {
        if (!(await validate())) return false;
        await options.onSubmit?.(values());
        setSubmitted(true);
        return true;
      } finally {
        setSubmitting(false);
      }
    },
  };
}
