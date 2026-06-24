import { describe, expect, it } from "vitest";
import { decideGate } from "./gate-decision.js";
import type { Classification } from "./classify.js";

const c = (over: Partial<Classification>): Classification => ({
  riskClass: "low", permissionTier: "read_only", reasons: [], hardConstraintViolations: [], ...over,
});

describe("decideGate", () => {
  it("denies absolutely on a hard-constraint violation, in any mode", () => {
    const cls = c({ riskClass: "critical", permissionTier: "full_access", hardConstraintViolations: ["x"] });
    expect(decideGate("human_review", cls)).toBe("deny");
    expect(decideGate("automated", cls)).toBe("deny");
  });
  it("always require_approval for critical (the floor), even automated", () => {
    const cls = c({ riskClass: "critical", permissionTier: "full_access" });
    expect(decideGate("automated", cls)).toBe("require_approval");
    expect(decideGate("human_review", cls)).toBe("require_approval");
  });
  it("human_review asks for anything above read_only", () => {
    expect(decideGate("human_review", c({ permissionTier: "sandbox_edit", riskClass: "medium" }))).toBe("require_approval");
    expect(decideGate("human_review", c({ permissionTier: "read_only" }))).toBe("allow");
  });
  it("automated allows non-critical actions", () => {
    expect(decideGate("automated", c({ permissionTier: "full_access", riskClass: "high" }))).toBe("allow");
    expect(decideGate("automated", c({ permissionTier: "sandbox_edit", riskClass: "medium" }))).toBe("allow");
  });
  it("deny beats allow: a hard-constraint violation denies even with a NON-critical risk (automated)", () => {
    // Isolates that the deny branch precedes everything: low risk + read_only would
    // otherwise allow in automated mode, but the hard-constraint violation still denies.
    expect(
      decideGate("automated", c({ riskClass: "low", permissionTier: "read_only", hardConstraintViolations: ["x"] }))
    ).toBe("deny");
  });
});
