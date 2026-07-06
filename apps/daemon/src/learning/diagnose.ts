import type { ProposalComponent, StepMetrics, TargetedFailureMode, TemplateMetricsDetail } from "@orca/contracts";
import type { TemplateRevisionSignal } from "./fetch.js";
import { parseSchema } from "./schema-mutation.js";

export const SAMPLE_MIN = 5;
const K = 3; // R2 min cluster count
const M = 3; // R3 min feedback-signal count
const TOP_N = 3;

export const INSTRUCTION_ADDRESSABLE: ReadonlySet<string> = new Set([
  "invalid_output", "output_unavailable", "source_truncated", "evidence_veto", "guardrail_denied",
]);

// Failure codes whose cause is the environment/provider, not the step's
// instructions — an instruction edit cannot fix these.
export const INFRA_CODES: ReadonlySet<string> = new Set([
  "provider_error", "internal_error", "daemon_restart", "timeout",
  "session_not_terminal", "goal_archived", "session_archived",
]);

export type DiagnosisBundle = {
  stepTemplateId: string;
  currentInstructions: string;
  component: ProposalComponent;
  currentOutputSchemaJson: string;
  targetedFailureMode: TargetedFailureMode;
  evidence: {
    sampleTransitionIds: string[];
    revisionSignalIds: string[];
    revisionFeedbackTexts: string[];
    // The independent reviewer's stated reasons for overturning claims (Task 3).
    refuteReasons: string[];
    // The superseded scorings' own `reason` — the claim the user then corrected.
    supersededReasons: string[];
    metricSnapshot: { score: number | null; verdictPassRate: number; oracleSufficientRate: number | null; versionDelta: number | null };
  };
};

// R1 is cause-agnostic, so gate it: when the step's clustered failures are mostly
// infrastructure, a low score is not an instructions problem — proposing an
// instruction edit would optimize against the wrong signal.
function infraDominated(step: StepMetrics): boolean {
  let infra = 0, other = 0;
  for (const c of step.failureClusters) {
    if (c.failureCode != null && INFRA_CODES.has(c.failureCode)) infra += c.count;
    else other += c.count;
  }
  return infra > other;
}

function chooseRule(step: StepMetrics, feedbackSignals: TemplateRevisionSignal[]): TargetedFailureMode | null {
  // R3 — revision-signal density (highest signal; instruction-related regardless of code).
  if (feedbackSignals.length >= M) {
    return { rule: "R3", failureCode: null, clusterCount: null, signalCount: feedbackSignals.length };
  }
  // R2 — dominant instruction-addressable cluster.
  const cluster = step.failureClusters
    .filter((c) => c.failureCode != null && INSTRUCTION_ADDRESSABLE.has(c.failureCode) && c.count >= K)
    .sort((a, b) => b.count - a.count)[0];
  if (cluster) {
    return { rule: "R2", failureCode: cluster.failureCode, clusterCount: cluster.count, signalCount: null };
  }
  // R4 — false confidence (high pass, low/absent oracle).
  if (step.quality.verdictPassRate >= 0.8 && (step.quality.oracleSufficientRate ?? 0) < 0.5) {
    return { rule: "R4", failureCode: null, clusterCount: null, signalCount: null };
  }
  // R1 — underperforming headline (degraded/watch ~ score < 80). Needs a real score
  // (null = no gradient to act on) and a non-infra failure picture.
  if (step.score != null && step.score < 80 && !infraDominated(step)) {
    return { rule: "R1", failureCode: null, clusterCount: null, signalCount: null };
  }
  return null;
}

export function diagnoseTemplate(input: {
  detail: TemplateMetricsDetail;
  signals: TemplateRevisionSignal[];
  stepMeta: Map<string, { instructions: string; outputSchemaJson: string }>;
}): DiagnosisBundle[] {
  const signalsByStep = new Map<string, TemplateRevisionSignal[]>();
  for (const s of input.signals) {
    if (s.feedbackText == null) continue;
    (signalsByStep.get(s.stepTemplateId) ?? signalsByStep.set(s.stepTemplateId, []).get(s.stepTemplateId)!).push(s);
  }

  const eligible = input.detail.steps.filter((s) => s.confidence === "ok" && s.sampleSize >= SAMPLE_MIN);
  const bundles: DiagnosisBundle[] = [];
  for (const step of eligible) {
    const feedback = signalsByStep.get(step.stepTemplateId) ?? [];
    const mode = chooseRule(step, feedback);
    if (!mode) continue;
    const sampleTransitionIds = step.failureClusters.flatMap((c) => c.sampleTransitionIds).slice(0, 6);
    const meta = input.stepMeta.get(step.stepTemplateId) ?? { instructions: "", outputSchemaJson: "[]" };
    // R4 targets the step's current output schema. If the step is missing from the
    // current template (removed/renamed), the fallback above has no real schema to
    // tighten — outputSchemaJson is "[]", which parseSchema rejects because
    // WorkflowStepOutputSchema requires .min(1). A schema-tightening proposal with
    // no valid current schema is meaningless, so skip this step's bundle entirely
    // (spec §5 skip-with-reason policy) rather than let an unparseable "[]" ride
    // through as beforeInstructions.
    if (mode.rule === "R4" && parseSchema(meta.outputSchemaJson) === null) continue;
    // Deterministic routing (spec §3.2): R4 names a verification deficiency — the
    // lever is the deterministic completion validator, not the prompt. The core
    // owns which lever is pulled; the LLM only fills the content.
    const component: ProposalComponent = mode.rule === "R4" ? "step_output_schema" : "step_instructions";
    bundles.push({
      stepTemplateId: step.stepTemplateId,
      currentInstructions: meta.instructions,
      component,
      currentOutputSchemaJson: meta.outputSchemaJson,
      targetedFailureMode: mode,
      evidence: {
        sampleTransitionIds,
        revisionSignalIds: feedback.map((f) => f.id),
        revisionFeedbackTexts: feedback.map((f) => f.feedbackText!).slice(0, 5),
        refuteReasons: step.verification.recentRefuteReasons.slice(0, 3),
        supersededReasons: feedback.map((f) => f.supersededReason).filter((r): r is string => r != null).slice(0, 5),
        // The step's OWN honest-score delta across versions — not the template-level
        // verificationStrength delta the old code hardcoded regardless of diagnosis.
        metricSnapshot: { score: step.score, verdictPassRate: step.quality.verdictPassRate, oracleSufficientRate: step.quality.oracleSufficientRate, versionDelta: step.versionScoreDelta },
      },
    });
  }
  // Worst-first (null scores last — they carry no gradient), capped.
  return bundles.sort((a, b) => (a.evidence.metricSnapshot.score ?? 101) - (b.evidence.metricSnapshot.score ?? 101)).slice(0, TOP_N);
}
