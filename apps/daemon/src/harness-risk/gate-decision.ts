import type { OperatingMode, GateDecision } from "@orca/contracts";
import type { Classification } from "./classify.js";

// The safety floor (critical / hard-constraint) is mode-independent and cannot be disabled.
export function decideGate(mode: OperatingMode, c: Classification): GateDecision {
  if (c.hardConstraintViolations.length > 0) return "deny";
  if (c.riskClass === "critical") return "require_approval"; // floor: always gate
  if (mode === "automated") return "allow";
  // human_review: gate anything consequential (above read_only)
  return c.permissionTier === "read_only" ? "allow" : "require_approval";
}
