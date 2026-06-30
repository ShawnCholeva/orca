import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelfImprovementRail } from "./SelfImprovement";
import type { TemplateMetricsDetail } from "@orca/contracts";

function detailWith(scores: number[]): TemplateMetricsDetail {
  return { summary: { name: "Brainstorm" }, steps: scores.map((score, i) => ({ stepTemplateId: `s${i}`, name: `Step ${i}`, score })) } as unknown as TemplateMetricsDetail;
}

describe("SelfImprovementRail", () => {
  it("summarizes underperforming steps deterministically", () => {
    render(<SelfImprovementRail detail={detailWith([95, 61, 58])} workflowName="Brainstorm" />);
    expect(screen.getByText(/2 steps underperforming/i)).toBeInTheDocument();
  });

  it("shows the deferred learning-loop state and no auto-apply toggle", () => {
    render(<SelfImprovementRail detail={detailWith([95])} workflowName="Brainstorm" />);
    expect(screen.getByText(/Learning loop not yet enabled/i)).toBeInTheDocument();
    expect(screen.queryByText(/Auto-apply/i)).not.toBeInTheDocument();
  });
});
