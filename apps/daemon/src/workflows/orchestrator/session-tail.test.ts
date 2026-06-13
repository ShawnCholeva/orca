import { describe, expect, it } from "vitest";
import { decodeSessionTail, decodeSessionTailFromSeq } from "./session-tail.js";
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

describe("decodeSessionTailFromSeq", () => {
  it("excludes chunks before firstSeq and decodes from seq onward", () => {
    const snap: SessionOutputSnapshot = {
      sessionId: "s",
      firstByteOffset: 0,
      nextSeq: 3,
      totalBytesKept: 9,
      chunks: [chunk("abc", 0, 0), chunk("def", 1, 3), chunk("ghi", 2, 6)],
    };
    expect(decodeSessionTailFromSeq(snap, 1)).toBe("defghi");
    expect(decodeSessionTailFromSeq(snap, 2)).toBe("ghi");
    expect(decodeSessionTailFromSeq(snap, 3)).toBe("");
  });

  it("truncates from the head when the post-seq tail exceeds maxBytes", () => {
    const snap: SessionOutputSnapshot = {
      sessionId: "s",
      firstByteOffset: 0,
      nextSeq: 3,
      totalBytesKept: 9,
      chunks: [chunk("abc", 0, 0), chunk("def", 1, 3), chunk("ghi", 2, 6)],
    };
    expect(decodeSessionTailFromSeq(snap, 1, 4)).toBe("fghi");
  });
});
