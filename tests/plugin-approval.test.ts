import { describe, expect, test } from "bun:test";
import {
  CapabilityApprovalQueue,
  createCapabilityApprover,
} from "@butui/plugins";
import type { CapabilityApprovalRequest } from "@butui/plugins/loader";

function request(capability: string): CapabilityApprovalRequest {
  return {
    pluginId: "plugin",
    module: "./plugin.ts",
    path: "/tmp/plugin.ts",
    capability,
    manifest: {
      entry: "./plugin.ts",
      id: "plugin",
      capabilities: [capability],
    },
  };
}

describe("CapabilityApprovalQueue", () => {
  test("pending / approve / deny 与事件顺序", async () => {
    let now = 0;
    const queue = new CapabilityApprovalQueue({ now: () => now });
    const events: string[] = [];
    queue.onEvent(event => events.push(event.type));

    const first = queue.request(request("fs:read"));
    now = 10;
    const second = queue.request(request("network"));
    expect(queue.pending().map(item => item.request.capability)).toEqual([
      "fs:read",
      "network",
    ]);

    expect(queue.resolve(1, true)).toBe(true);
    expect(await first).toBe(true);
    expect(queue.resolve(1, true)).toBe(false);

    expect(queue.resolve(2, false)).toBe(true);
    expect(await second).toBe(false);
    expect(queue.pending()).toEqual([]);
    expect(events).toEqual(["requested", "requested", "resolved", "resolved"]);
  });

  test("dispose 拒绝所有 pending，adapter 可直接用于 loader", async () => {
    const queue = new CapabilityApprovalQueue();
    const approver = createCapabilityApprover(queue);
    const pending = approver(request("network"));
    expect(queue.pending()).toHaveLength(1);

    queue.dispose();
    expect(await pending).toBe(false);
    expect(await approver(request("fs:read"))).toBe(false);
  });
});
