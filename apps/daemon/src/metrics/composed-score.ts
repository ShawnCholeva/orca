import type { TemplateTransition } from "./fetch.js";
import { isCodeFile } from "../harness-sensors/code-files.js";
import { sourcesPassed, SOURCE_CONFIDENCE } from "./source-signals.js";
import { effectiveSourceConfidence, type CalibrationEntry } from "./verification.js";

const COVERAGE_FLOOR = 0.3;

export type CompletionScore = {
  score: number; base: number; coverage: number;
  verifiers: { executable: boolean; grounding: boolean; independentReview: boolean };
};

export function composedScore(t: TemplateTransition, calibration?: CalibrationEntry[]): CompletionScore {
  const ev = t.transition.evidence;
  const rf = t.transition.refute;
  const zero = (): CompletionScore => ({ score: 0, base: 0, coverage: 0, verifiers: { executable: false, grounding: false, independentReview: false } });
  // A refuted completion scores 0 here even if its source (e.g. grounding) passed — but
  // computeCalibration STILL counts it in that source's bucket (as the "overturned" side
  // of upheld/(upheld+refuted)). So "bucketed as grounding-passed for calibration" and
  // "credited grounding in the score" match on every NON-refuted completion; they differ
  // exactly on the refuted rows, which is the survival measurement itself — not a divergence.
  if (rf?.verdict === "refuted") return zero();
  if (ev?.verdict === "failed") return zero();

  const { executable, grounding, independentReview } = sourcesPassed(ev, rf);
  const cs: number[] = [];
  if (executable) cs.push(effectiveSourceConfidence("executable", calibration));
  if (grounding) cs.push(effectiveSourceConfidence("grounding", calibration));
  if (independentReview) cs.push(SOURCE_CONFIDENCE.independent_review); // never calibrated (circular)
  const base = cs.length === 0 ? SOURCE_CONFIDENCE.self_report : 1 - cs.reduce((p, c) => p * (1 - c), 1);

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
