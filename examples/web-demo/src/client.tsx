/** @jsxImportSource @solidjs/web */
/**
 * 浏览器侧入口。
 *
 * 它做三件事：建 Session、连 NDJSON 流、把 UiCommand POST 回去。
 * —— 这就是 SPEC §16 v0.3 的 remote attach，全部代码不到 30 行。
 */
import {
  type AgentEvent,
  type UiCommand,
  createNdjsonDecoder,
  createSession,
  encodeNdjson,
} from "@butui/agent";
import { mountWebUI } from "@butui/web";

const session = createSession({
  width: () => Math.max(40, window.innerWidth - 80),
  onCommand: command => {
    void fetch("/command", {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: encodeNdjson(command),
    });
  },
});

const root = document.getElementById("root");
if (root) mountWebUI(session, root);

const response = await fetch("/events");
const reader = response.body!.getReader();
const text = new TextDecoder();
const decode = createNdjsonDecoder<AgentEvent>();

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  for (const event of decode(text.decode(value, { stream: true }))) session.dispatch(event);
}
void (undefined as unknown as UiCommand);
