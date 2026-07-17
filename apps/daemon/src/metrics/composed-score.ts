import type { TemplateTransition } from "./fetch.js";
import { isCodeFile } from "../harness-sensors/code-files.js";

const C_EXECUTABLE = 1.0, C_GROUNDING = 0.7, C_REVIEW = 0.55, SELF_REPORT = 0.3, COVERAGE_FLOOR = 0.3;

export type CompletionScore = {
  score: number; base: number; coverage: number;
  verifiers: { executable: boolean; grounding: boolean; independentReview: boolean };
};

export function composedScore(t: TemplateTransition): CompletionScore {
  const ev = t.transition.evidence;
  const rf = t.transition.refute;
  const zero = (): CompletionScore => ({ score: 0, base: 0, coverage: 0, verifiers: { executable: false, grounding: false, independentReview: false } });
  if (rf?.verdict === "refuted") return zero();
  if (ev?.verdict === "failed") return zero();

  const executable = ev?.oracleAdequacy.sufficient === true;   // sufficiency-gated
  const grounding = ev?.grounding?.verdict === "passed";
  const independentReview = rf?.verdict === "upheld";
  const cs: number[] = [];
  if (executable) cs.push(C_EXECUTABLE);
  if (grounding) cs.push(C_GROUNDING);
  if (independentReview) cs.push(C_REVIEW);
  const base = cs.length === 0 ? SELF_REPORT : 1 - cs.reduce((p, c) => p * (1 - c), 1);

  const coverage = computeCoverage(t, ev);
  return { score: base * coverage, base, coverage, verifiers: { executable, grounding, independentReview } };
}

function computeCoverage(t: TemplateTransition, ev: TemplateTransition["transition"]["evidence"]): number {
  if (!ev || ev.oracleAdequacy.sufficient) return 1.0;
  const codeFiles = (t.transition.stateDeps?.write_set ?? [])
    .filter((w) => w.kind === "file" && isCodeFile(w.ref))
    .map((w) => w.ref);
  if (codeFiles.length === 0) return 1.0; // non-code output → no double-penalty
  const untestedCode = codeFiles.filter((f) => ev.untestedRegions.some((r) => r.startsWith(f + " "))).length;
  return Math.max(COVERAGE_FLOOR, 1 - untestedCode / codeFiles.length);
}
