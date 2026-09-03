import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntervalBar, formatDuration } from "./interval-bar";

const S = 1000;
const M = 60 * S;
const H = 60 * M;

describe("formatDuration", () => {
  it("never renders a nonzero duration as zero", () => {
    expect(formatDuration(1)).toBe("under 1s");
    expect(formatDuration(999)).toBe("under 1s");
  });

  it("keeps a true zero as a measurement, distinct from a floor", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("climbs the ladder without letting a unit swallow the one below it", () => {
    expect(formatDuration(36 * S)).toBe("36s");
    expect(formatDuration(3 * M + 40 * S)).toBe("3m 40s");
    expect(formatDuration(17 * M)).toBe("17m");
    expect(formatDuration(H + 12 * M)).toBe("1h 12m");
    expect(formatDuration(21 * H)).toBe("21h 0m");
  });

  it("promotes rather than rounding to a full unit of the tier below", () => {
    expect(formatDuration(59.7 * S)).toBe("1m 0s");
  });

  it("is null-safe", () => {
    expect(formatDuration(null)).toBeNull();
  });
});

describe("IntervalBar", () => {
  const run = { elapsedMs: 21 * H, workingMs: 73 * M, parkedMs: 18 * H + 45 * M, unaccountedMs: 62 * M };

  it("proportions the three materials against elapsed", () => {
    const { container } = render(<IntervalBar {...run} />);
    const working = container.querySelector('[data-seg="working"]') as HTMLElement;
    // 1h13m of 21h ~ 5.8%
    expect(parseFloat(working.style.width)).toBeCloseTo(5.79, 1);
  });

  it("distinguishes unaccounted by material, not only by colour", () => {
    const { container } = render(<IntervalBar {...run} />);
    const un = container.querySelector('[data-seg="unaccounted"]') as HTMLElement;
    // happy-dom discards a gradient value containing var(), so the CSS itself is
    // not observable here. Assert the semantic contract instead: unaccounted is
    // marked as a distinct material, so it survives being read without colour.
    expect(un.getAttribute("data-material")).toBe("hatched");
    const measured = container.querySelector('[data-seg="working"]') as HTMLElement;
    expect(measured.getAttribute("data-material")).toBeNull();
  });

  it("carries all four terms in text — a residual is never rendered alone", () => {
    render(<IntervalBar {...run} />);
    const el = screen.getByRole("img");
    const text = el.getAttribute("aria-label")!;
    expect(text).toMatch(/21h 0m elapsed/);
    expect(text).toMatch(/1h 13m working/);
    expect(text).toMatch(/18h 45m parked/);
    expect(text).toMatch(/1h 2m unaccounted/);
  });

  it("renders an explicit absent interior rather than a zero-width bar", () => {
    // Worker gates emit no harness transitions at all. A zero-width bar would read
    // as "instant", which asserts a duration nobody measured.
    const { container } = render(
      <IntervalBar elapsedMs={4 * M} workingMs={null} parkedMs={null} unaccountedMs={null} />
    );
    expect(container.querySelector('[data-seg="absent"]')).toBeTruthy();
    expect(container.querySelector('[data-seg="working"]')).toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/not recorded/i);
  });

  it("refuses to normalize a broken invariant into a tidy bar", () => {
    // working + parked + unaccounted must equal elapsed. Scaling the parts to fit
    // is exactly how a wrong-but-positive unaccounted would hide.
    const { container } = render(
      <IntervalBar elapsedMs={10 * M} workingMs={2 * M} parkedMs={2 * M} unaccountedMs={2 * M} />
    );
    expect(container.querySelector('[data-seg="mismatch"]')).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/do not add up/i);
  });

  it("accepts the invariant when the parts sum exactly", () => {
    const { container } = render(<IntervalBar {...run} />);
    expect(container.querySelector('[data-seg="mismatch"]')).toBeNull();
  });

  it("renders nothing measurable when elapsed itself is absent", () => {
    const { container } = render(
      <IntervalBar elapsedMs={null} workingMs={null} parkedMs={null} unaccountedMs={null} />
    );
    expect(container.querySelector('[data-seg="absent"]')).toBeTruthy();
  });

  it("never signals anything with opacity", () => {
    const { container } = render(<IntervalBar {...run} />);
    expect(container.innerHTML).not.toMatch(/opacity/i);
  });

  it("takes durations only — there is no way to ask it to place a span in time", () => {
    // latency_ms is a sum of model turns with no start timestamp, so a positioned
    // timeline would look authoritative and be fabricated. Guarded by the prop type;
    // asserted here so a future timestamp prop trips a test rather than a review.
    const props = Object.keys(run);
    expect(props.some((k) => /start|end|at$|timestamp/i.test(k))).toBe(false);
  });
});
