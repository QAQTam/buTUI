import type { KeyEvent } from "@butui/core";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show, createContext, useContext } from "solid-js";
import type { FormModel } from "./form.ts";

const FormContext = createContext<FormModel<object> | null>(null);

export interface FormProps<T extends object> {
  form: FormModel<T>;
  children: JSX.Element;
  /** Enter 提交，默认 true。 */
  submitOnEnter?: boolean;
  /** 成功提交后的 UI 回调；业务提交仍由 model.onSubmit 负责。 */
  onSubmit?: (values: Readonly<T>) => void;
  semantic?: string;
}

export function Form<T extends object>(props: FormProps<T>): JSX.Element {
  const submit = (): void => {
    void props.form.submit().then(success => {
      if (success) props.onSubmit?.(props.form.values());
    });
  };
  return FormContext({
    value: props.form as unknown as FormModel<object>,
    get children() {
      return (
        <box
          semantic={props.semantic ?? "form"}
          onKey={(event: KeyEvent) => {
            if (
              props.submitOnEnter !== false &&
              event.name === "enter" &&
              !event.defaultPrevented
            ) {
              event.preventDefault();
              submit();
            }
          }}
        >
          {props.children}
        </box>
      ) as never;
    },
  }) as unknown as JSX.Element;
}

export function useForm<T extends object>(): FormModel<T> | null {
  return useContext(FormContext) as FormModel<T> | null;
}

export interface FormFieldProps {
  name: string;
  label?: string;
  required?: boolean;
  children: JSX.Element;
}

export function FormField(props: FormFieldProps): JSX.Element {
  const form = useForm<Record<string, unknown>>();
  const error = (): string | undefined =>
    form?.touched(props.name as never)
      ? form.error(props.name as never)
      : undefined;
  return (
    <box gap={1}>
      <Show when={props.label}>
        <row gap={1}>
          <text color="muted">{props.label}</text>
          <Show when={props.required}>
            <text color="danger">*</text>
          </Show>
        </row>
      </Show>
      {props.children}
      <Show when={error()}>
        {message => (
          <text color="danger" semantic={`form:error:${props.name}`}>
            {message()}
          </text>
        )}
      </Show>
    </box>
  );
}
