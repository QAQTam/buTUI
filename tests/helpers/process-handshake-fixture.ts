import { createProcessStdioEndpoint } from "../../packages/plugins/src/process-rpc.ts";
import { withRpcHandshake } from "../../packages/plugins/src/rpc-handshake.ts";
import {
  createWorkerRpc,
  serveWorkerRpc,
} from "../../packages/plugins/src/worker-rpc.ts";

const endpoint = withRpcHandshake(createProcessStdioEndpoint(), {
  protocol: "butui.plugin",
  version: 1,
  capabilities: ["host-callbacks"],
});
const host = createWorkerRpc(endpoint);

serveWorkerRpc(
  {
    echo(value: unknown) {
      return value;
    },
    sum(left: number, right: number) {
      return left + right;
    },
    readViaHost(path: string) {
      return host.call<string>("readFile", path);
    },
  },
  endpoint
);
