/**
 * 运行时 API surface 快照。
 *
 * 只记录运行时 value exports；类型导出由 tsc 和 STABILITY.md 覆盖。
 * 用法：
 *   bun --conditions=browser run scripts/api-surface.ts --write
 *   bun --conditions=browser run scripts/api-surface.ts --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const API_PACKAGES = [
  "@butui/core",
  "@butui/layout",
  "@butui/renderer",
  "@butui/runtime",
  "@butui/solid",
  "@butui/terminal",
  "@butui/stream",
  "@butui/components",
  "@butui/keymap",
  "@butui/plugins",
  "@butui/agent",
  "@butui/undo",
  "@butui/image",
  "@butui/web",
  "@butui/test",
] as const;

export type ApiSurface = Record<string, string[]>;

export async function collectApiSurface(): Promise<ApiSurface> {
  const surface: ApiSurface = {};
  for (const packageName of API_PACKAGES) {
    const module = await import(packageName);
    surface[packageName] = Object.keys(module).sort();
  }
  return surface;
}

const snapshotPath = join(process.cwd(), "api-surface.json");

if (import.meta.main) {
  const surface = await collectApiSurface();
  if (process.argv.includes("--write")) {
    writeFileSync(snapshotPath, `${JSON.stringify(surface, null, 2)}\n`);
    console.log(`wrote ${snapshotPath}`);
  } else {
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as ApiSurface;
    if (JSON.stringify(surface) !== JSON.stringify(snapshot)) {
      console.error("API surface changed; run --write only after API review.");
      process.exit(1);
    }
    console.log(`api surface ok (${Object.values(surface).flat().length} value exports)`);
  }
}
