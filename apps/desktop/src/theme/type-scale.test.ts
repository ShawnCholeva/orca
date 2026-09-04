import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The ledger surfaces consume the type scale rather than picking sizes. Before
// the scale existed the app carried 21 distinct font sizes — six of them
// half-pixel (8.5 / 9.5 / 10.5 / 11.5 / 12.5 / 13.5) and 88 uses below 11px —
// because there was nothing to snap to and every screen re-chose.
//
// Scoped to the files converted so far, deliberately. The rest of the app
// migrates as files get opened; a repo-wide assertion would either fail on
// untouched code or force a 564-inline-style sweep that isn't this work.
//
// This list only grows, and a file joins it in the same change that converts it —
// never ahead of one. Listing RunLedger.tsx before its 33 literals were converted
// made the suite red for its author over a convention they had no way to look up,
// which is the cost of asserting a rule before the thing it points at exists.
const CONVERTED = ["metrics/RunLedger.tsx", "metrics/interval-bar.tsx", "metrics/n-gate-ui.tsx"];

describe("converted surfaces use the type scale", () => {
  for (const rel of CONVERTED) {
    it(`${rel} sets no literal font size`, () => {
      const src = readFileSync(join(__dirname, "..", rel), "utf8");
      const literals = [...src.matchAll(/fontSize:\s*([\d.]+)/g)].map((m) => m[1]);
      expect(literals).toEqual([]);
    });
  }
});
