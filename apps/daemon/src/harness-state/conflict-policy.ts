import type Database from "better-sqlite3";
import type { ConflictPolicy, OperatingMode } from "@orca/contracts";

/**
 * Per-goal conflict policy is derived from the governance axis (operating_mode),
 * not configured independently: an `automated` (L5) goal warns-and-proceeds on a
 * state conflict (`auto`), a `human_review` (L4) goal escalates it to the human
 * (`escalate`). This mirrors decideGate's mode→gate mapping and keeps autonomy
 * the binary L4/L5 it is everywhere else (finer-grained knobs are a non-goal).
 */
export function conflictPolicyForMode(mode: OperatingMode): ConflictPolicy {
  return mode === "automated" ? "auto" : "escalate";
}

/**
 * The conflict policy for a goal, read from its operating_mode. An absent goal
 * defaults to `escalate` — the safe floor (escalate to the human when in doubt).
 */
export function conflictPolicyForGoal(db: Database.Database, goalId: string): ConflictPolicy {
  const row = db.prepare("SELECT operating_mode FROM goals WHERE id = ?").get(goalId) as
    | { operating_mode: string }
    | undefined;
  return conflictPolicyForMode((row?.operating_mode as OperatingMode) ?? "human_review");
}
