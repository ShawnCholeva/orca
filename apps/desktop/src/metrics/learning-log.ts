// Pure event→line mapper for the learning log (SP3 §3.4). No jargon: every
// string here must read in plain language — the no-jargon test guards it.
import type { LearningEvent, TemplateInstructionProposal } from "@orca/contracts";
import { labelForFailure } from "@orca/contracts";

// Reused by both the judged event line and the proposal judgment block
// (SelfImprovement.tsx) so the two surfaces never drift apart.
export const VERDICT_META: Record<string, { label: string; icon: string }> = {
  pass: { label: "pass", icon: "✓" },
  regression_risk: { label: "regression risk", icon: "⚠" },
  uncertain: { label: "uncertain", icon: "?" },
  insufficient_evidence: { label: "insufficient evidence", icon: "—" },
  unavailable: { label: "unavailable", icon: "—" },
};

// R2 always carries a failureCode (see contracts), so its branch is unreached in practice.
function ruleText(rule: "R1" | "R2" | "R3" | "R4"): string {
  if (rule === "R1") return "underperforming scores";
  if (rule === "R3") return "repeated user re-steers";
  if (rule === "R4") return "weak verification";
  return "an underlying issue";
}

function targetText(failureCode: string | null, rule: "R1" | "R2" | "R3" | "R4"): string {
  return failureCode ? labelForFailure(failureCode) : ruleText(rule);
}

export function eventLine(e: LearningEvent, stepName: (id: string | null) => string): string {
  const step = stepName(e.stepTemplateId);
  const payload = e.payload;
  switch (payload.kind) {
    case "created": {
      const what = payload.component === "step_output_schema" ? "a tighter output check" : "an instruction edit";
      return `Proposed ${what} for ${step} — targets ${targetText(payload.failureCode, payload.rule)}.`;
    }
    case "judged": {
      const label = VERDICT_META[payload.verdict]?.label ?? payload.verdict;
      return `Independent evaluation: ${label} (${payload.solvedSampleSize} solved · ${payload.failureSampleSize} failure cases).`;
    }
    case "applied":
      return `Applied as v${payload.appliedAsVersion}${payload.humanEdited ? " (edited before applying)" : ""}.`;
    case "dismissed":
      return "Dismissed.";
    case "superseded": {
      const reason = payload.by === "apply" ? "another change was applied"
        : payload.by === "staleness" ? "the template moved on"
        : "defaults restored";
      return `Superseded (${reason}).`;
    }
    case "rolled_back": {
      const { targetDelta, targetDeltaVersions, invalidOutputRateDelta, regressionDetected } = payload.outcome;
      if (regressionDetected && invalidOutputRateDelta != null && invalidOutputRateDelta > 0.2) {
        return `Rolled back — new checks were rejecting output (+${Math.round(invalidOutputRateDelta * 100)}%).`;
      }
      if (regressionDetected && targetDelta != null && targetDelta <= 0) {
        const pts = Math.round(targetDelta * 100);
        const versionText = targetDeltaVersions ? `, v${targetDeltaVersions.prior}→v${targetDeltaVersions.latest}` : "";
        return `Rolled back — the target step didn't improve (${pts} points${versionText}).`;
      }
      if (regressionDetected) return "Rolled back — a watched measure regressed.";
      return "Rolled back.";
    }
    case "baseline_restored":
      return payload.supersededCount > 0
        ? `Restored the default template, superseding ${payload.supersededCount} pending change${payload.supersededCount === 1 ? "" : "s"}.`
        : "Restored the default template.";
    case "analyzed": {
      const stepsS = payload.stepsDiagnosed === 1 ? "" : "s";
      const pending = payload.proposalsAlreadyPending ?? 0;
      const parts: string[] = [];
      if (payload.proposalsCreated > 0) parts.push(`created ${payload.proposalsCreated} proposal${payload.proposalsCreated === 1 ? "" : "s"}`);
      if (pending > 0) parts.push(`${pending} change${pending === 1 ? "" : "s"} already awaiting review`);
      const outcome = parts.length > 0 ? parts.join(", ") : "nothing to propose";
      const skipText = payload.skips.length
        ? `; skipped ${payload.skips.map((k) => `${stepName(k.stepTemplateId)}: ${k.reason}`).join("; ")}`
        : "";
      return `Reviewed ${payload.stepsDiagnosed} step${stepsS} — ${outcome}${skipText}.`;
    }
  }
}

// Pre-SP3 proposals have no events at all — one synthesized line per orphan proposal,
// derived from the row itself, visually marked so it's never confused with a real event.
export function synthesizedLine(p: TemplateInstructionProposal, stepName: (id: string | null) => string): string {
  const step = stepName(p.stepTemplateId);
  const what = p.component === "step_output_schema" ? "a tighter output check" : "an instruction edit";
  const target = targetText(p.targetedFailureMode.failureCode, p.targetedFailureMode.rule);
  const status = p.status.replace(/_/g, " "); // "rolled_back" is an internal enum, not copy
  return `Proposed ${what} for ${step} — targets ${target} (${status}) — (before the learning log existed).`;
}
