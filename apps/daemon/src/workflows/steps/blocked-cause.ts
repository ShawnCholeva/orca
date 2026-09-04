import { StepBlockedCode, type StepBlockedCause } from "@orca/contracts";

/**
 * Why a step run stopped, and how confidently we know it.
 *
 * ONE derivation, so no surface re-implements the fallback and none of them can
 * quietly disagree about whether a cause is verified. A consumer gets
 * `{ code, inferred }` and never has to know which source it came from.
 *
 * A row written before `blocked_code` existed yields `unknown` / `inferred: true`
 * — NOT a guessed code. Matching the free-text reason can tell you the FAMILY
 * (something in the substrate failed) but not which member, and returning a
 * specific code would assert more than the sentence supports. `classifyInfraReason`
 * remains the right tool for the family question and stays where it is, feeding
 * the observational `infrastructureFailures` list; it is deliberately not used
 * here, because this value is the one a headline claim may rest on.
 *
 * Historical rows are NOT backfilled. Running a classifier over them and storing
 * the result would mix a verified signal with a guessed one under one name, which
 * is the exact defect the column exists to remove. The inferred count falls on its
 * own as new rows accumulate — nothing has to clear it.
 */
export function deriveStepBlockedCause(input: {
  blockedCode: string | null | undefined;
  blockedReason: string | null | undefined;
}): StepBlockedCause | null {
  const parsed = StepBlockedCode.safeParse(input.blockedCode);
  if (parsed.success) return { code: parsed.data, inferred: false };

  // A code this build doesn't recognise is not the same as no code: something
  // wrote a value we've never heard of. Say `unknown` rather than falling through
  // and inventing a more confident answer than we have.
  if (input.blockedCode != null && input.blockedCode !== "") {
    return { code: "unknown", inferred: true };
  }

  // No code at all. If the step wasn't blocked there is nothing to explain;
  // if it was, the sentence is all we have and it does not name a code.
  if (input.blockedReason == null || input.blockedReason === "") return null;
  return { code: "unknown", inferred: true };
}
