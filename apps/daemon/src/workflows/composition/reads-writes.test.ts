import { describe, expect, it } from "vitest";
import { resolveReads, mapWrites } from "./reads-writes.js";

describe("reads/writes", () => {
  it("resolveReads maps parent output keys into child entry keys", () => {
    expect(resolveReads({ diff_ref: "change_ref" }, { change_ref: "abc", other: 1 }))
      .toEqual({ diff_ref: "abc" });
  });
  it("resolveReads yields undefined for a missing parent key", () => {
    expect(resolveReads({ diff_ref: "change_ref" }, {})).toEqual({ diff_ref: undefined });
  });
  it("mapWrites maps child terminal output keys into parent keys", () => {
    expect(mapWrites({ review_findings: "findings" }, { findings: ["x"], noise: 2 }))
      .toEqual({ review_findings: ["x"] });
  });
});
