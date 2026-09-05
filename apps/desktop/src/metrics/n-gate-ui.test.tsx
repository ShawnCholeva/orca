import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MeasurementLabel, RateInterval } from "./n-gate-ui";

// The bands the metrics screen scores against (weak / strong edges).
const BANDS = [0.5, 0.8];

describe("RateInterval", () => {
  it("never renders silently empty with no observations", () => {
    // A silent empty render is the untyped absence with no dash to notice it by —
    // the one failure mode that does not show up in a screenshot.
    const { container } = render(<RateInterval pos={0} neg={0} />);
    expect(container).not.toBeEmptyDOMElement();
    expect(container.textContent).not.toMatch(/0%/);
  });

  it("defaults an unexplained absence to the weakest true claim", () => {
    render(<RateInterval pos={0} neg={0} />);
    expect(screen.getByText(/haven't established/i)).toBeInTheDocument();
  });

  it("lets a caller that knows the reason state it", () => {
    render(<RateInterval pos={0} neg={0} emptyState="insufficient" />);
    expect(screen.getByText(/Not enough runs yet/i)).toBeInTheDocument();
  });

  it("renders a word and no percentage at n=1", () => {
    render(<RateInterval pos={1} neg={0} label="passed" />);
    expect(screen.getByText("passed")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("uses the failing word at n=1 when the single observation failed", () => {
    render(<RateInterval pos={0} neg={1} outcomeWords={{ pass: "passed", fail: "failed" }} />);
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("leads with the count, not a percentage, at n=2-4", () => {
    render(<RateInterval pos={3} neg={1} bandEdges={BANDS} />);
    expect(screen.getByText("3 of 4")).toBeInTheDocument();
    expect(screen.queryByText("75%")).not.toBeInTheDocument();
  });

  it("leads with the percentage from n=5", () => {
    render(<RateInterval pos={4} neg={1} bandEdges={BANDS} />);
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("carries the interval in text for screen readers, not only as a bar", () => {
    render(<RateInterval pos={3} neg={1} bandEdges={BANDS} label="passed" />);
    const el = screen.getByRole("img");
    expect(el.getAttribute("aria-label")).toMatch(/3 of 4 passed/);
    expect(el.getAttribute("aria-label")).toMatch(/between 30% and 95%/);
  });

  it("draws the bar when the interval straddles a band edge", () => {
    const { container } = render(<RateInterval pos={3} neg={1} bandEdges={BANDS} />);
    expect(container.querySelector('[data-testid="interval-track"]')).toBeTruthy();
  });

  it("collapses to a plain number when the whole interval sits inside one band", () => {
    // 90 of 100 -> [0.826, 0.945]; no edge of [0.5, 0.8] falls inside, so the
    // uncertainty cannot change the verdict and drawing it is noise.
    const { container } = render(<RateInterval pos={90} neg={10} bandEdges={BANDS} />);
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(container.querySelector('[data-testid="interval-track"]')).toBeNull();
  });

  it("collapses on decision-relevance, never on width", () => {
    // Same 12pp-wide interval as above. Move a band edge inside it and the bar
    // must come back — width did not change, the decision did.
    const { container } = render(<RateInterval pos={90} neg={10} bandEdges={[0.5, 0.9]} />);
    expect(container.querySelector('[data-testid="interval-track"]')).toBeTruthy();
  });

  it("never collapses when no bands were supplied — an unknown verdict is not a settled one", () => {
    const { container } = render(<RateInterval pos={90} neg={10} />);
    expect(container.querySelector('[data-testid="interval-track"]')).toBeTruthy();
  });

  it("never signals uncertainty with opacity", () => {
    for (const [pos, neg] of [[1, 0], [3, 1], [0, 4], [90, 10]]) {
      const { container } = render(<RateInterval pos={pos} neg={neg} bandEdges={BANDS} />);
      expect(container.innerHTML).not.toMatch(/opacity/i);
    }
  });

  it("places the tick at the observed rate, not at a shrunken estimate", () => {
    // betaMean(0.5, K=4, 4, 0) would put this at 75%. The observed rate is 100%.
    const { container } = render(<RateInterval pos={4} neg={0} bandEdges={BANDS} />);
    const tick = container.querySelector('[data-testid="interval-point"]') as HTMLElement;
    expect(tick.style.left).toBe("100%");
  });

  it("keeps the span neutral so a straddle reads as a straddle", () => {
    const { container } = render(<RateInterval pos={3} neg={1} bandEdges={BANDS} />);
    const span = container.querySelector('[data-testid="interval-span"]') as HTMLElement;
    expect(span.style.background).not.toMatch(/--err|--warn|--run/);
  });
});

describe("MeasurementLabel", () => {
  it("renders nothing when the value is measured — the number speaks for itself", () => {
    const { container } = render(<MeasurementLabel state="measured" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("distinguishes waiting for runs from owing engineering work", () => {
    const { rerender, container } = render(<MeasurementLabel state="insufficient" needed={3} />);
    const waiting = container.textContent;
    rerender(<MeasurementLabel state="uninstrumented" />);
    expect(container.textContent).not.toBe(waiting);
  });

  it("marks a measured-then-discarded value as the urgent case", () => {
    const { container, rerender } = render(<MeasurementLabel state="uninstrumented" />);
    const absent = container.textContent;
    rerender(<MeasurementLabel state="uninstrumented" lossy />);
    expect(container.textContent).not.toBe(absent);
    expect(container.textContent).toMatch(/thrown away/i);
  });

  it("lets a structural non-measurement name its own cause", () => {
    render(<MeasurementLabel state="unmeasurable_structural" reason="no completion to check against — this run never finished" />);
    expect(screen.getByText(/this run never finished/)).toBeInTheDocument();
  });

  it("frames a per-side shortfall against its own threshold", () => {
    render(<MeasurementLabel state="insufficient" have={3} need={5} unit="runs per version" />);
    expect(screen.getByText(/Needs 5 runs per version; this has 3\./)).toBeInTheDocument();
  });

  it("renders the one-line fix when there is one, so absence is actionable", () => {
    render(
      <MeasurementLabel
        state="uninstrumented"
        lossy
        detail="Stamp the pause reason into the event."
      />
    );
    expect(screen.getByText("Stamp the pause reason into the event.")).toBeInTheDocument();
  });

  it("compacts to a tag that still resolves to the full sentence for a screen reader", () => {
    render(<MeasurementLabel state="unmeasurable_structural" compact
      reason="Nothing to check this total against — this run never finished." />);
    const tag = screen.getByRole("note");
    expect(tag.textContent).toBe("unchecked");
    expect(tag.getAttribute("aria-label")).toMatch(/this run never finished/);
  });

  it("keeps compact tags distinct per state — compaction must not collapse the vocabulary", () => {
    const tags = (["insufficient", "unmeasurable_coverage", "unmeasurable_structural", "uninstrumented", "unknown"] as const)
      .map((state) => {
        const { container } = render(<MeasurementLabel state={state} compact />);
        return container.textContent;
      });
    const { container: lossyEl } = render(<MeasurementLabel state="uninstrumented" compact lossy />);
    tags.push(lossyEl.textContent);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("carries the fix into the compact tag's accessible text rather than dropping it", () => {
    render(<MeasurementLabel state="uninstrumented" compact lossy detail="Stamp the pause reason into the event." />);
    expect(screen.getByRole("note").getAttribute("aria-label")).toMatch(/Stamp the pause reason/);
  });

  it("never signals absence with opacity — form carries the state", () => {
    for (const state of ["insufficient", "unmeasurable_coverage", "unmeasurable_structural", "uninstrumented"] as const) {
      const { container } = render(<MeasurementLabel state={state} />);
      expect(container.innerHTML).not.toMatch(/opacity/i);
    }
  });

  it("gives each state a visually distinct form rather than one shared treatment", () => {
    const borders = (["insufficient", "unmeasurable_coverage", "unmeasurable_structural", "uninstrumented"] as const).map(
      (state) => {
        const { container } = render(<MeasurementLabel state={state} />);
        const el = container.firstElementChild as HTMLElement;
        return `${el.style.borderLeftStyle}|${el.style.borderLeftColor}`;
      }
    );
    expect(new Set(borders).size).toBe(borders.length);
  });
});
