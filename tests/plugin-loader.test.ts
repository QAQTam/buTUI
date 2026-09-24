import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SlotRegistry } from "@butui/plugins";
import {
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
            { module: "./factory.ts", id: "factory:one", order: -10 },
          ],
        })
      );
      const json = await readPluginConfig(jsonPath);
      expect(normalizePluginEntries(json)).toEqual([
        { module: "./plain.ts" },
        { module: "./factory.ts", id: "factory:one", order: -10 },
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
