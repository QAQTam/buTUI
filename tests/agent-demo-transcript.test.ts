import { describe, expect, test } from "bun:test";
import { createTranscript } from "../examples/agent-demo/src/transcript.ts";

describe("agent-demo transcript adapter", () => {
  test("把 text/tool events 投影成 stable + volatile ledger 窗口", async () => {
    const transcript = createTranscript({
      memoryBytes: 64 * 1024,
      retainedBytes: 32 * 1024,
    });

    transcript.ingest({ type: "text.delta", turnId: "t1", delta: "alpha\nbeta" });
    transcript.ingest({
      type: "tool.start",
      call: {
        id: "c1",
        turnId: "t1",
        name: "read_file",
        args: {},
        status: "running",
        reversible: true,
      },
    });
    transcript.ingest({ type: "text.delta", turnId: "t1", delta: "gamma" });
    await transcript.flush();

    const projection = transcript.ledger.project(transcript.streamId);
    expect(projection.revision).toBeGreaterThan(0);
    expect(projection.stableLines.map(line => line.text)).toEqual([
      "alpha",
      "beta",
      "[tool] read_file",
    ]);
    expect(projection.volatileTail.map(line => line.text)).toEqual(["gamma"]);

    transcript.dispose();
    await transcript.flush();
  });
});
