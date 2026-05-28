import type { WorkflowStepTemplate } from "@orca/contracts";

const REF_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function validateTemplatePipeline(steps: WorkflowStepTemplate[]): string[] {
  const warnings: string[] = [];
  const knownByOrdinal: string[][] = [];
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
    knownByOrdinal.push(step.outputSchema.map((f) => f.key));
  }
  return warnings;
}
