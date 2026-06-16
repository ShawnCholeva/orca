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
});
