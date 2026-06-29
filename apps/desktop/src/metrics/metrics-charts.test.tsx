import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Delta, OutcomeBar, StatTile } from "./metrics-charts";

describe("Delta", () => {
  it("renders ±0 in neutral form for zero", () => {
    render(<Delta value={0} />);
    expect(screen.getByText("±0")).toBeInTheDocument();
  });

  it("uses run color when an up move is good", () => {
    const { container } = render(<Delta value={5} good="up" />);
    const el = container.querySelector("span");
    expect(el?.getAttribute("style")).toContain("var(--run)");
  });

  it("uses err color when an up move is bad", () => {
    const { container } = render(<Delta value={5} good="down" />);
    const el = container.querySelector("span");
    expect(el?.getAttribute("style")).toContain("var(--err)");
  });
});

describe("StatTile", () => {
  it("renders label, value and grade", () => {
    render(<StatTile label="Workflow health" value={82} grade="B" accent="var(--run)" delta={4} />);
    expect(screen.getByText("Workflow health")).toBeInTheDocument();
    expect(screen.getByText("82")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });
});

describe("OutcomeBar", () => {
  it("renders without crashing for all-zero input", () => {
    const { container } = render(<OutcomeBar passed={0} recovered={0} failed={0} />);
    expect(container.firstChild).toBeTruthy();
  });
});
