import {
  createWorkerRpc,
  serveWorkerRpc,
} from "../../packages/plugins/src/worker-rpc.ts";
import type { WorkerRpcEndpoint } from "../../packages/plugins/src/worker-rpc.ts";

const host = createWorkerRpc(globalThis as unknown as WorkerRpcEndpoint);

serveWorkerRpc({
  echo(value: unknown) {
    return value;
  },
  sum(left: number, right: number) {
    return left + right;
  },
  fail() {
    throw new Error("worker failed");
  },
  async delay(ms: number) {
    await Bun.sleep(ms);
    return ms;
  },
  uncloneable() {
    return { callback() {} };
  },
  readViaHost(path: string) {
    return host.call<string>("readFile", path);
  },
});
