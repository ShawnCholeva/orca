import { useEffect, useState } from "react";
import type { RunSummary } from "@orca/contracts";
import { gateFor } from "@orca/contracts";
import { getRunSummaries } from "../api";
import { formatDuration } from "./interval-bar";
import { MeasurementLabel } from "./n-gate-ui";

// Averages of a workflow's runs.
//
// "Average" is the word for it, and most of what is worth knowing here is not one:
// it is a SUM. Total spend, total elapsed, total time waiting on a person and the
// share that represents are arithmetic over observed runs — exact at n=1, exact at
// n=7, no sampling distribution involved. They are the figures this founder actually
// asks about, and they need no hedging because nothing is being estimated.
//
// What genuinely is an average — a typical run's duration — is gated: a median needs
// five observations, a mean needs eight and a spread. Below those the runs are shown
// individually, which at this n is both honest and more informative than a summary.
//
// So the page is loud where it is exact and quiet where it is not, rather than
// uniformly hedged. The old averages tab greys everything to the same tone whether
// it is a census or a guess, which is why it reads as noise.

const dur = (ms: number) => formatDuration(ms) ?? "not recorded";
const usd = (v: number) => `$${v.toFixed(2)}`;

interface Rollup {
  templateId: string;
  name: string;
  runs: RunSummary[];
  elapsedMs: number;
  workingMs: number;
  parkedMs: number;
  unaccountedMs: number;
  usd: number;
  completed: number;
  stopped: number;
  running: number;
}

/** Group runs by the workflow that produced them and sum what can be summed. */
export function rollupByWorkflow(runs: RunSummary[]): Rollup[] {
  const byId = new Map<string, Rollup>();
  for (const r of runs) {
    let g = byId.get(r.templateId);
    if (!g) {
      g = {
        templateId: r.templateId, name: r.templateName, runs: [],
        elapsedMs: 0, workingMs: 0, parkedMs: 0, unaccountedMs: 0, usd: 0,
        completed: 0, stopped: 0, running: 0,
      };
      byId.set(r.templateId, g);
    }
    g.runs.push(r);
    g.elapsedMs += r.durations.elapsedMs;
    g.workingMs += r.durations.workingMs;
    g.parkedMs += r.durations.parkedMs;
    g.unaccountedMs += r.durations.unaccountedMs;
    g.usd += r.cost.usd;
    if (r.terminationCause === "completed") g.completed++;
    else if (r.terminationCause === "running") g.running++;
    else g.stopped++;
  }
  return [...byId.values()].sort((a, b) => b.runs.length - a.runs.length);
}

/** A figure that is exact, at the size its magnitude deserves. */
function Figure({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div style={{ display: "grid", gap: "var(--sp-1)", minWidth: 0 }}>
      <span
        className="mono"
        style={{ fontSize: "var(--fs-6)", fontWeight: 600, letterSpacing: -0.8, color: tone ?? "var(--text)", lineHeight: 1 }}
      >
        {value}
      </span>
      <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)", letterSpacing: 0.6, textTransform: "uppercase" }}>
        {label}
      </span>
    </div>
  );
}

/**
 * The typical run — the points, the median, or both.
 *
 * orca-d0's rule, and the reasoning is why it isn't just the gate table: `median`
 * clears at n>=5, but the gate exists to stop a summary REPLACING observations the
 * reader could otherwise see. Below thirteen runs they all fit on screen, so the
 * points are a census and cost nothing; above that they stop being readable and the
 * summary earns its place.
 *
 * No mean, at any n. The gate would allow one at eight, but these runs span 0.1h to
 * 51h — a 460x range — and a mean over that is a number no run resembles.
 */
const POINTS_STAY_VISIBLE_UPTO = 12;

