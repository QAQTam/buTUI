import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CapabilityBroker, SlotRegistry } from "@butui/plugins";
import {
  discoverPlugins,
  findPluginManifest,
  loadPlugins,
  normalizePluginEntries,
  readPluginConfig,
  readPluginManifest,
  resolveManifestEntry,
} from "@butui/plugins/loader";

interface Slots {
  header: { title: string };
}

type Node = { kind: string };

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "butui-plugin-"));
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await tempDir();
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("plugin manifest", () => {
  test("读取 butui.plugin.json，并向父目录查找", async () => {
    await withTempDir(async dir => {
      await writeFile(
        path.join(dir, "butui.plugin.json"),
        JSON.stringify({ entry: "./src/index.ts", id: "demo", order: 3 })
      );
      const found = await readPluginManifest(dir);
      expect(found?.manifest).toEqual({
        entry: "./src/index.ts",
        id: "demo",
        order: 3,
      });
      expect(resolveManifestEntry(found!)).toBe(
        path.join(dir, "src", "index.ts")
      );

      const nested = await findPluginManifest(
        path.join(dir, "src", "nested", "deeper")
      );
      expect(nested?.path).toBe(path.join(dir, "butui.plugin.json"));
    });
  });

  test("支持 package.json 的 butui 字段，非法 manifest 明确抛错", async () => {
    await withTempDir(async dir => {
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "demo", butui: { entry: "./plugin.ts" } })
      );
      const found = await readPluginManifest(dir);
      expect(found?.manifest.entry).toBe("./plugin.ts");

      await writeFile(
        path.join(dir, "butui.plugin.json"),
        JSON.stringify({ entry: "" })
      );
      await expect(readPluginManifest(dir)).rejects.toThrow(
        '"entry" must be a non-empty string'
      );
    });
  });
});

describe("plugin config", () => {
  test("读取 JSON / TS 配置并规范化字符串条目", async () => {
    await withTempDir(async dir => {
      const jsonPath = path.join(dir, "butui.config.json");
      await writeFile(
        jsonPath,
        JSON.stringify({
          plugins: [
            "./plain.ts",
            {
              module: "./factory.ts",
              id: "factory:one",
              order: -10,
              capabilities: ["fs:read"],
            },
          ],
        })
      );
      const json = await readPluginConfig(jsonPath);
      expect(normalizePluginEntries(json)).toEqual([
        { module: "./plain.ts" },
        {
          module: "./factory.ts",
          id: "factory:one",
          order: -10,
          capabilities: ["fs:read"],
        },
      ]);

      const tsPath = path.join(dir, "butui.config.ts");
      await writeFile(
        tsPath,
        `export default { plugins: [{ module: "./plugin.ts", enabled: false, options: { x: 1 } }] };`
      );
      const ts = await readPluginConfig(tsPath);
      expect(normalizePluginEntries(ts)).toEqual([
        { module: "./plugin.ts", enabled: false, options: { x: 1 } },
      ]);
    });
  });

  test("非法配置直接抛错，不进入半加载状态", async () => {
    await withTempDir(async dir => {
      const configPath = path.join(dir, "butui.config.json");
      await writeFile(configPath, JSON.stringify({ plugins: {} }));
      await expect(readPluginConfig(configPath)).rejects.toThrow(
        '"plugins" must be an array'
      );

      expect(() =>
        normalizePluginEntries([{ module: "", id: "bad" } as never])
      ).toThrow('"module" must be a non-empty string');
    });
  });
});

