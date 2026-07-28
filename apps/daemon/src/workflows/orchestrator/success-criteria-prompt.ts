// Shared, pure renderers for user-authored goal success criteria. Both return ""
// for an empty/undefined list so callers that splice them in are byte-identical
// for goals without criteria (empty-list parity — see the plan's Global Constraints).

export function successCriteriaBlock(criteria: string[] | undefined): string {
  if (!criteria || criteria.length === 0) return "";
  const lines = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `Success Criteria (the goal is met only if ALL are satisfied):\n${lines}\n\n`;
}

export function successCriteriaHint(criteria: string[] | undefined): string {
  if (!criteria || criteria.length === 0) return "";
  return (
    "The goal's successCriteria define the definition of done — the output must " +
    "satisfy EVERY criterion; treat any unmet criterion as grounds to reject.\n\n"
  );
}
