import { describe, expect, test } from "bun:test";
import {
  type AgentEvent,
  type UiCommand,
  createNdjsonDecoder,
  decodeNdjson,
  encodeNdjson,
} from "@butui/agent";

describe("事件协议 NDJSON 编解码（SPEC §13 / §18-9）", () => {
  test("encode → decode 往返", () => {
    const events: AgentEvent[] = [
      { type: "turn.start", turnId: "t1" },
      { type: "text.delta", turnId: "t1", delta: "你好 **世界**" },
      { type: "tool.start", call: { id: "c1", turnId: "t1", name: "read_file", args: {}, status: "running", reversible: true } },
      { type: "permission.request", request: { id: "p1", tool: "bash", detail: "rm -rf x", irreversible: true } },
      { type: "turn.end", turnId: "t1", reason: "completed" },
    ];
    const text = events.map(encodeNdjson).join("");
    expect(decodeNdjson(text)).toEqual(events);
  });

  test("命令也是同一套编码", () => {
    const commands: UiCommand[] = [
      { type: "user.submit", text: "hi" },
      { type: "permission.respond", id: "p1", allow: true },
      { type: "undo.apply", target: "m3", mode: "branch" },
    ];
    const text = commands.map(encodeNdjson).join("");
    expect(decodeNdjson<UiCommand>(text)).toEqual(commands);
  });

  test("分片到达时保留不完整的最后一行", () => {
    const decoder = createNdjsonDecoder<AgentEvent>();
    expect(decoder('{"type":"turn.st')).toEqual([]);
    expect(decoder('art","turnId":"t1"}\n{"type":"turn.end"')).toHaveLength(1);
    const rest = decoder(',"turnId":"t1","reason":"completed"}\n');
    expect(rest).toEqual([{ type: "turn.end", turnId: "t1", reason: "completed" }]);
  });

  test("一次给多行", () => {
    const decoder = createNdjsonDecoder<AgentEvent>();
    const events = decoder(
      '{"type":"turn.start","turnId":"a"}\n{"type":"turn.start","turnId":"b"}\n'
    );
    expect(events).toHaveLength(2);
  });

  test("坏行不阻塞整条流", () => {
    const decoder = createNdjsonDecoder<AgentEvent>();
    const events = decoder('not json\n{"type":"turn.start","turnId":"ok"}\n');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("error");
    expect(events[1]).toEqual({ type: "turn.start", turnId: "ok" });
  });

  test("空行被忽略", () => {
    expect(decodeNdjson('\n\n{"type":"turn.start","turnId":"a"}\n\n')).toHaveLength(1);
  });
});
