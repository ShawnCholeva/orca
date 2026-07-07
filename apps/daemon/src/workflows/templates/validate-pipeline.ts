import type { WorkflowStepTemplate } from "@orca/contracts";

const REF_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const selectorHead = (selector: string): string => selector.split(".")[0].replace(/\[\]$/, "");

// Cross-check a step's grounding selectors against its own outputSchema (and,
// for subset_of_prior, against earlier steps) so schema/check drift is a CI
// warning, not a silent always-skipped check at runtime.
function groundingWarnings(
  step: WorkflowStepTemplate,
  earlierSteps: Map<string, WorkflowStepTemplate>
): string[] {
  const warnings: string[] = [];
  const ownKeys = new Set(step.outputSchema.map((f) => f.key));
  const ownSelector = (selector: string, what: string): void => {
    if (!ownKeys.has(selectorHead(selector))) {
      warnings.push(`step '${step.id}' grounding ${what} '${selector}' does not match any output schema key`);
    }
  };
  for (const check of step.grounding ?? []) {
    switch (check.rule) {
      case "paths_exist":
      case "paths_changed":
        ownSelector(check.field, "selector");
        break;
      case "member_of":
        ownSelector(check.field, "selector");
        ownSelector(check.set, "set selector");
        break;
      case "implies":
        ownSelector(check.when.field, "antecedent selector");
        ownSelector(check.then.field, "consequent selector");
        break;
      case "subset_of_prior": {
        ownSelector(check.field, "selector");
        for (const p of check.prior) {
          const prior = earlierSteps.get(p.stepId);
          if (!prior) {
            warnings.push(`step '${step.id}' grounding subset_of_prior references '${p.stepId}', which is not an earlier step`);
          } else if (!prior.outputSchema.some((f) => f.key === selectorHead(p.field))) {
            warnings.push(`step '${step.id}' grounding subset_of_prior selector '${p.field}' does not match step '${p.stepId}' output schema`);
          }
        }
        break;
      }
    }
  }
  return warnings;
}

export function validateTemplatePipeline(steps: WorkflowStepTemplate[]): string[] {
  const warnings: string[] = [];
  const knownByOrdinal: string[][] = [];
  const earlierSteps = new Map<string, WorkflowStepTemplate>();
  const sorted = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  for (const step of sorted) {
    const refs = new Set<string>();
    let m: RegExpExecArray | null;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(step.instructions)) !== null) refs.add(m[1]);

    const knownSoFar = new Set(knownByOrdinal.flat());
    for (const ref of refs) {
      if (!knownSoFar.has(ref)) {
        warnings.push(`step '${step.id}' instructions reference unknown key '{{${ref}}}'`);
      }
    }
    warnings.push(...groundingWarnings(step, earlierSteps));
    knownByOrdinal.push(step.outputSchema.map((f) => f.key));
    earlierSteps.set(step.id, step);
  }
  return warnings;
}