function TypicalRun({ rollup }: { rollup: Rollup }) {
  const durations = rollup.runs.map((r) => r.durations.elapsedMs).sort((a, b) => a - b);
  const n = durations.length;
  if (n === 0) return null;
  const medianAllowed = gateFor("median", n).meets;
  const showPoints = n <= POINTS_STAY_VISIBLE_UPTO;

  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      {medianAllowed ? (
        <span className="mono" style={{ fontSize: "var(--fs-5)", fontWeight: 600 }}>
          {dur(durations[Math.floor(n / 2)]!)}
          <span style={{ fontSize: "var(--fs-1)", fontWeight: 400, color: "var(--text-3)" }}> median of {n}</span>
        </span>
      ) : (
        <MeasurementLabel state="insufficient" have={n} need={gateFor("median", n).gate ?? 5} unit="runs" />
      )}
      {showPoints && (
        <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap" }}>
          {durations.map((d, i) => (
            <span key={i} className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--text-2)" }}>{dur(d)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowCard({ rollup }: { rollup: Rollup }) {
  const n = rollup.runs.length;
  const parkedShare = rollup.elapsedMs > 0 ? Math.round((rollup.parkedMs / rollup.elapsedMs) * 100) : null;

  return (
    <section style={{ display: "grid", gap: "var(--sp-5)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-3)", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "var(--fs-5)", fontWeight: 600, margin: 0, color: "var(--text)" }}>{rollup.name}</h2>
        <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>
          {n} {n === 1 ? "run" : "runs"} · {rollup.completed} completed · {rollup.stopped} stopped by Orca
          {rollup.running > 0 ? ` · ${rollup.running} still running` : ""}
        </span>
      </div>

      {/* Sums, at full weight. Every one is exact — arithmetic over observed runs,
          with no sampling distribution to hedge. Loud where exact, quiet where not. */}
      <div style={{ display: "flex", gap: "var(--sp-6)", flexWrap: "wrap" }}>
        <Figure value={usd(rollup.usd)} label="spent across these runs" />
        <Figure value={dur(rollup.elapsedMs)} label="wall clock" />
        <Figure value={dur(rollup.workingMs)} label="orca working" tone="var(--run)" />
        <Figure
          value={parkedShare == null ? dur(rollup.parkedMs) : `${parkedShare}%`}
          label={`of those ${dur(rollup.elapsedMs)} was waiting on you`}
          tone="var(--accent-2)"
        />
      </div>

      {/* The denominator says what it is made of.
          A ratio of two exact sums over a fully-enumerated set is a FACT and needs no
          gate — but it is dominated by the largest run, so it answers "where did my
          time go in total" and NOT "what is a typical run like". Those are different
          questions with different numbers, which is why no mean of per-run ratios
          appears anywhere near it.
          And most of these runs were killed by the substrate. For "where did the time
          go" they legitimately count — the wall clock was real. For anything about how
          the workflow behaves they do not, so the composition is stated rather than
          left for the reader to assume. Without this it is the contamination finding
          again, on a new surface. */}
      <span style={{ fontSize: "var(--fs-2)", color: "var(--text-2)", maxWidth: "72ch", lineHeight: 1.5 }}>
        Totals across all {n} {n === 1 ? "run" : "runs"}
        {rollup.stopped > 0 ? `, ${rollup.stopped} of which Orca stopped before finishing` : ""}
        {rollup.running > 0 ? `, and ${rollup.running} still running` : ""}. Dominated by the longest run,
        so this is where your time went in total rather than what a single run looks like.
      </span>

      {/* The four terms must add up, and the reader can check that here as on the
          ledger. That property is what makes the split falsifiable rather than
          merely presented. */}
      <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-2)", lineHeight: 1.5 }}>
        {dur(rollup.elapsedMs)} = {dur(rollup.workingMs)} working + {dur(rollup.parkedMs)} waiting on you
        {" + "}{dur(rollup.unaccountedMs)} unaccounted
      </span>

      <div style={{ display: "grid", gap: "var(--sp-2)" }}>
        <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)", letterSpacing: 0.6, textTransform: "uppercase" }}>
          A typical run
        </span>
        <TypicalRun rollup={rollup} />
      </div>
    </section>
  );
}

export function WorkflowRollup() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    getRunSummaries().then((r) => { if (live) setRuns(r); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  if (failed) return <p style={{ fontSize: "var(--fs-3)", color: "var(--err)" }}>Couldn&apos;t load runs.</p>;
  if (runs === null) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>Loading…</p>;

  const rollups = rollupByWorkflow(runs);
  if (rollups.length === 0) {
    return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>No workflow has run yet.</p>;
  }

  return (
    <div style={{ display: "grid", alignContent: "start", gap: "var(--sp-6)" }}>
      {rollups.map((r) => <WorkflowCard key={r.templateId} rollup={r} />)}
    </div>
  );
}
