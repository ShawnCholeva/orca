import { describe, expect, it } from "vitest";
import { formatRevisionForWorker, incrementReviseAttempt, REVISE_CAP } from "./revise-loop.js";

describe("formatRevisionForWorker", () => {
  // Live incident (2026-07-29): the user's revision text was delivered to the
  // Research worker verbatim, as a bare user turn. Read as a standalone
  // instruction it licensed work the step forbids.
  const args = { stepName: "Research", feedback: "I want to resolve the blocking constraint before we move on" };

  it("carries the user's words verbatim", () => {
    expect(formatRevisionForWorker({ ...args, readOnly: false })).toContain(args.feedback);
  });

  it("names the step so the worker knows it has not advanced", () => {
    expect(formatRevisionForWorker({ ...args, readOnly: false })).toContain("Research");
  });

  it("restates the read-only contract when the step forbids writes", () => {
    expect(formatRevisionForWorker({ ...args, readOnly: true })).toMatch(/make no code changes/i);
  });

  it("omits the read-only clause when the step permits writes", () => {
    expect(formatRevisionForWorker({ ...args, readOnly: false })).not.toMatch(/make no code changes/i);
  });
});

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
