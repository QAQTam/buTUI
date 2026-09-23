/** @jsxImportSource @solidjs/web */
/** WebUI 挂载入口 */
import { render } from "@solidjs/web";
import type { Session } from "@butui/agent";
import { AgentWebView } from "./app.tsx";
import { injectStyles } from "./styles.ts";

export interface MountWebOptions {
  /** 是否注入内置样式，默认 true */
  styles?: boolean;
}

/** 挂载到指定容器，返回 dispose */
export function mountWebUI(
  session: Session,
  container: Element,
  options: MountWebOptions = {}
): () => void {
  if (options.styles !== false) injectStyles(container.ownerDocument ?? document);
  return render(() => <AgentWebView session={session} />, container);
}
