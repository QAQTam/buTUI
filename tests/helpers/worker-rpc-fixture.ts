import { serveWorkerRpc } from "../../packages/plugins/src/worker-rpc.ts";

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
});