describe("loadPlugins", () => {
  test("按配置加载普通插件、工厂插件和 manifest 插件，并隔离坏模块", async () => {
    await withTempDir(async dir => {
      await writeFile(
        path.join(dir, "plain.ts"),
        `export default {
          id: "plain",
          order: 99,
          slots: { header: (_ctx, props) => ({ kind: "plain:" + props.title }) },
        };`
      );
      await writeFile(
        path.join(dir, "factory.ts"),
        `export default function createPlugin(load) {
          return {
            slots: {
              header: () => ({
                kind: "factory:" + JSON.stringify(load.options) + ":" + load.id,
              }),
            },
          };
        };`
      );
      await writeFile(path.join(dir, "broken.ts"), `throw new Error("broken import");`);

      const packageDir = path.join(dir, "pkg");
      await mkdir(path.join(packageDir, "src"), { recursive: true });
      await writeFile(
        path.join(packageDir, "butui.plugin.json"),
        JSON.stringify({ entry: "./src/index.ts", id: "manifest:plugin", order: -5 })
      );
      await writeFile(
        path.join(packageDir, "src", "index.ts"),
        `export default { slots: { header: () => ({ kind: "manifest" }) } };`
      );

      const host = {};
      const context = { theme: "dark" };
      const registry = new SlotRegistry<Node, Slots, typeof context>(host, context);
      const loaded = await loadPlugins<Node, Slots, typeof context>({
        registry,
        host,
        context,
        cwd: dir,
        entries: [
          "./plain.ts",
          {
            module: "./factory.ts",
            id: "factory:one",
            order: -10,
            options: { x: 1 },
          },
          "./broken.ts",
          "./pkg/src/index.ts",
        ],
      });

      expect(loaded.ids).toEqual(["plain", "factory:one", "manifest:plugin"]);
      expect(registry.resolveEntries("header").map(entry => entry.id)).toEqual([
        "factory:one",
        "manifest:plugin",
        "plain",
      ]);
      expect(loaded.errors).toHaveLength(1);
      expect(loaded.errors[0]?.phase).toBe("load");
      expect(loaded.errors[0]?.pluginId).toBe("./broken.ts");
      expect(loaded.errors[0]?.error.message).toBe("broken import");

      const factory = registry.resolve("header")[0]!;
      expect(factory(context, { title: "x" })).toEqual({
        kind: 'factory:{"x":1}:factory:one',
      });

      loaded.dispose();
      expect(registry.resolveEntries("header")).toEqual([]);
      expect(registry.has("plain")).toBe(false);
    });
  });

  test("enabled=false 不加载；重复 id 作为单条 load 错误隔离", async () => {
    await withTempDir(async dir => {
      await writeFile(
        path.join(dir, "plugin.ts"),
        `export default { id: "same", slots: { header: () => ({ kind: "ok" }) } };`
      );
      const host = {};
      const registry = new SlotRegistry<Node, Slots>(host, {});
      const loaded = await loadPlugins<Node, Slots>({
        registry,
        host,
        context: {},
        cwd: dir,
        entries: [
          { module: "./plugin.ts", enabled: false },
          "./plugin.ts",
          { module: "./plugin.ts", id: "same" },
        ],
      });

      expect(loaded.ids).toEqual(["same"]);
      expect(loaded.errors).toHaveLength(1);
      expect(loaded.errors[0]?.phase).toBe("load");
      expect(registry.resolveEntries("header")).toHaveLength(1);
      loaded.dispose();
    });
  });
});

describe("discoverPlugins", () => {
  test("默认只发现直接依赖，支持 scoped、全量扫描和 extraDirs", async () => {
    await withTempDir(async dir => {
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "app",
          dependencies: { "butui-direct": "1.0.0" },
        })
      );
      await mkdir(path.join(dir, "node_modules", "butui-direct"), {
        recursive: true,
      });
      await writeFile(
        path.join(dir, "node_modules", "butui-direct", "package.json"),
        JSON.stringify({
          name: "butui-direct",
          butui: { entry: "./index.ts", id: "direct", order: 5 },
        })
      );

      await mkdir(path.join(dir, "node_modules", "butui-transitive"), {
        recursive: true,
      });
      await writeFile(
        path.join(dir, "node_modules", "butui-transitive", "package.json"),
        JSON.stringify({
          name: "butui-transitive",
          butui: { entry: "./index.ts", id: "transitive" },
        })
      );

      await mkdir(path.join(dir, "node_modules", "@scope", "butui-scoped"), {
        recursive: true,
      });
      await writeFile(
        path.join(
          dir,
          "node_modules",
          "@scope",
          "butui-scoped",
          "package.json"
        ),
        JSON.stringify({
          name: "@scope/butui-scoped",
          butui: { entry: "./index.ts", id: "scoped", order: -1 },
        })
      );

      const direct = await discoverPlugins({ cwd: dir });
      expect(direct.plugins.map(plugin => plugin.manifest.id)).toEqual([
        "direct",
      ]);

      const all = await discoverPlugins({ cwd: dir, includeAllInstalled: true });
      expect(all.plugins.map(plugin => plugin.manifest.id)).toEqual([
        "scoped",
        "transitive",
        "direct",
      ]);
      expect(all.entries.find(entry => entry.id === "scoped")?.module).toBe(
        "@scope/butui-scoped"
      );

      const extraDir = path.join(dir, "local-plugin");
      await mkdir(extraDir, { recursive: true });
      await writeFile(
        path.join(extraDir, "butui.plugin.json"),
        JSON.stringify({ entry: "./plugin.ts", id: "extra" })
      );
      const extra = await discoverPlugins({
        cwd: dir,
        extraDirs: ["local-plugin"],
      });
      expect(extra.entries).toContainEqual({
        module: path.join(extraDir, "plugin.ts"),
        id: "extra",
      });
      expect(extra.entries).toHaveLength(2);
    });
  });
});

