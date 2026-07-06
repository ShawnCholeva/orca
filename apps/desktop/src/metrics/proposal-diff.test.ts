import { describe, expect, it } from "vitest";
import { diffLines, schemaChips } from "./proposal-diff";

describe("diffLines", () => {
  it("marks removed/added/kept lines by set membership", () => {
    expect(diffLines("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "kept", text: "a" }, { kind: "removed", text: "b" }, { kind: "kept", text: "c" }, { kind: "added", text: "d" },
    ]);
  });
});

describe("schemaChips", () => {
  const before = JSON.stringify([{ key: "summary", type: "string", required: true }, { key: "notes", type: "string", required: false }]);
  const after = JSON.stringify([
    { key: "summary", type: "string", required: true }, { key: "notes", type: "string", required: true },
    { key: "evidence_refs", type: "array", itemType: "string", required: true },
  ]);
  it("computes added and strictened chips", () => {
    expect(schemaChips(before, after)).toEqual([
      { kind: "strictened", label: "notes: now required" },
      { kind: "added", label: "+ evidence_refs (list of strings, required)" },
    ]);
  });
  it("returns [] on unparseable input", () => {
    expect(schemaChips("junk", after)).toEqual([]);
  });
});
