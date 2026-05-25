import type { StepRule } from "./types.js";
import { nonEmptyArtifact, unsatisfied } from "./common.js";

const CRITERIA = {
  assigned: "assigned task completed or blocked with reason",
  changed: "changed files summarized when applicable",
  validation: "validation run or skipped with reason",
  failures: "failures captured",
} as const;

const COMPLETION_RE = /\b(done|completed|implemented|succeeded|success|blocked)\b/i;
const CHANGES_RE = /\b(changed files?|diff|commit|modified|updated|no changes)\b/i;
const VALIDATION_RE = /\b(test|typecheck|lint|build|validation|skipped|not run)\b/i;
const FAILURE_RE = /\b(failures?|failed|error|blocked|no failures?|none)\b/i;

export const executionRule: StepRule = {
  stepTemplateId: "execution",
  evaluateArtifactSatisfies(artifact, ctx) {
    if (nonEmptyArtifact(artifact, "implementation_result")) {
      return unsatisfied(ctx, [CRITERIA.assigned, CRITERIA.changed, CRITERIA.failures]);
    }
    if (nonEmptyArtifact(artifact, "test_report")) {
      return unsatisfied(ctx, [CRITERIA.validation, CRITERIA.failures]);
    }
    return [];
  },
  evaluateSessionSummarySatisfies(summary, ctx) {
    if (summary.sessionStatus !== "exited") return [];
    const text = `${summary.headline}\n${summary.summaryText}`;
    const satisfied: string[] = [];
    if (COMPLETION_RE.test(text)) satisfied.push(CRITERIA.assigned);
    if (CHANGES_RE.test(text)) satisfied.push(CRITERIA.changed);
    if (VALIDATION_RE.test(text)) satisfied.push(CRITERIA.validation);
    if (FAILURE_RE.test(text)) satisfied.push(CRITERIA.failures);
    return unsatisfied(ctx, satisfied);
  },
};
