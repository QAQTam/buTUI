import { useAppScope } from "@butui/solid";
import { onCleanup } from "solid-js";
import type { Keymap } from "./keymap.ts";

export interface UseKeymapOptions {
  /** 临时关闭（例如弹窗接管键盘时）。 */
  enabled?: () => boolean;
}

/**
 * 把 keymap 接到组件级全局按键。
 *
 * runtime 的 `keymap` 选项适合应用级快捷键；这个 hook 适合局部组件或插件
 * 在挂载期间临时加入一层 keymap。
 */
export function useKeymap(
  keymap: Keymap,
  options: UseKeymapOptions = {}
): void {
  const scope = useAppScope();
  if (!scope) return;
  const dispose = scope.onKey(event => {
    if (options.enabled && !options.enabled()) return;
    return keymap.handle(event);
  });
  onCleanup(dispose);
}
