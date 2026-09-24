import { createProcessStdioEndpoint } from "../../packages/plugins/src/process-rpc.ts";
import {
  createWorkerRpc,
  serveWorkerRpc,
} from "../../packages/plugins/src/worker-rpc.ts";

const endpoint = createProcessStdioEndpoint();
const host = createWorkerRpc(endpoint);

serveWorkerRpc(
  {
    echo(value: unknown) {
      return value;
    },
    sum(left: number, right: number) {
      return left + right;
    },
    fail() {
      throw new Error("process failed");
    },
    readViaHost(path: string) {
      return host.call<string>("readFile", path);
    },
    crash() {
      process.exit(17);
    },
  },
  endpoint
);
