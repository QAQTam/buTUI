import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AgentEvent, type UiCommand, createNdjsonDecoder, encodeNdjson } from "@butui/agent";
import { fileURLToPath } from "node:url";

/**
 * Remote attach 集成测试（SPEC §16 v0.3）。
 *
 * 真的起一个服务、真的连 NDJSON 流、真的 POST 命令 —— 验证「服务端只发事件，
 * 客户端跑同一个 Session」这条链路是通的，而不是只测了 reducer。
 */
const PORT = 3211;
const SERVER = fileURLToPath(new URL("../examples/web-demo/src/server.ts", import.meta.url));

let proc: ReturnType<typeof Bun.spawn>;
const decoder = new TextDecoder();

async function waitForServer(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("server 没有在超时内起来");
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "--conditions=browser", "run", SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForServer();
}, 40000);

afterAll(() => {
  proc?.kill();
});

describe("WebUI remote attach", () => {
  test("服务端返回页面与打包好的客户端", async () => {
    const html = await (await fetch(`http://localhost:${PORT}/`)).text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain("/client.js");

    const res = await fetch(`http://localhost:${PORT}/client.js`);
    const js = await res.text();
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(js.length).toBeGreaterThan(1000);
  }, 20000);

  test("NDJSON 事件流：发一条命令，能在流上收到对应事件", async () => {
    const controller = new AbortController();
    const response = await fetch(`http://localhost:${PORT}/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("ndjson");
    const reader = response.body!.getReader();
    const decode = createNdjsonDecoder<AgentEvent>();
    const events: AgentEvent[] = [];

    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          events.push(...decode(decoder.decode(value, { stream: true })));
        }
      } catch {
        // abort 是预期路径
      }
    })();

    await new Promise(r => setTimeout(r, 200));

    const posted = await fetch(`http://localhost:${PORT}/command`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: encodeNdjson({ type: "user.submit", text: "看看 remote attach" } satisfies UiCommand),
    });
    expect(posted.ok).toBe(true);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const deltas = events.filter(e => e.type === "text.delta").length;
      if (events.some(e => e.type === "turn.start") && deltas > 3) break;
      await new Promise(r => setTimeout(r, 100));
    }

    expect(events.some(e => e.type === "turn.start")).toBe(true);
    expect(events.some(e => e.type === "tool.start")).toBe(true);
    expect(events.filter(e => e.type === "text.delta").length).toBeGreaterThan(3);

    controller.abort();
    await pump;
  }, 30000);

  test("多个客户端都能收到同一份事件流", async () => {
    const a = await fetch(`http://localhost:${PORT}/events`);
    const b = await fetch(`http://localhost:${PORT}/events`);
    const readerA = a.body!.getReader();
    const readerB = b.body!.getReader();

    await fetch(`http://localhost:${PORT}/command`, {
      method: "POST",
      body: encodeNdjson({ type: "user.submit", text: "第二个 turn" } satisfies UiCommand),
    });

    const readSome = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      textDecoder: TextDecoder
    ) => {
      let text = "";
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && !text.includes("turn.start")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += textDecoder.decode(value, { stream: true });
      }
      return text;
    };

    const [textA, textB] = await Promise.all([
      readSome(readerA, new TextDecoder()),
      readSome(readerB, new TextDecoder()),
    ]);
    expect(textA).toContain("turn.start");
    expect(textB).toContain("turn.start");

    await readerA.cancel();
    await readerB.cancel();
  }, 30000);
});
