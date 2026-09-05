import type { TemplateMetricsDetail } from "@orca/contracts";
import { RateInterval } from "./n-gate-ui";

// A pipeline health view in which a score cannot be rendered above its sample.
//
// The tab this sits beside gates a score on `score == null` and nothing else
// (`StepPerformance.tsx:187`); `sampleSize` is read once, to print an `n=` marker
// beside the name. So a 20px score and a letter grade render identically at n=1 and
// at n=50, and the sample is decoration. Four render sites do it — two tiles and
// both row kinds — which is why "gate the tiles" was never the fix: it would have
// left a grade on every row with the tiles above showing none, recreating the uneven
// application through its own remedy.
//
// Here the rule is structural rather than remembered: `ScoreReadout` takes the score
// AND the sample and decides between them. There is no prop that accepts a
// pre-formatted grade, and no way to pass a number without the evidence for it.

/**
 * How much of this node's work has been independently checked — a COUNT, rendered
 * through the gate table rather than summarised.
 *
 * This replaced a `ScoreReadout` that had two defects, and the second is the one that
 * mattered. The first, which orca-1a caught: it gated the letter grade and rendered
 * the score unconditionally, so `100 /100` from a single run was the loudest cell on
 * the surface. A band is coarser than an integer — evidence that cannot choose
 * between `A` and `B` certainly cannot choose between `100` and `87`.
 *
 * The second, found while fixing the first: **the interval that gate consumed was
 * fabricated.** It did `proportionInterval(round(score/100 * n), n - …)`, treating a
 * composed 0–100 score as a count of successes out of n. The score is not a binomial
 * proportion and has no such sampling distribution, so the interval was invented and
 * every grade decision rested on it. A gate built to stop a claim outrunning its
 * evidence was itself doing exactly that.
 *
 * The remedy is the surface's own thesis rather than a better estimate: coverage is
 * COUNTED, quality is ESTIMATED. `verifiedSampleSize` of `runs` is a real numerator
 * over a real denominator, exact at n=1, and `RateInterval` already renders it
 * correctly at every n — a word at one observation, "x of n" below five, a rate with
 * its interval above. No score, no grade, and nothing fabricated.
 */
export function CoverageReadout({ checked, of }: { checked: number; of: number }) {
  if (of === 0) {
    return <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>No runs this period</span>;
  }
  return (
    <RateInterval
      pos={checked}
      neg={of - checked}
      label="independently checked"
      outcomeWords={{ pass: "checked", fail: "not checked" }}
    />
  );
}

/** A count that says what it counts. Two populations on one screen collide only when neither carries its noun. */
export function Sample({ n, noun }: { n: number; noun: string }) {
  return (
    <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)", whiteSpace: "nowrap" }}>
      {n} {n === 1 ? noun : `${noun}s`}
    </span>
  );
}

/** A node reduced to what this surface can state exactly: how much of it was checked. */
type Node = { kind: "step" | "gate"; id: string; name: string; runs: number; checked: number };

function nodesOf(detail: TemplateMetricsDetail): Node[] {
  const steps: Node[] = detail.steps.map((s) => ({
    kind: "step", id: s.stepTemplateId, name: s.name,
    runs: s.runs, checked: s.quality.verifiedSampleSize,
  }));
  const gates: Node[] = detail.gates.map((g) => ({
    kind: "gate", id: g.nodeId, name: g.name,
    runs: g.sampleSize, checked: g.decisionConfidence.sampleSize,
  }));
  return [...steps, ...gates];
}

/**
 * One fact about coverage, not about quality.
 *
 * The ledger's headline works because "4 of 5 runs ended the same way" is a count.
 * A headline about which step is worst would be a comparison across nodes with one
 * to five observations each — precisely the claim every row below refuses to make,
 * asserted in the largest text on the screen. So this reports what has been checked
 * rather than what is good, which is a census and exact at any n.
 */
export function coverageHeadline(detail: TemplateMetricsDetail): string {
  const nodes = nodesOf(detail);
  if (nodes.length === 0) return "No steps have run yet.";
  const unchecked = nodes.filter((n) => n.checked === 0).length;
  if (unchecked === 0) return `All ${nodes.length} steps in this workflow have been independently checked.`;
  return `${unchecked} of ${nodes.length} steps in this workflow have never been independently checked.`;
}

function NodeRow({ node }: { node: Node }) {
  return (
    <div
      style={{
        display: "grid", gridTemplateColumns: "minmax(0,1fr) 200px",
        gap: "var(--sp-4)", alignItems: "start",
        padding: "var(--sp-3) 0", borderTop: "1px solid var(--hairline)",
      }}
    >
      <div style={{ display: "grid", gap: "var(--sp-1)", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--fs-3)", fontWeight: 600 }}>{node.name}</span>
          <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
            {node.kind}
          </span>
          {/* n rides beside the name at every row, with its noun. Two populations on
              one screen collide only when neither says what it counts. */}
          <Sample n={node.runs} noun="run" />
        </div>

      </div>
      <div style={{ justifySelf: "end", textAlign: "right" }}>
        <CoverageReadout checked={node.checked} of={node.runs} />
      </div>
    </div>
  );
}

export function PipelineHealth({ detail }: { detail: TemplateMetricsDetail | null }) {
  if (detail === null) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>Loading…</p>;
  const nodes = nodesOf(detail);

  return (
    <div style={{ display: "grid", alignContent: "start", gap: "var(--sp-5)" }}>
      <div style={{ background: "var(--panel-2)", borderRadius: "var(--r-lg)", padding: "var(--sp-4)" }}>
        <p style={{ fontSize: "var(--fs-4)", margin: 0, lineHeight: 1.5, maxWidth: "72ch" }}>
          {coverageHeadline(detail)}
        </p>
      </div>
      <section style={{ display: "grid" }}>
        {nodes.map((n) => <NodeRow key={`${n.kind}:${n.id}`} node={n} />)}
      </section>
    </div>
  );
}
