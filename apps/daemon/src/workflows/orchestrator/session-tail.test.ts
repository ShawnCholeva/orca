import { describe, expect, it } from "vitest";
import { decodeSessionTail } from "./session-tail.js";
import type { SessionOutputSnapshot } from "@orca/contracts";

function chunk(
  data: string,
  seq: number,
  byteOffset: number
): SessionOutputSnapshot["chunks"][number] {
  return { seq, byteOffset, dataBase64: Buffer.from(data, "utf8").toString("base64") };
}

describe("decodeSessionTail", () => {
  it("concatenates chunks in seq order and truncates from the head", () => {
    const snap: SessionOutputSnapshot = {
      sessionId: "s",
      firstByteOffset: 0,
      nextSeq: 2,
      totalBytesKept: 6,
      chunks: [chunk("abc", 0, 0), chunk("def", 1, 3)],
    };
    expect(decodeSessionTail(snap, 1024)).toBe("abcdef");
    expect(decodeSessionTail(snap, 4)).toBe("cdef");
  });
});
