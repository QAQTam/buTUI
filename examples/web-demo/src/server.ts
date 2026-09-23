/**
 * Web demo 服务端。
 *
 *   bun --conditions=browser run examples/web-demo/src/server.ts
 *   然后打开 http://localhost:3210
 *
 * 服务端只做两件事：跑 agent、把事件写成 NDJSON 流。它不认识任何 UI。
 */
import { fileURLToPath } from "node:url";
import { type AgentEvent, type UiCommand, createNdjsonDecoder, encodeNdjson } from "@butui/agent";
import { butui } from "@butui/solid/plugin";
import { createWebAgent } from "./mock-agent.ts";

const PORT = Number(process.env.PORT ?? 3210);
const encoder = new TextEncoder();

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function broadcast(event: AgentEvent): void {
  const line = encoder.encode(encodeNdjson(event));
  for (const controller of clients) {
    try {
      controller.enqueue(line);
    } catch {
      clients.delete(controller);
    }
  }
}

const agent = createWebAgent(broadcast);

// 用同一个编译插件把浏览器端打包出来（dom 目标）
const build = await Bun.build({
  // 注意：URL.pathname 会把中文路径 percent-encode，必须用 fileURLToPath
  entrypoints: [fileURLToPath(new URL("./client.tsx", import.meta.url))],
  target: "browser",
  plugins: [
    butui({
      targets: [{ include: /client\.tsx$/, generate: "dom", moduleName: "@solidjs/web" }],
    }),
  ],
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error("client bundle 失败");
}
const clientJs = await build.outputs[0].text();

const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>buTUI · WebUI</title>
<style>body{margin:0;background:#020617;min-height:100vh;padding:24px}</style>
</head>
<body><div id="root"></div><script type="module" src="/client.js"></script></body>
</html>`;

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  routes: {
    "/": () => new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
    "/client.js": () =>
      new Response(clientJs, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
    "/events": () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            clients.add(controller);
            controller.enqueue(encoder.encode(`: connected (${clients.size})\n`));
          },
          cancel(controller) {
            clients.delete(controller as unknown as ReadableStreamDefaultController<Uint8Array>);
          },
        }),
        {
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        }
      ),
    "/command": {
      POST: async request => {
        const decode = createNdjsonDecoder<UiCommand>();
        for (const command of decode(await request.text())) agent.handle(command);
        return new Response("ok");
      },
    },
  },
});

console.log(`buTUI WebUI → http://localhost:${server.port}`);
agent.start();
