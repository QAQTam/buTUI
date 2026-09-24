import { describe, expect, test } from "bun:test";
import { CONTROL } from "@butui/terminal";

describe("TerminalSession recovery", () => {
  test.skipIf(process.platform === "win32")(
    "SIGTERM 退出时恢复 alt-screen / mouse / cursor",
    async () => {
      const decoder = new TextDecoder();
      let output = "";
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data(_terminal, chunk) {
          output += decoder.decode(chunk, { stream: true });
        },
      });

      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "--conditions=browser",
          "-e",
          `
            import { TerminalSession } from "@butui/terminal";
            const session = new TerminalSession();
            session.start();
            console.log("READY");
            setInterval(() => {}, 1000);
          `,
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
        terminal,
      });

      const deadline = Date.now() + 2_000;
      while (!output.includes("READY") && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(output).toContain("READY");

      child.kill("SIGTERM");
      const exitCode = await child.exited;
      terminal.close();

      expect(exitCode === 143 || exitCode === 0 || exitCode === 1).toBe(true);
      expect(output).toContain(CONTROL.altScreenOff);
      expect(output).toContain(CONTROL.mouseOff);
      expect(output).toContain(CONTROL.cursorShow);
    }
  );
});
