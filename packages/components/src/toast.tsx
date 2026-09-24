import type { KeyEvent } from "@butui/core";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Button, toneColor } from "./modal.tsx";
import type { ToastAction, ToastItem, ToastQueue } from "./toast.ts";

export type ToastPlacement =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface ToastViewportProps {
  queue: ToastQueue;
  placement?: ToastPlacement;
  /** 单条 toast 宽度，默认 42。 */
  width?: number;
  onAction?: (toast: ToastItem, action: ToastAction) => void;
  onDismiss?: (toast: ToastItem) => void;
  /** 点击 action 后是否自动关闭，默认 true。 */
  dismissOnAction?: boolean;
  semantic?: string;
}

/**
 * 顶层 toast 容器。
 *
 * 和 `<Modal>` 一样应挂在视图根节点，内部使用 `<layer>` 合成到当前视口之上。
 */
export function ToastViewport(props: ToastViewportProps) {
  const [revision, bumpRevision] = createSignal(0);
  const unsubscribe = props.queue.onEvent(() =>
    bumpRevision(value => value + 1)
  );
  onCleanup(unsubscribe);

  const placement = (): ToastPlacement =>
    props.placement ?? "bottom-right";
  const vertical = (): "start" | "end" =>
    placement().startsWith("top") ? "start" : "end";
  const horizontal = (): "start" | "end" =>
    placement().endsWith("right") ? "end" : "start";
  const visible = (): readonly ToastItem[] => {
    revision();
    return props.queue.visible();
  };

  const dismiss = (toast: ToastItem): void => {
    if (!toast.dismissible) return;
    if (props.queue.dismiss(toast.id, "manual")) props.onDismiss?.(toast);
  };

  const activate = (toast: ToastItem, action: ToastAction): void => {
    props.onAction?.(toast, action);
    if (props.dismissOnAction !== false) dismiss(toast);
  };

  return (
    <layer x={0} y={0}>
      <box
        width="100%"
        height="100%"
        justify={vertical()}
        align={horizontal()}
        semantic={props.semantic ?? "toast-viewport"}
      >
        <box width={props.width ?? 42} gap={1}>
          <For each={visible()}>
            {toast => (
              <box
                width={props.width ?? 42}
                border="round"
                borderColor={toneColor(toast.tone)}
                bg="bg"
                padding={1}
                gap={1}
                focusable={toast.actions.length > 0 || toast.dismissible}
                semantic={`toast:${toast.id}`}
                onMouseEnter={() => props.queue.pause(toast.id)}
                onMouseLeave={() => props.queue.resume(toast.id)}
                onKey={(event: KeyEvent) => {
                  const semantic =
                    event.target?.kind === "element"
                      ? String(event.target.props.semantic ?? "")
                      : "";
                  if (event.name === "escape") {
                    event.preventDefault();
                    dismiss(toast);
                    return;
                  }
                  if (
                    event.name === "enter" &&
                    !semantic.includes(":action:") &&
                    toast.actions[0]
                  ) {
                    event.preventDefault();
                    activate(toast, toast.actions[0]);
                  }
                }}
              >
                <row gap={1}>
                  <text color={toneColor(toast.tone)} bold>
                    {toast.title}
                    {toast.count > 1 ? ` ×${toast.count}` : ""}
                  </text>
                  <Show when={toast.dismissible}>
                    <text
                      color="muted"
                      semantic={`toast:${toast.id}:dismiss`}
                      onMouseDown={() => dismiss(toast)}
                    >
                      ×
                    </text>
                  </Show>
                </row>
                <Show when={toast.message}>
                  {message => (
                    <text color="muted" wrap>
                      {message()}
                    </text>
                  )}
                </Show>
                <Show when={toast.actions.length > 0}>
                  <row gap={2}>
                    <For each={toast.actions}>
                      {action => (
                        <Button
                          plain
                          tone={toast.tone}
                          semantic={`toast:${toast.id}:action:${action.id}`}
                          onPress={() => activate(toast, action)}
                        >
                          {action.label}
                        </Button>
                      )}
                    </For>
                  </row>
                </Show>
              </box>
            )}
          </For>
        </box>
      </box>
    </layer>
  );
}
