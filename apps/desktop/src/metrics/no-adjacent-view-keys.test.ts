import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Metrics toggle has three views and two of their LABELS are near-identical:
// "Workflows" (new) beside "Workflow averages" (legacy), with the app's own chrome
// carrying a third `Workflows` tab. That collision is permanent — the founder has
// confirmed the name — so the keys are the only place it can be kept out of.
//
// The obvious tidy-up is to rename a key to match its label. That is what this stops:
// `workflows` and `workflow` both satisfy the union, so a single-character typo
// selects the wrong view and typechecks. The failure mode is a screen quietly showing
// something else, with nothing red anywhere.
//
// A comment cannot enforce this — a comment is exactly what a cleanup pass overrides.

function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length]![b.length]!;
}

describe("view keys cannot be confused with one another", () => {
  const src = readFileSync(join(__dirname, "MetricsPage.tsx"), "utf8");
  const decl = src.match(/type MetricsView =([^;]+);/);

  it("the union is where this test thinks it is", () => {
    // Assert the precondition. Without it a renamed type makes the check below pass
    // over an empty list — green, and reporting on nothing.
    expect(decl, "MetricsView union not found in MetricsPage.tsx").toBeTruthy();
  });

  it("no two keys are within one character of each other", () => {
    const keys = [...decl![1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(1);
    for (const a of keys) {
      for (const b of keys) {
        if (a === b) continue;
        expect(
          editDistance(a, b),
          `View keys "${a}" and "${b}" are one edit apart. Both satisfy the union, so a\n` +
            `typo silently selects the wrong view and typechecks. Key the view by what it\n` +
            `IS, not by the label it displays — the labels are near-identical on purpose.`,
        ).toBeGreaterThan(1);
      }
    }
  });
});
