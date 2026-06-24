import { z } from "zod";
import type { WorkflowGuardrailConfig } from "@orca/contracts";

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
