import { z } from "zod";
import type { GroundingCheck, WorkflowGuardrailConfig, WorkflowStepTemplate } from "@orca/contracts";

const ValidationRuleConfig = z.object({
  appliesToSteps: z.array(z.string()).optional(),
  required: z.array(z.string()).optional(),
});

export function stepRequiresExecution(
  guardrails: WorkflowGuardrailConfig[],
  stepTemplateId: string
): { required: string[] } | null {
  for (const g of guardrails) {
    if (g.kind !== "validation_rule") continue;
    const cfg = ValidationRuleConfig.safeParse(g.configJson);
    if (!cfg.success) continue;
    const applies = cfg.data.appliesToSteps ?? [];
    if (applies.includes(stepTemplateId)) {
      return { required: cfg.data.required ?? [] };
    }
  }
  return null;
}

// The full deterministic completion gate for a step: the sensor ladder (from
// the validation_rule guardrail) plus the step's declared grounding checks.
// `gated` decides whether the evidence gate runs at all for this completion.
export function stepCompletionGate(
  guardrails: WorkflowGuardrailConfig[],
  stepTpl: WorkflowStepTemplate
): { sensors: { required: string[] } | null; grounding: GroundingCheck[]; gated: boolean } {
  const sensors = stepRequiresExecution(guardrails, stepTpl.id);
  const grounding = stepTpl.grounding ?? [];
  return { sensors, grounding, gated: sensors !== null || grounding.length > 0 };
}
