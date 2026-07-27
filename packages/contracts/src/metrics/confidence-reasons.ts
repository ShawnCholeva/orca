// Deterministic, human-readable labels for the confidence-reason enum — the drawer's
// "why isn't this a 100?" line. Renders the score's own evidence computation; never
// editorial copy. No jargon (guarded). Mirrors the failure-labels.ts discipline.
export const CONFIDENCE_REASON_CODES = [
  "no_check_yet",
  "review_only",
  "weak_verifier",
  "vindication_pending",
  "downstream_bounced",
] as const;

export type ConfidenceReasonCode = (typeof CONFIDENCE_REASON_CODES)[number];

export function labelForConfidenceReason(reason: { code: ConfidenceReasonCode; nodeName?: string }): string {
  switch (reason.code) {
    case "no_check_yet":
      return "Nothing independent has checked this step yet.";
    case "review_only":
      return "A review is the only thing backing this — no test has run to confirm it.";
    case "weak_verifier":
      return `${reason.nodeName ?? "A review"} approved this, but that hasn't held up downstream yet.`;
    case "vindication_pending":
      return "The next step hasn't accepted this work yet.";
    case "downstream_bounced":
      return "Downstream sent this work back.";
  }
}
