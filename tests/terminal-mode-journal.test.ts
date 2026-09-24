import { describe, expect, test } from "bun:test";
import { TerminalModeJournal } from "@butui/terminal";

describe("TerminalModeJournal", () => {
  test("suspend 逆序关闭，resume 正序恢复", () => {
    const journal = new TerminalModeJournal();
    journal.activate("alt", "ALT_ON", "ALT_OFF");
    journal.activate("mouse", "MOUSE_ON", "MOUSE_OFF");
    journal.activate("cursor", "CURSOR_HIDE", "CURSOR_SHOW");

    expect(journal.suspend()).toBe("CURSOR_SHOWMOUSE_OFFALT_OFF");
    expect(journal.resume()).toBe("ALT_ONMOUSE_ONCURSOR_HIDE");
    expect(journal.reapply()).toBe("ALT_ONMOUSE_ONCURSOR_HIDE");
  });

  test("restore 逆序关闭并清空 journal", () => {
    const journal = new TerminalModeJournal();
    journal.activate("alt", "ALT_ON", "ALT_OFF");
    journal.activate("mouse", "MOUSE_ON", "MOUSE_OFF");

    expect(journal.restore()).toBe("MOUSE_OFFALT_OFF");
    expect(journal.restore()).toBe("");
    expect(journal.snapshot()).toEqual([]);
  });

  test("suspend 后直接 restore 不重复写关闭序列", () => {
    const journal = new TerminalModeJournal();
    journal.activate("alt", "ALT_ON", "ALT_OFF");
    expect(journal.suspend()).toBe("ALT_OFF");
    expect(journal.restore()).toBe("");
    expect(journal.resume()).toBe("");
  });
});
