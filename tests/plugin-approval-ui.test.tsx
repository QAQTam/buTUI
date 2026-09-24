import { describe, expect, test } from "bun:test";
import { CapabilityApprovalDialog } from "@butui/components";
import { CapabilityApprovalQueue } from "@butui/plugins";
import type { CapabilityApprovalRequest } from "@butui/plugins/loader";
import { mount } from "@butui/test";

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

describe("<CapabilityApprovalDialog>", () => {
  test("Enter 批准第一项并自动推进到下一项，Esc 拒绝", async () => {
    const queue = new CapabilityApprovalQueue();
    const decisions: Array<[string, boolean]> = [];
    const first = queue.request(request("fs:read"));
    const second = queue.request(request("network"));
    const app = mount(
      () => (
        <CapabilityApprovalDialog
          queue={queue}
          onDecision={(item, approved) =>
            decisions.push([item.request.capability, approved])
          }
        />
      ),
      { width: 80, height: 24 }
    );

    app.flush();
    expect(app.text()).toContain("fs:read");
    expect(app.text()).not.toContain("network");

    app.key("enter");
    expect(await first).toBe(true);
    app.flush();
    expect(app.text()).toContain("network");

    app.key("escape");
    expect(await second).toBe(false);
    app.flush();
    expect(queue.pending()).toEqual([]);
    expect(decisions).toEqual([
      ["fs:read", true],
      ["network", false],
    ]);
    app.unmount();
  });
});
