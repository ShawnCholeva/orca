import { describe, expect, it } from "vitest";
import { incrementReviseAttempt, REVISE_CAP } from "./revise-loop.js";

describe("revise loop counter", () => {
  it("REVISE_CAP is 3", () => { expect(REVISE_CAP).toBe(3); });

  it("first attempt: nextAttempt = 1, capReached = false", () => {
    const r = incrementReviseAttempt(0);
    expect(r.nextAttempt).toBe(1);
    expect(r.capReached).toBe(false);
  });

  it("third attempt reaches cap", () => {
    expect(incrementReviseAttempt(2).capReached).toBe(true);
  });
});
