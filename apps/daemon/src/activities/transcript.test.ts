import { describe, it, expect } from "vitest";
import { extractReasoningSince } from "./transcript.js";

/**
 * Fixture matches the real Claude Code JSONL transcript shape:
 * - Each line is a separate entry
 * - Assistant entries have top-level type:"assistant" and message.content array
 * - text blocks carry the reasoning; thinking blocks are extended thinking (not captured)
 * - tool_use blocks appear in their own entries
 * - user entries are present and should be ignored
 */
const FIXTURE = [
  // User entry — should be ignored
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Do the thing." }] },
    uuid: "u1",
  }),
  // First assistant reasoning text
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I need to examine the file first." }],
    },
    uuid: "a1",
  }),
  // Assistant thinking block — should be ignored (not "text")
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Internal chain of thought." }],
    },
    uuid: "a2",
  }),
  // Assistant tool_use block — should be ignored (not "text")
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/foo.ts" } }],
    },
    uuid: "a3",
  }),
  // Second assistant reasoning text
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Now I can see the issue clearly." }],
    },
    uuid: "a4",
  }),
].join("\n");

describe("extractReasoningSince", () => {
  it("returns assistant text blocks after the cursor, in order", () => {
    const out = extractReasoningSince(FIXTURE, 0);
    expect(out.notes.length).toBe(2);
    expect(out.notes[0]).toContain("examine the file");
    expect(out.notes[1]).toContain("issue clearly");
    expect(out.cursor).toBe(2);
  });

  it("returns nothing when cursor is at the end", () => {
    const { cursor } = extractReasoningSince(FIXTURE, 0);
    expect(extractReasoningSince(FIXTURE, cursor).notes).toEqual([]);
  });

  it("returns only new blocks when cursor is mid-stream", () => {
    const out = extractReasoningSince(FIXTURE, 1);
    expect(out.notes.length).toBe(1);
    expect(out.notes[0]).toContain("issue clearly");
    expect(out.cursor).toBe(2);
  });

  it("ignores malformed lines without throwing", () => {
    expect(() => extractReasoningSince("not json\n" + FIXTURE, 0)).not.toThrow();
  });

  it("ignores empty lines without throwing", () => {
    expect(() => extractReasoningSince("\n\n" + FIXTURE + "\n\n", 0)).not.toThrow();
  });

  it("drops very short text fragments (< 8 chars)", () => {
    const shortFixture = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
      uuid: "s1",
    });
    const out = extractReasoningSince(shortFixture, 0);
    expect(out.notes).toEqual([]);
    expect(out.cursor).toBe(0);
  });

  it("ignores thinking blocks", () => {
    const thinkingOnly = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Some deep internal reasoning chain." }],
      },
      uuid: "t1",
    });
    const out = extractReasoningSince(thinkingOnly, 0);
    expect(out.notes).toEqual([]);
  });

  it("handles empty input without throwing", () => {
    expect(() => extractReasoningSince("", 0)).not.toThrow();
    expect(extractReasoningSince("", 0)).toEqual({ notes: [], cursor: 0 });
  });
});
