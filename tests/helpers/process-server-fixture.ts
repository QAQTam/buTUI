import { serveProcessRpc } from "../../packages/plugins/src/process-rpc.ts";

serveProcessRpc({
  echo(value: unknown) {
    return value;
  },
  sum(left: number, right: number) {
    return left + right;
  },
});
