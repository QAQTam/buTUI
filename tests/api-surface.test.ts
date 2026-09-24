import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectApiSurface,
  type ApiSurface,
} from "../scripts/api-surface.ts";

describe("v0.2 API surface", () => {
  test("运行时 value exports 与冻结快照一致", async () => {
    const snapshot = JSON.parse(
      readFileSync(join(process.cwd(), "api-surface.json"), "utf8")
    ) as ApiSurface;
    expect(await collectApiSurface()).toEqual(snapshot);
  });
});
