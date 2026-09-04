import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The founder's complaint began with a screen that dimmed numbers it could not
// support: `opacity: 0.55` on a low-confidence tile. Dimming reduces legibility
// while preserving the claim, and reads as "less important" when the message is
// "different kind of thing". The vocabulary that replaced it carries state in FORM.
//
// n-gate-ui.test.tsx already asserts that the primitives emit no opacity, but that
// only reaches their own markup. This reaches the rule: no metrics surface may
// signal uncertainty by fading, whether or not it renders through a primitive.
// A guard on the mechanism, not on one instance of it.

const DIR = join(__dirname);

// Comments legitimately discuss opacity; only real style declarations count.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function opacitySitesIn(src: string): number {
  return (stripComments(src).match(/\bopacity\s*:/g) ?? []).length;
}

function sourceFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test."))
    .sort();
}

// The allowlist this guard shipped with is gone: both pending uses were removed on
// 2026-09-04. StepPerformance.tsx faded a whole step row, duplicating an `n=` marker
// the row already carried — and that marker was itself rendering at --text-4, under
// 2:1 contrast, so the only legible signal was the fade. MetricsPage.tsx was the
// original defect the founder complained about: five estimates at 55% opacity because
// the sample couldn't support them. Neither fade was ever a second claim; the numbers
// were asserted at any alpha. The sample now says itself, in words, once.
//
// Nothing is grandfathered any more, so the assertion below is simply zero.

describe("the detector itself", () => {
  // A guard that cannot fail is decoration. These pin the detection, not the policy.
  it("catches a style declaration", () => {
    expect(opacitySitesIn('<div style={{ opacity: low ? 0.6 : 1 }} />')).toBe(1);
    expect(opacitySitesIn("const a = { opacity:0.5 }; const b = { opacity : 1 };")).toBe(2);
  });

  it("ignores prose that merely mentions the word", () => {
    expect(opacitySitesIn("// never reach for opacity: dim is not a state\n")).toBe(0);
    expect(opacitySitesIn("/* opacity: 0.55 was the original defect */")).toBe(0);
    expect(opacitySitesIn("// Neither component ever uses opacity. Form carries state.")).toBe(0);
  });
});

describe("no metrics surface fades to signal uncertainty", () => {
  it("uses opacity nowhere", () => {
    const offenders: Record<string, number> = {};
    for (const file of sourceFiles()) {
      const count = opacitySitesIn(readFileSync(join(DIR, file), "utf8"));
      if (count > 0) offenders[file] = count;
    }

    expect(
      offenders,
      "A metrics surface is using `opacity` to de-emphasise something.\n" +
        "State belongs in form — a border, a shape, a sentence — never in a fade.\n" +
        "A faint number is still an asserted number: the reader loses legibility\n" +
        "and the claim survives intact. Render the MeasurementState instead."
    ).toEqual({});
  });
});
