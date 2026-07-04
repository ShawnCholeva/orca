import type { RiskClass } from "@orca/contracts";

export const RISK_RANK: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function riskClassAtLeast(a: RiskClass, b: RiskClass): boolean {
  return RISK_RANK[a] >= RISK_RANK[b];
}
