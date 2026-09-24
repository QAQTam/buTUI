import type {
  CapabilityApprovalItem,
  CapabilityApprovalQueue,
} from "@butui/plugins";
import { Show, createSignal, onCleanup } from "solid-js";
import { Button, Modal } from "./modal.tsx";

export interface CapabilityApprovalDialogProps {
  queue: CapabilityApprovalQueue;
  /** 默认 true；false 时保留队列但不显示。 */
  open?: boolean;
  title?: string;
  onDecision?: (
    item: CapabilityApprovalItem,
    approved: boolean
  ) => void;
}

/**
 * capability 审批对话框。
 *
 * 展示队列中的第一项；批准 / 拒绝后队列自动推进到下一条。
 */
export function CapabilityApprovalDialog(
  props: CapabilityApprovalDialogProps
) {
  const [version, setVersion] = createSignal(0);
  const unsubscribe = props.queue.onEvent(() =>
    setVersion(value => value + 1)
  );
  onCleanup(unsubscribe);

  const current = (): CapabilityApprovalItem | undefined => {
    version();
    return props.queue.pending()[0];
  };

  const decide = (approved: boolean): void => {
    const item = current();
    if (!item) return;
    if (props.queue.resolve(item.id, approved)) {
      props.onDecision?.(item, approved);
    }
  };

  return (
    <Show when={(props.open ?? true) && current()}>
      {item => (
        <Modal
          open
          title={props.title ?? "插件权限请求"}
          width={60}
          tone="warning"
          onDismiss={() => decide(false)}
          semantic="plugin-capability-approval"
        >
          <box gap={1}>
            <row gap={1}>
              <text>插件</text>
              <text bold>{item().request.pluginId}</text>
              <text>请求权限</text>
            </row>
            <text color="accent" bold>
              {item().request.capability}
            </text>
            <text color="muted" dim>
              {item().request.path}
            </text>
            <row gap={2} justify="end">
              <Button
                tone="success"
                autoFocus
                semantic="plugin-capability:allow"
                onPress={() => decide(true)}
              >
                允许
              </Button>
              <Button
                tone="danger"
                semantic="plugin-capability:deny"
                onPress={() => decide(false)}
              >
                拒绝
              </Button>
            </row>
          </box>
        </Modal>
      )}
    </Show>
  );
}
