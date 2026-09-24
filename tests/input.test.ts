import { describe, expect, test } from "bun:test";
import { CONTROL, InputDecoder } from "@butui/terminal";

const feed = (decoder: InputDecoder, text: string) => decoder.push(new TextEncoder().encode(text));

describe("终端输入解码（SPEC §9.3 / §9.4）", () => {
  test("普通文本", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "hi");
    expect(events.map(e => (e.type === "key" ? e.name : e.type))).toEqual(["h", "i"]);
  });

  test("CJK / emoji 不被拆成半个字符", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "中文🎯");
    expect(events.map(e => (e.type === "key" ? e.text : e.type))).toEqual(["中", "文", "🎯"]);
  });

  test("方向键 / Home / End / PageUp", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\x1b[A\x1b[B\x1b[H\x1b[F\x1b[5~");
    expect(events.map(e => (e.type === "key" ? e.name : e.type))).toEqual([
      "up",
      "down",
      "home",
      "end",
      "pageup",
    ]);
  });

  test("修饰键：ctrl+up / shift+tab", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\x1b[1;5A\x1b[Z");
    const [ctrlUp, shiftTab] = events;
    expect(ctrlUp.type === "key" && ctrlUp.name).toBe("up");
    expect(ctrlUp.type === "key" && ctrlUp.modifiers.ctrl).toBe(true);
    expect(shiftTab.type === "key" && shiftTab.name).toBe("tab");
    expect(shiftTab.type === "key" && shiftTab.modifiers.shift).toBe(true);
  });

  test("控制字符：enter / tab / backspace / ctrl+c", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\r\t\x7f\x03");
    expect(events.map(e => (e.type === "key" ? e.name : e.type))).toEqual([
      "enter",
      "tab",
      "backspace",
      "c",
    ]);
    const ctrlC = events[3];
    expect(ctrlC.type === "key" && ctrlC.modifiers.ctrl).toBe(true);
  });

  test("其余 ctrl+letter 不被吞掉", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\x01\x0f\x1a");
    expect(events.map(e => (e.type === "key" ? e.name : e.type))).toEqual([
      "a",
      "o",
      "z",
    ]);
    expect(
      events.every(event => event.type === "key" && event.modifiers.ctrl)
    ).toBe(true);
  });

  test("alt+字符", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\x1bx");
    const event = events[0];
    expect(event.type === "key" && event.name).toBe("x");
    expect(event.type === "key" && event.modifiers.alt).toBe(true);
  });

  test("hover 模式额外开启 1003 移动上报", () => {
    expect(CONTROL.mouseOn).not.toContain("?1003h");
    expect(CONTROL.mouseHoverOn).toContain("?1003h");
    expect(CONTROL.mouseOff).toContain("?1003l");
  });

  test("SGR 鼠标点击（1-based 坐标转 0-based）", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\x1b[<0;10;5M\x1b[<0;10;5m");
    expect(events).toHaveLength(2);
    const [press, release] = events;
    expect(press.type === "mouse" && press.action).toBe("press");
    expect(press.type === "mouse" && press.button).toBe("left");
    expect(press.type === "mouse" && press.x).toBe(9);
    expect(press.type === "mouse" && press.y).toBe(4);
    expect(release.type === "mouse" && release.action).toBe("release");
  });

  test("SGR 按住左键移动：motion 位不能被当成第二次按下", () => {
    const decoder = new InputDecoder();
    const events = feed(
      decoder,
      "\x1b[<0;2;2M\x1b[<32;5;2M\x1b[<0;5;2m"
    );
    expect(events.map(e => (e.type === "mouse" ? e.action : undefined))).toEqual([
      "press",
      "move",
      "release",
    ]);
    const move = events[1];
    expect(move.type === "mouse" && move.button).toBe("left");
    expect(move.type === "mouse" && move.x).toBe(4);
  });

  test("鼠标滚轮", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\x1b[<64;1;1M\x1b[<65;1;1M");
    expect(events.every(e => e.type === "mouse" && e.action === "wheel")).toBe(true);
    // 方向必须保留：64=上 65=下（以前两个分支都写死 "none"，滚不动）
    expect(events.map(e => (e.type === "mouse" ? e.wheel : undefined))).toEqual(["up", "down"]);
  });

  test("水平滚轮 / 带修饰键的滚轮", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\x1b[<66;1;1M\x1b[<67;1;1M\x1b[<69;1;1M\x1b[<80;1;1M");
    expect(events.map(e => (e.type === "mouse" ? e.wheel : undefined))).toEqual([
      "left",
      "right",
      "down",
      "up",
    ]);
    // 69 = 64 + 4(shift) + 1(down)
    const shifted = events[2];
    expect(shifted.type === "mouse" && shifted.modifiers.shift).toBe(true);
    expect(shifted.type === "mouse" && shifted.modifiers.ctrl).toBe(false);
    // 80 = 64 + 16(ctrl)
    const ctrled = events[3];
    expect(ctrled.type === "mouse" && ctrled.modifiers.ctrl).toBe(true);
    expect(ctrled.type === "mouse" && ctrled.modifiers.shift).toBe(false);
  });

  test("bracketed paste 整体作为一个事件", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\x1b[200~multi\nline\ntext\x1b[201~");
    expect(events).toHaveLength(1);
    expect(events[0].type === "paste" && events[0].text).toBe("multi\nline\ntext");
  });

  test("被截断的转义序列会等到下一帧", () => {
    const decoder = new InputDecoder();
    expect(feed(decoder, "\x1b[")).toHaveLength(0);
    expect(decoder.pending).toBe(true);
    const events = feed(decoder, "A");
    expect(events.map(e => (e.type === "key" ? e.name : e.type))).toEqual(["up"]);
    expect(decoder.pending).toBe(false);
  });

  test("单独的 ESC 通过 flush 变成 escape 键", () => {
    const decoder = new InputDecoder();
    expect(feed(decoder, "\x1b")).toHaveLength(0);
    const events = decoder.flush();
    expect(events.map(e => (e.type === "key" ? e.name : e.type))).toEqual(["escape"]);
  });

  test("Kitty keyboard protocol", () => {
    const decoder = new InputDecoder();
    const events = feed(decoder, "\x1b[27u");
    expect(events.map(e => (e.type === "key" ? e.name : e.type))).toEqual(["escape"]);
  });
});
