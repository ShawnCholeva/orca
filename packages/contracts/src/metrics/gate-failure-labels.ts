// Readable, jargon-free labels for gate failure modes. Mirrors metrics/failure-labels.ts.
export const GATE_FAILURE_CODES = [
  "overturned_approve", "blind_approve", "cap_hit", "stagnation", "reviewer_unavailable_park",
] as const;

const CATALOG: Record<string, string> = {
  overturned_approve: "Approved work a person then sent back",
  blind_approve: "Approved without any checks run behind it",
  cap_hit: "Kept sending work back until it ran out of retries",
  stagnation: "Looped on the same unresolved issues without progress",
  reviewer_unavailable_park: "Paused for a person because no reviewer was available",
};

export function labelForGateFailure(code: string): string {
  return CATALOG[code] ?? code.replace(/_/g, " ");
}
