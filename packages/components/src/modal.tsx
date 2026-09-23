/**
 * 按钮 / 弹窗 / 遮罩 —— SPEC §10.1 的 Overlay / Portal / Dialog。
 *
 * 三件东西的分工：
 *
 *   `<Button>`  可聚焦 + Enter/空格/点击触发，焦点态自己会亮
 *   `<Dialog>`  带边框和标题的卡片，**自动 trap 焦点**、Esc 触发 onDismiss
 *   `<Modal>`   把 Dialog 摆到视口正中的一层：`<layer>`（视口坐标）+ 遮罩 + 居中
 *
 * **`<Modal>` 必须挂在视图根部**（顶层 `<box>` 的兄弟节点）。原因：`<layer>`
 * 相对**父节点**定位，而父节点自己会被滚走 —— 只有根上的 layer 才合成在视口
 * 之上（见 layout 的 `layout()`）。放错位置的表现是「弹窗跟着内容一起滚」。
 *
 * ```tsx
 * view: () => (
 *   <>
 *     <box>…主界面…</box>
 *     <Modal open={asking()} title="允许执行？" onDismiss={deny}>
 *       <text>rm -rf node_modules</text>
 *       <row gap={2}>
 *         <Button tone="success" onPress={allow}>允许</Button>
 *         <Button tone="danger" onPress={deny}>拒绝</Button>
 *       </row>
 *     </Modal>
 *   </>
 * )
 * ```
 */
import type { KeyEvent, MouseEvent, Node } from "@butui/core";
import { useFocus, useFocusScope } from "@butui/solid";
import type { JSX } from "@butui/solid/jsx-runtime";
import { Show, createEffect, createSignal } from "solid-js";

export type Tone = "default" | "accent" | "success" | "warning" | "danger" | "muted";

/** 语义色调 → 主题 token。组件统一走这张表，不各自硬编码颜色 */
export const TONE_COLOR: Record<Tone, string> = {
  default: "fg",
  accent: "accent",
  success: "success",
  warning: "warning",
  danger: "danger",
  muted: "muted",
};

export function toneColor(tone: Tone | undefined): string {
  return TONE_COLOR[tone ?? "default"];
}

export interface ButtonProps {
  children?: JSX.Element;
  /** 触发（Enter / 空格 / 点击） */
  onPress?: () => void;
  /** 聚焦时的颜色，默认 accent */
  tone?: Tone;
  /** 不画 `[ ]`，只做焦点高亮 */
  plain?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  semantic?: string;
}

export function Button(props: ButtonProps) {
  const scope = useFocusScope();
  const isFocused = useFocus();
  const [node, setNode] = createSignal<Node>();
  const focused = (): boolean => isFocused(node());

  const press = (): void => {
    if (props.disabled) return;
    props.onPress?.();
  };

  createEffect(
    () => ({ node: node(), auto: props.autoFocus }),
    ({ node: current, auto }) => {
      if (auto && current) scope?.focus(current);
    }
  );

  return (
    <text
      ref={setNode}
      focusable={!props.disabled}
      disabled={props.disabled}
      semantic={props.semantic ?? "button"}
      color={props.disabled ? "muted" : focused() ? toneColor(props.tone ?? "accent") : "fg"}
      bold={focused()}
      onKey={(event: KeyEvent) => {
        // 空格在解码器里就是一个普通字符，name/text 都是 " "
        if (event.name === "enter" || event.name === " ") {
          event.preventDefault();
          press();
        }
      }}
      onClick={(_event: MouseEvent) => press()}
    >
      <Show when={!props.plain} fallback={props.children}>
        {"[ "}
        {props.children}
        {" ]"}
      </Show>
    </text>
  );
}

export interface DialogProps {
  children?: JSX.Element;
  title?: string;
  /** 卡片宽度（cell），默认 50 */
  width?: number;
  tone?: Tone;
  borderColor?: string;
  /**
   * 卡片底色，默认 `"bg"`（不透明）。
   *
   * `<layer>` 默认是**透明**的（没有样式的空白不盖住下面的内容），所以模态框
   * 必须自己声明底色，否则背后的字会从对话框内部透出来。
   */
  bg?: string;
  /** Esc（以及点击遮罩外）触发 */
  onDismiss?: () => void;
  /** 关掉焦点 trap（内联对话框用） */
  modal?: boolean;
  /** 挂载时自动聚焦第一个可聚焦子节点（默认 true） */
  autoFocus?: boolean;
  semantic?: string;
}

/**
 * 对话框卡片。
 *
 * `modal`（默认 true）时会 `trap` 焦点：Tab 只在卡片里循环，关掉之后焦点回到
 * 打开它之前那个节点 —— 所以「权限弹窗关掉，输入框还是刚才那个」是自动的。
 */
export function Dialog(props: DialogProps) {
  const scope = useFocusScope();
  const [node, setNode] = createSignal<Node>();

  createEffect(
    () => ({ node: node(), modal: props.modal !== false }),
    ({ node: current, modal }) => {
      if (!current || !modal || !scope) return;
      // **返回**清理函数，而不是 onCleanup：Solid 2 的 createEffect 只认返回值
      // （effect 体里调 onCleanup 注册的清理在卸载时根本不会跑）
      return scope.trap(current);
    }
  );

  createEffect(
    () => ({ node: node(), auto: props.autoFocus !== false }),
    ({ node: current, auto }) => {
      if (auto && current) scope?.focus(current);
    }
  );

  const dismiss = (): void => props.onDismiss?.();

  return (
    <box
      ref={setNode}
      // 自己也可聚焦：没有任何按钮的对话框里，按键至少有个落点
      focusable
      semantic={props.semantic ?? "dialog"}
      border="round"
      borderColor={props.borderColor ?? toneColor(props.tone ?? "accent")}
      bg={props.bg ?? "bg"}
      padding={1}
      gap={1}
      width={props.width ?? 50}
      onKey={(event: KeyEvent) => {
        if (event.name === "escape") {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <Show when={props.title}>
        <text color={toneColor(props.tone ?? "accent")} bold>
          {props.title}
        </text>
      </Show>
      {props.children}
    </box>
  );
}

export interface ModalProps extends DialogProps {
  open: boolean;
  /** 遮罩填充色；默认不填（只靠对话框自己的边框区分层次） */
  backdrop?: string;
}

/**
 * 居中模态框。**挂在视图根部**（见文件头）。
 *
 * 用 `<Show>` 包住而不是「open 为 false 时隐藏」：关闭时整棵子树被卸载，
 * 焦点 trap 自动释放、内部状态（输入框草稿、异步加载）也跟着清掉。
 */
export function Modal(props: ModalProps) {
  return (
    <Show when={props.open}>
      <layer x={0} y={0}>
        <box
          width="100%"
          height="100%"
          justify="center"
          align="center"
          bg={props.backdrop}
          semantic="overlay"
        >
          <Dialog {...props} modal={props.modal ?? true}>
            {props.children}
          </Dialog>
        </box>
      </layer>
    </Show>
  );
}
