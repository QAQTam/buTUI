import { describe, expect, test } from "bun:test";
import { CapabilityBroker, createMemoryAuditLog } from "@butui/plugins";

describe("CapabilityBroker", () => {
  test("grant / has / revoke 与事件", () => {
    const audit = createMemoryAuditLog({ now: () => 100 });
    const broker = new CapabilityBroker({ now: () => 100, audit });
    const events: string[] = [];
    broker.onEvent(event => events.push(event.type));

    const lease = broker.grant("plugin", "fs:read");
    expect(lease).toMatchObject({
      pluginId: "plugin",
      capability: "fs:read",
      grantedAt: 100,
      state: "active",
    });
    expect(broker.has("plugin", "fs:read")).toBe(true);
    expect(broker.has("other", "fs:read")).toBe(false);

    expect(broker.revoke(lease, "user")).toBe(true);
    expect(broker.revoke(lease, "again")).toBe(false);
    expect(broker.has("plugin", "fs:read")).toBe(false);
    expect(events).toEqual(["granted", "revoked"]);
    expect(audit.query().map(event => event.type)).toEqual([
      "capability.granted",
      "capability.revoked",
    ]);
    broker.dispose();
  });

  test("TTL 到期自动 expired，revokeAll 回收插件全部 lease", () => {
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextHandle = 1;
    const broker = new CapabilityBroker({
      now: () => now,
      setTimeout(callback, delay) {
        const handle = nextHandle++;
        timers.set(handle, () => {
          now += delay;
          callback();
        });
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(handle) {
        timers.delete(handle as unknown as number);
      },
    });

    const expiring = broker.grant("plugin", "fs:read", { ttlMs: 50 });
    broker.grant("plugin", "network");
    broker.grant("other", "fs:read");
    const timer = [...timers.values()][0]!;
    timer();

    expect(expiring.state).toBe("expired");
    expect(broker.has("plugin", "fs:read")).toBe(false);
    expect(broker.has("plugin", "network")).toBe(true);
    expect(broker.revokeAll("plugin", "unload")).toBe(1);
    expect(broker.active("plugin")).toEqual([]);
    expect(broker.active("other")).toHaveLength(1);
    broker.dispose();
  });
});
