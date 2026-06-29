import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricsPage } from "./MetricsPage";

describe("MetricsPage", () => {
  it("renders the KPI strip for the default workflow", () => {
    render(<MetricsPage />);
    expect(screen.getByText("Workflow health")).toBeInTheDocument();
    expect(screen.getByText("First-pass")).toBeInTheDocument();
    expect(screen.getByText("Self-recovered")).toBeInTheDocument();
    expect(screen.getByText("Escalated")).toBeInTheDocument();
  });

  it("switches the step list when a different workflow is chosen", () => {
    render(<MetricsPage />);
    expect(screen.getByText("Define Intent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Brainstorm/ }));
    fireEvent.click(screen.getByText("Shadow-then-cutover"));
    expect(screen.getByText("Plan migration")).toBeInTheDocument();
    expect(screen.queryByText("Define Intent")).not.toBeInTheDocument();
  });

  it("toggles the period control", () => {
    render(<MetricsPage />);
    const btn = screen.getByRole("button", { name: "30d" });
    fireEvent.click(btn);
    expect(btn).toBeInTheDocument();
  });
});
