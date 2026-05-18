import { GuidedRefinementInput, GuidedRefinementOutput } from "@orca/contracts";
import type { SkillDescriptor } from "../registry/types.js";

type SectionKey = "successCriteria" | "constraints" | "assumptions";

const SECTION_HEADERS: Array<{ pattern: RegExp; key: SectionKey }> = [
  { pattern: /^\s*(?:goals?|success criteria|outcomes?)\s*:/i, key: "successCriteria" },
  { pattern: /^\s*(?:constraints?|requirements?|must)\s*:/i, key: "constraints" },
  { pattern: /^\s*(?:assumptions?|given)\s*:/i, key: "assumptions" },
];

const BULLET_RE = /^\s*(?:[-*•]|\d+\.)\s+(.+)$/;

function processItems(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const folded = trimmed.toLocaleLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    result.push(trimmed.slice(0, 200));
    if (result.length >= 20) break;
  }
  return result;
}

function parseDescription(raw: string): {
  description: string;
  successCriteria: string[];
  constraints: string[];
  assumptions: string[];
} {
  const lines = raw.split("\n");
  let currentSection: SectionKey | null = null;
  const descLines: string[] = [];
  const collected: Record<SectionKey, string[]> = {
    successCriteria: [],
    constraints: [],
    assumptions: [],
  };

  for (const line of lines) {
    const header = SECTION_HEADERS.find((h) => h.pattern.test(line));
    if (header) {
      currentSection = header.key;
      continue;
    }

    if (currentSection !== null) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const bullet = BULLET_RE.exec(line);
      if (bullet) {
        collected[currentSection].push(bullet[1]!.trim());
      } else {
        collected[currentSection].push(trimmed);
      }
    } else {
      descLines.push(line);
    }
  }

  // Collapse 3+ consecutive blank lines (4+ newlines) to 2 blank lines, then trim trailing whitespace.
  const description = descLines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd();

  return {
    description,
    successCriteria: processItems(collected.successCriteria),
    constraints: processItems(collected.constraints),
    assumptions: processItems(collected.assumptions),
  };
}

export const guidedGoalRefinementSkill: SkillDescriptor<
  GuidedRefinementInput,
  GuidedRefinementOutput
> = {
  id: "guided-goal-refinement",
  pluginId: "orca.default-skills",
  extensionPoint: "goal.refine",
  title: "Guided Goal Refinement",
  description:
    "Deterministic structuring of a rough Goal into success criteria, constraints, and assumptions.",

  invoke(input, _ctx): GuidedRefinementOutput {
    const parsed = GuidedRefinementInput.parse(input);
    const { description, successCriteria, constraints, assumptions } = parseDescription(
      parsed.description
    );

    return GuidedRefinementOutput.parse({
      skillId: "guided-goal-refinement",
      title: parsed.title.trim(),
      description,
      successCriteria,
      constraints,
      assumptions,
    });
  },
};
