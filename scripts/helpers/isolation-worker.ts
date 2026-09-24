import { serveWorkerRpc } from "../../packages/plugins/src/worker-rpc.ts";

serveWorkerRpc({
  echo(value: unknown) {
    return value;
  },
  sum(left: number, right: number) {
    return left + right;
  },
});
