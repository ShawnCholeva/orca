import { describe, expect, it } from "vitest";
import { deriveStepBlockedCause } from "./blocked-cause.js";

describe("deriveStepBlockedCause", () => {
  it("reports a written code as verified", () => {
    expect(deriveStepBlockedCause({ blockedCode: "worker_stalled", blockedReason: "no progress after 3 restarts" }))
      .toEqual({ code: "worker_stalled", inferred: false });
  });

  it("does not guess a code for a row written before the column existed", () => {
    // Matching the sentence can tell you the FAMILY — something in the substrate
    // failed — but not which member. Returning `worker_exited_no_signal` here
    // would assert more than "crashed 3 times (...)" supports, and this value is
    // the one a headline claim may rest on.
    expect(deriveStepBlockedCause({
      blockedCode: null,
      blockedReason: "crashed 3 times (worker_exited_no_signal)",
    })).toEqual({ code: "unknown", inferred: true });
  });

  it("marks an unrecognised code inferred rather than trusting it", () => {
    // Something wrote a value this build has never heard of. That is not the same
    // as no code, and not a reason to fall through and become more confident.
    expect(deriveStepBlockedCause({ blockedCode: "from_the_future", blockedReason: null }))
      .toEqual({ code: "unknown", inferred: true });
  });

  it("returns null when the step was never blocked", () => {
    expect(deriveStepBlockedCause({ blockedCode: null, blockedReason: null })).toBeNull();
    expect(deriveStepBlockedCause({ blockedCode: null, blockedReason: "" })).toBeNull();
  });
});
