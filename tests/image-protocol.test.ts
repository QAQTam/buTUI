import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_PRIORITY,
  detectProtocolSupport,
  isNativeProtocol,
  pickProtocol,
} from "@butui/image";

describe("图片协议探测（SPEC §12.1 优先级表）", () => {
  test("优先级顺序就是 SPEC 里写死的顺序", () => {
    expect([...PROTOCOL_PRIORITY]).toEqual(["kitty", "iterm2", "sixel", "halfblock", "placeholder"]);
  });

  test("Kitty 家族：KITTY_WINDOW_ID / TERM / ghostty / konsole", () => {
    expect(detectProtocolSupport({ KITTY_WINDOW_ID: "1" }).kitty).toBe(true);
    expect(detectProtocolSupport({ TERM: "xterm-kitty" }).kitty).toBe(true);
    expect(detectProtocolSupport({ GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" }).kitty).toBe(true);
    expect(detectProtocolSupport({ TERM_PROGRAM: "ghostty" }).kitty).toBe(true);
    expect(detectProtocolSupport({ KONSOLE_VERSION: "220400" }).kitty).toBe(true);
    expect(detectProtocolSupport({ KONSOLE_VERSION: "210000" }).kitty).toBe(false);
    expect(detectProtocolSupport({ TERM: "xterm-256color" }).kitty).toBe(false);
  });

  test("iTerm2 家族：iTerm / WezTerm / VS Code / LC_TERMINAL", () => {
    expect(detectProtocolSupport({ TERM_PROGRAM: "iTerm.app" }).iterm2).toBe(true);
    expect(detectProtocolSupport({ TERM_PROGRAM: "WezTerm" }).iterm2).toBe(true);
    expect(detectProtocolSupport({ TERM_PROGRAM: "vscode" }).iterm2).toBe(true);
    expect(detectProtocolSupport({ LC_TERMINAL: "iTerm2" }).iterm2).toBe(true);
    expect(detectProtocolSupport({ TERM_PROGRAM: "Apple_Terminal" }).iterm2).toBe(false);
  });

  test("Sixel：明确自报家门的终端 + VTE 3.79", () => {
    expect(detectProtocolSupport({ TERM: "xterm-sixel" }).sixel).toBe(true);
    expect(detectProtocolSupport({ TERM_PROGRAM: "mintty" }).sixel).toBe(true);
    expect(detectProtocolSupport({ TERM: "foot" }).sixel).toBe(true);
    expect(detectProtocolSupport({ VTE_VERSION: "7800" }).sixel).toBe(true);
    expect(detectProtocolSupport({ VTE_VERSION: "7600" }).sixel).toBe(false);
  });

  test("tmux / screen 之下原生协议一律按不支持处理（需要透传）", () => {
    const support = detectProtocolSupport({ KITTY_WINDOW_ID: "1", TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux" });
    expect(support.multiplexed).toBe(true);
    expect(support.kitty).toBe(false);
    expect(support.iterm2).toBe(false);
    expect(detectProtocolSupport({ KITTY_WINDOW_ID: "1", STY: "12345.pts-0" }).kitty).toBe(false);
  });

  test("pickProtocol 按优先级挑最高的可用协议", () => {
    expect(pickProtocol({ env: { KITTY_WINDOW_ID: "1", TERM_PROGRAM: "iTerm.app" } })).toBe("kitty");
    expect(pickProtocol({ env: { TERM_PROGRAM: "iTerm.app", TERM: "xterm-sixel" } })).toBe("iterm2");
    expect(pickProtocol({ env: { TERM: "xterm-sixel" } })).toBe("sixel");
    expect(pickProtocol({ env: { TERM: "xterm-256color" } })).toBe("halfblock");
  });

  test("NO_COLOR / dumb 终端直接降到占位符", () => {
    expect(pickProtocol({ env: { TERM: "xterm-256color" }, depth: "none" })).toBe("placeholder");
    expect(pickProtocol({ env: { NO_COLOR: "1", TERM: "xterm-256color" }, depth: "none" })).toBe(
      "placeholder"
    );
    // 即使终端支持 Kitty，没有颜色能力时也不该假装能画
    expect(pickProtocol({ env: { KITTY_WINDOW_ID: "1" }, depth: "none" })).toBe("kitty");
  });

  test("force 覆盖一切（用户显式指定协议）", () => {
    expect(pickProtocol({ env: { KITTY_WINDOW_ID: "1" }, force: "placeholder" })).toBe("placeholder");
    expect(pickProtocol({ env: {}, force: "sixel" })).toBe("sixel");
  });

  test("原生协议 = 不进 cell 网格的那三个", () => {
    expect(isNativeProtocol("kitty")).toBe(true);
    expect(isNativeProtocol("iterm2")).toBe(true);
    expect(isNativeProtocol("sixel")).toBe(true);
    expect(isNativeProtocol("halfblock")).toBe(false);
    expect(isNativeProtocol("placeholder")).toBe(false);
  });
});
