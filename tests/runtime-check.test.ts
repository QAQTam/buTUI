import { describe, expect, test } from "bun:test";
import {
  CONDITIONS_HINT,
  assertSolidClientBuild,
  checkSolidRuntime,
} from "@butui/solid";
import { detectColorDepth, terminalSize } from "@butui/terminal";

describe("solid-js 解析守卫（SPEC §5 的隐性坑）", () => {
  test("server 构建被识别为错误", () => {
    const result = checkSolidRuntime("/app/node_modules/solid-js/dist/server.js");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("server");
  });

  test("server.dev.js / server.observe.js 同样命中", () => {
    expect(checkSolidRuntime("/x/solid-js/dist/server.dev.js").ok).toBe(false);
    expect(checkSolidRuntime("/x/solid-js/dist/server.observe.js").ok).toBe(false);
  });

  test("客户端构建通过", () => {
    expect(checkSolidRuntime("/x/solid-js/dist/solid.js").ok).toBe(true);
  });

  test("解析不到时不阻塞（某些打包器不实现 import.meta.resolve）", () => {
    expect(checkSolidRuntime(undefined).ok).toBe(true);
  });

  test("当前测试进程确实是 browser 条件（否则说明 bunfig/CLI 配错了）", () => {
    const result = assertSolidClientBuild();
    expect(result.ok).toBe(true);
    expect(result.resolved).toContain("solid.js");
    expect(CONDITIONS_HINT).toContain("--conditions=browser");
  });
});

describe("终端能力探测（SPEC §9.3 渐进增强）", () => {
  test("NO_COLOR 降级为无色", () => {
    expect(detectColorDepth({ NO_COLOR: "1", TERM: "xterm-256color" })).toBe("none");
  });

  test("TERM=dumb 降级为无色", () => {
    expect(detectColorDepth({ TERM: "dumb" })).toBe("none");
  });

  test("COLORTERM=truecolor", () => {
    expect(detectColorDepth({ TERM: "xterm-kitty", COLORTERM: "truecolor" })).toBe("truecolor");
  });

  test("256 色", () => {
    expect(detectColorDepth({ TERM: "xterm-256color" })).toBe("256");
  });

  test("普通终端回落到 16 色", () => {
    expect(detectColorDepth({ TERM: "xterm" })).toBe("16");
  });

  test("非 TTY 环境下 terminalSize 给出安全默认值", () => {
    const size = terminalSize();
    expect(size.columns).toBeGreaterThan(0);
    expect(size.rows).toBeGreaterThan(0);
  });
});
