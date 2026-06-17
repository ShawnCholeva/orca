import { describe, expect, it } from "vitest";
import { reconstructEditDiff } from "./diff.js";

const FILE = [
  "export class Verifier {",          // line 1
  "  verify(evt) {",                  // line 2
  "    if (flags.billingV3Shadow)",   // line 3
  "      return this.dualVerify(evt);",// line 4
  "    return this.v1(evt);",         // line 5
  "  }",                              // line 6
  "}",                               // line 7
].join("\n");

describe("reconstructEditDiff", () => {
  it("builds an Edit diff with line numbers and context", () => {
    const diff = reconstructEditDiff(
      "Edit",
      {
        file_path: "/repo/billing/verifier.ts",
        old_string: "  verify(evt) { return this.v1(evt); }",
        new_string: "  verify(evt) {\n    if (flags.billingV3Shadow)\n      return this.dualVerify(evt);\n    return this.v1(evt);\n  }",
      },
      () => FILE,
    )!;
    expect(diff.filePath).toBe("verifier.ts");
    expect(diff.additions).toBe(5);
    expect(diff.deletions).toBe(1);
    expect(diff.hunks[0].newStart).toBe(2);
    expect(diff.hunks[0].lines.filter((l) => l.kind === "add")).toHaveLength(5);
    expect(diff.hunks[0].lines.some((l) => l.kind === "context")).toBe(true);
  });

  it("treats Write as an all-addition diff", () => {
    const diff = reconstructEditDiff("Write", { file_path: "/r/new.ts", content: "a\nb\n" }, () => "")!;
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.hunks[0].lines.every((l) => l.kind === "add")).toBe(true);
  });

  it("returns null line numbers when the snippet can't be located", () => {
    const diff = reconstructEditDiff(
      "Edit",
      { file_path: "/r/x.ts", old_string: "gone", new_string: "absent" },
      () => "totally different file",
    )!;
    expect(diff.hunks[0].newStart).toBeNull();
    expect(diff.deletions).toBe(1);
  });

  it("returns null for non-edit tools and on read failure", () => {
    expect(reconstructEditDiff("Read", { file_path: "/r/x.ts" }, () => "")).toBeNull();
    expect(reconstructEditDiff("Edit", { file_path: "/r/x.ts", old_string: "a", new_string: "b" },
      () => { throw new Error("ENOENT"); })!.hunks[0].newStart).toBeNull();
  });

  it("caps hunk body at MAX_HUNK_LINES with a visible marker, but keeps true add/del counts", () => {
    // Build a new_string with 250 lines so the hunk exceeds the 200-line cap.
    const newStr = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n");
    const diff = reconstructEditDiff(
      "Edit",
      { file_path: "/r/big.ts", old_string: "", new_string: newStr },
      () => { throw new Error("ENOENT"); }, // no file read — line numbers null, no context lines
    )!;

    expect(diff.additions).toBe(250);
    expect(diff.deletions).toBe(0);

    const hunk = diff.hunks[0];
    expect(hunk.lines.length).toBeLessThanOrEqual(200);

    const lastLine = hunk.lines[hunk.lines.length - 1];
    expect(lastLine.kind).toBe("context");
    expect(lastLine.text).toMatch(/more changed line\(s\) hidden/);
  });
});