describe("plugin capabilities", () => {
  test("能力不足时在 import 前拒绝，授权后才执行模块", async () => {
    await withTempDir(async dir => {
      const marker = `__butui_plugin_loaded_${Date.now()}`;
      await writeFile(
        path.join(dir, "plugin.ts"),
        `globalThis.${marker} = true;
         export default { id: "cap", slots: { header: () => ({ kind: "ok" }) } };`
      );
      await writeFile(
        path.join(dir, "butui.plugin.json"),
        JSON.stringify({
          entry: "./plugin.ts",
          id: "cap",
          capabilities: ["fs:read", "network"],
        })
      );

      const host = {};
      const registry = new SlotRegistry<Node, Slots>(host, {});
      const denied = await loadPlugins<Node, Slots>({
        registry,
        host,
        context: {},
        cwd: dir,
        entries: ["./plugin.ts"],
        allowedCapabilities: ["fs:read"],
      });

      expect(denied.ids).toEqual([]);
      expect(denied.errors[0]?.error.message).toContain(
        "requires capabilities not granted: network"
      );
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();

      const allowed = await loadPlugins<Node, Slots>({
        registry,
        host,
        context: {},
        cwd: dir,
        entries: ["./plugin.ts"],
        allowedCapabilities: ["fs:read", "network"],
      });
      expect(allowed.ids).toEqual(["cap"]);
      expect((globalThis as Record<string, unknown>)[marker]).toBe(true);
      allowed.dispose();
      delete (globalThis as Record<string, unknown>)[marker];
    });
  });

  test("requireCapabilities 可拒绝没有 manifest 的插件", async () => {
    await withTempDir(async dir => {
      await writeFile(
        path.join(dir, "plugin.ts"),
        `export default { id: "loose", slots: {} };`
      );
      const host = {};
      const registry = new SlotRegistry<Node, Slots>(host, {});
      const loaded = await loadPlugins<Node, Slots>({
        registry,
        host,
        context: {},
        cwd: dir,
        entries: ["./plugin.ts"],
        requireCapabilities: true,
      });

      expect(loaded.ids).toEqual([]);
      expect(loaded.errors[0]?.error.message).toContain(
        "does not declare a manifest"
      );
    });
  });

  test("capabilityBroker 在 factory 前签发、dispose 后回收", async () => {
    await withTempDir(async dir => {
      await writeFile(
        path.join(dir, "plugin.ts"),
        `export default function createPlugin(load) {
           const leases = load.capabilities ?? [];
           return {
             id: "lease",
             slots: {
               header: () => ({
                 kind: leases.map(lease => lease.capability + ":" + lease.state).join(","),
               }),
             },
           };
         };`
      );
      await writeFile(
        path.join(dir, "butui.plugin.json"),
        JSON.stringify({
          entry: "./plugin.ts",
          id: "lease",
          capabilities: ["fs:read", "network"],
        })
      );

      const host = {};
      const registry = new SlotRegistry<Node, Slots>(host, {});
      const broker = new CapabilityBroker();
      const loaded = await loadPlugins<Node, Slots>({
        registry,
        host,
        context: {},
        cwd: dir,
        entries: ["./plugin.ts"],
        capabilityBroker: broker,
      });

      expect(loaded.ids).toEqual(["lease"]);
      expect(broker.has("lease", "fs:read")).toBe(true);
      expect(broker.has("lease", "network")).toBe(true);
      expect(registry.resolve("header")[0]!({}, { title: "x" })).toEqual({
        kind: "fs:read:active,network:active",
      });

      loaded.dispose();
      expect(broker.active("lease")).toEqual([]);
      broker.dispose();
    });
  });

  test("approveCapability 可在 import 前逐个审批", async () => {
    await withTempDir(async dir => {
      const marker = `__butui_plugin_approved_${Date.now()}`;
      await writeFile(
        path.join(dir, "plugin.ts"),
        `globalThis.${marker} = true;
         export default { id: "approved", slots: { header: () => ({ kind: "ok" }) } };`
      );
      await writeFile(
        path.join(dir, "butui.plugin.json"),
        JSON.stringify({
          entry: "./plugin.ts",
          id: "approved",
          capabilities: ["fs:read", "network"],
        })
      );

      const deniedRequests: Array<{ capability: string; pluginId: string }> = [];
      const deniedHost = {};
      const denied = await loadPlugins<Node, Slots>({
        registry: new SlotRegistry<Node, Slots>(deniedHost, {}),
        host: deniedHost,
        context: {},
        cwd: dir,
        entries: ["./plugin.ts"],
        allowedCapabilities: ["fs:read"],
        approveCapability(request) {
          deniedRequests.push({
            capability: request.capability,
            pluginId: request.pluginId,
          });
          return false;
        },
      });
      expect(denied.ids).toEqual([]);
      expect(deniedRequests).toEqual([
        { capability: "network", pluginId: "approved" },
      ]);
      expect(denied.errors[0]?.error.message).toContain(
        "requires capabilities denied: network"
      );
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();

      const approvedRequests: Array<{
        capability: string;
        path: string;
      }> = [];
      const host = {};
      const registry = new SlotRegistry<Node, Slots>(host, {});
      const approved = await loadPlugins<Node, Slots>({
        registry,
        host,
        context: {},
        cwd: dir,
        entries: ["./plugin.ts"],
        allowedCapabilities: ["fs:read"],
        approveCapability(request) {
          approvedRequests.push({
            capability: request.capability,
            path: request.path,
          });
          return request.capability === "network";
        },
      });

      expect(approved.ids).toEqual(["approved"]);
      expect(approvedRequests).toEqual([
        {
          capability: "network",
          path: path.join(dir, "plugin.ts"),
        },
      ]);
      expect((globalThis as Record<string, unknown>)[marker]).toBe(true);
      approved.dispose();
      delete (globalThis as Record<string, unknown>)[marker];
    });
  });
});
