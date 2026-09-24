import path from "node:path";

/**
 * 插件包 manifest。
 *
 * 支持两种声明位置：
 *   1. 包根目录 `butui.plugin.json`
 *   2. `package.json` 的 `"butui"` 字段
 *
 * `entry` 相对 manifest 所在目录解析。其他字段只是注册时的默认值，应用配置
 * 可以覆盖。
 */
export interface PluginManifest {
  /** 插件入口，必须是包内相对路径。 */
  entry: string;
  /** 默认插件 id；实际插件对象仍可覆盖。 */
  id?: string;
  /** 默认排序值。 */
  order?: number;
}

export interface PluginManifestFile {
  /** manifest 所在目录（插件包根目录）。 */
  dir: string;
  /** manifest 文件路径。 */
  path: string;
  manifest: PluginManifest;
}

/** identity helper：让插件作者获得类型提示，不改变运行时对象。 */
export function definePluginManifest(manifest: PluginManifest): PluginManifest {
  return manifest;
}

/** 只读取指定目录，不向父目录查找。 */
export async function readPluginManifest(
  dir: string
): Promise<PluginManifestFile | null> {
  const root = path.resolve(dir);
  const standalone = path.join(root, "butui.plugin.json");
  if (await Bun.file(standalone).exists()) {
    const value: unknown = await Bun.file(standalone).json();
    return {
      dir: root,
      path: standalone,
      manifest: validateManifest(value, standalone),
    };
  }

  const packagePath = path.join(root, "package.json");
  if (!(await Bun.file(packagePath).exists())) return null;
  const packageJson: unknown = await Bun.file(packagePath).json();
  if (!isRecord(packageJson) || packageJson.butui === undefined) return null;
  return {
    dir: root,
    path: packagePath,
    manifest: validateManifest(packageJson.butui, packagePath),
  };
}

/** 从 `startDir` 向父目录查找最近的 manifest。 */
export async function findPluginManifest(
  startDir: string
): Promise<PluginManifestFile | null> {
  let current = path.resolve(startDir);
  for (;;) {
    const found = await readPluginManifest(current);
    if (found) return found;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 解析 manifest 的入口绝对路径。 */
export function resolveManifestEntry(manifestFile: PluginManifestFile): string {
  return path.resolve(manifestFile.dir, manifestFile.manifest.entry);
}

function validateManifest(value: unknown, source: string): PluginManifest {
  if (!isRecord(value)) {
    throw new Error(`Invalid buTUI plugin manifest at ${source}: expected object`);
  }
  const entry = value.entry;
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(
      `Invalid buTUI plugin manifest at ${source}: "entry" must be a non-empty string`
    );
  }
  if (value.id !== undefined && (typeof value.id !== "string" || value.id.length === 0)) {
    throw new Error(
      `Invalid buTUI plugin manifest at ${source}: "id" must be a non-empty string`
    );
  }
  if (value.order !== undefined && !Number.isFinite(value.order)) {
    throw new Error(
      `Invalid buTUI plugin manifest at ${source}: "order" must be a finite number`
    );
  }

  return {
    entry,
    ...(value.id !== undefined ? { id: value.id as string } : {}),
    ...(value.order !== undefined ? { order: value.order as number } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
