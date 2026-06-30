import { describe, expect, it } from "vitest";
import { extractFileClaims, verifyCorrectionClaims } from "./claim-verification.js";

describe("extractFileClaims", () => {
  it("collects path-like string leaves from nested arrays and objects", () => {
    const output = {
      summary: "Did the thing",
      changed_files: ["src/a.ts", "apps/daemon/src/b.ts"],
      nested: { artifacts: [{ reference: ".orca/specs/plan.md" }] },
    };
    expect(extractFileClaims(output)).toEqual([
      ".orca/specs/plan.md",
      "apps/daemon/src/b.ts",
      "src/a.ts",
    ]);
  });

  it("ignores non-path strings (prose, enums, single words)", () => {
    const output = {
      verdict: "passed",
      result: "read_only",
      note: "This changed the behavior of the parser significantly.",
      mode: "shadow_session",
    };
    expect(extractFileClaims(output)).toEqual([]);
  });

  it("includes absolute paths and dedupes", () => {
    const output = {
      a: "/Users/x/repo/src/a.ts",
      b: "/Users/x/repo/src/a.ts",
    };
    expect(extractFileClaims(output)).toEqual(["/Users/x/repo/src/a.ts"]);
  });
});

describe("verifyCorrectionClaims", () => {
  const onDisk = (paths: string[]) => (path: string, roots: string[]) =>
    roots.some((r) => paths.includes(`${r}/${path}`)) || paths.includes(path);

  it("flags a new claim the correction introduced that does not resolve", () => {
    const result = verifyCorrectionClaims({
      priorOutput: { changed_files: ["src/a.ts"] },
      correctedOutput: { changed_files: ["src/a.ts", "src/invented.ts"] },
      roots: ["/repo"],
      resolve: onDisk(["/repo/src/a.ts"]), // src/invented.ts is NOT on disk
    });
    expect(result.fabricatedClaims).toEqual(["src/invented.ts"]);
  });

  it("does not flag a new claim that resolves on disk", () => {
    const result = verifyCorrectionClaims({
      priorOutput: { changed_files: ["src/a.ts"] },
      correctedOutput: { changed_files: ["src/a.ts", "src/real.ts"] },
      roots: ["/repo"],
      resolve: onDisk(["/repo/src/a.ts", "/repo/src/real.ts"]),
    });
    expect(result.fabricatedClaims).toEqual([]);
  });

  it("does not flag a missing claim that was already present before the correction", () => {
    // src/preexisting.ts is missing on disk but was already in the prior output —
    // the correction did not introduce it, so it is not the correction's fabrication.
    const result = verifyCorrectionClaims({
      priorOutput: { changed_files: ["src/preexisting.ts"] },
      correctedOutput: { changed_files: ["src/preexisting.ts"] },
      roots: ["/repo"],
      resolve: onDisk([]), // nothing resolves
    });
    expect(result.fabricatedClaims).toEqual([]);
  });

  it("returns no fabrications when the correction adds no file claims", () => {
    const result = verifyCorrectionClaims({
      priorOutput: { summary: "before" },
      correctedOutput: { summary: "after, still no paths" },
      roots: ["/repo"],
      resolve: onDisk([]),
    });
    expect(result.fabricatedClaims).toEqual([]);
  });
});
