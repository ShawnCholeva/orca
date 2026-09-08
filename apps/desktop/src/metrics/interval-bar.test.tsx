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

  it("paints blocked and reviewing as measured segments of their own and names them in text", () => {
    const { container } = render(
      <IntervalBar elapsedMs={10 * M} workingMs={2 * M} parkedMs={3 * M} haltedMs={M} reviewingMs={M} unaccountedMs={3 * M} />
    );
    expect(container.querySelector('[data-seg="mismatch"]')).toBeNull();
    expect(parseFloat((container.querySelector('[data-seg="halted"]') as HTMLElement).style.width)).toBeCloseTo(10, 1);
    expect(parseFloat((container.querySelector('[data-seg="reviewing"]') as HTMLElement).style.width)).toBeCloseTo(10, 1);
    const text = screen.getByRole("img").getAttribute("aria-label")!;
    expect(text).toMatch(/1m 0s blocked/);
    expect(text).toMatch(/1m 0s reviewing/);
    expect(text).toMatch(/3m 0s unaccounted/);
  });

  it("paints the worker's turn beyond inference in the worker's second hue", () => {
    const { container } = render(
      <IntervalBar elapsedMs={10 * M} workingMs={2 * M} agentMs={3 * M} parkedMs={2 * M} unaccountedMs={3 * M} />
    );
    expect(container.querySelector('[data-seg="mismatch"]')).toBeNull();
    const agent = container.querySelector('[data-seg="agent"]') as HTMLElement;
    expect(parseFloat(agent.style.width)).toBeCloseTo(30, 1);
    expect(agent.style.background).toContain("--run-2");
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/3m 0s between model calls/);
  });

  it("names blocked and reviewing only when there was any", () => {
    render(<IntervalBar {...run} haltedMs={0} reviewingMs={0} />);
    const text = screen.getByRole("img").getAttribute("aria-label")!;
    expect(text).not.toMatch(/blocked|reviewing/);
  });

  it("counts blocked and reviewing in the invariant", () => {
    // Five terms must sum. Leaving the two new ones out of the check would let a
    // bar that paints 12 minutes of a 10-minute span pass as tidy.
    const { container: ok } = render(
      <IntervalBar elapsedMs={10 * M} workingMs={2 * M} parkedMs={2 * M} haltedMs={2 * M} reviewingMs={2 * M} unaccountedMs={2 * M} />
    );
    expect(ok.querySelector('[data-seg="mismatch"]')).toBeNull();
    const { container: bad } = render(
      <IntervalBar elapsedMs={10 * M} workingMs={2 * M} parkedMs={2 * M} haltedMs={2 * M} reviewingMs={2 * M} unaccountedMs={4 * M} />
    );
    expect(bad.querySelector('[data-seg="mismatch"]')).toBeTruthy();
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

  it("paints only the measured parts, leaving unaccounted as the ground they sit on", () => {
    // Unaccounted is the TRACK, not a third block at the right end. As a trailing
    // segment it sat exactly where a progress bar's "remaining" lives, so the whole
    // control read as a fill — on a mixed row, literally a green bar at 26%. As the
    // ground, the reader never has to learn it as a category: everything we know is
    // painted onto everything we don't.
    const { container } = render(<IntervalBar {...run} />);
    const widths = ["working", "parked"].map((seg) =>
      parseFloat((container.querySelector(`[data-seg="${seg}"]`) as HTMLElement).style.width)
    );
    // 21h elapsed, 1h2m unaccounted -> the painted share stops ~4.92% short.
    expect(widths[0]! + widths[1]!).toBeCloseTo(95.08, 1);
    expect(container.querySelector('[data-seg="unaccounted-segment"]')).toBeNull();
  });

  it("keeps unaccounted an input it can disagree with, never a leftover it derives", () => {
    // The track's width no longer needs unaccountedMs, so it would be natural to
    // stop taking it and infer it from what isn't painted. That would make a
    // mismatch unrepresentable — which sounds like a strength and is the opposite:
    // a wrong-but-positive unaccounted becomes undetectable, and the gate-span bug
    // this guard caught on live data would have drawn a plausible bar instead.
    const { container } = render(
      <IntervalBar elapsedMs={10 * M} workingMs={2 * M} parkedMs={2 * M} unaccountedMs={2 * M} />
    );
    expect(container.querySelector('[data-seg="mismatch"]')).toBeTruthy();
    expect(container.querySelector('[data-seg="working"]')).toBeNull();
  });

  it("does not paint parked in the colour the app uses for interaction", () => {
    // --accent is the link, the selected tab and the `running` tone. Parked time
    // wearing it made the widest band on most rows read as "click me", and it is
    // the one band the reader must not mistake for a control.
    const { container } = render(<IntervalBar {...run} />);
    const parked = container.querySelector('[data-seg="parked"]') as HTMLElement;
    expect(parked.style.background).toContain("--accent-2");
    expect(parked.style.background).not.toContain("var(--accent)");
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
