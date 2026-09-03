import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Intervention, RunDetail, RunSummary, RunTraceSpan } from "@orca/contracts";
import { getRunDetail, getRunSummaries } from "../api";
import { MeasurementLabel } from "./n-gate-ui";
import { IntervalBar, formatDuration } from "./interval-bar";

// A LEDGER, not a dashboard. Every run shown in full, newest first — no averages,
// no grades, no period selector. Each number is a count of something that happened,
// not an estimate of a population. At n=5 the reader looks at all five.
//
// Nothing here dims. An unmeasured value is a different object, not a faint one.

// ── formatting ───────────────────────────────────────────────────────────────

const dur = (ms: number): string => formatDuration(ms) ?? "not recorded";

function usd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── termination ──────────────────────────────────────────────────────────────

// Surfaced intact, never collapsed to a boolean. "The daemon killed the worker" is
// a sentence the reader can act on; a flag that suppresses a cell tells them nothing.
const TERMINATION_SENTENCE: Record<RunSummary["terminationCause"], string> = {
  running: "still running",
  completed: "finished",
  workflow_failed: "the workflow stopped it",
  infrastructure_killed: "stopped by the substrate, not the workflow",
  unknown: "stopped, with nothing recorded about why",
};

const TERMINATION_TONE: Record<RunSummary["terminationCause"], string> = {
  running: "var(--accent)",
  completed: "var(--run)",
  workflow_failed: "var(--warn)",
  infrastructure_killed: "var(--err)",
  unknown: "var(--text-3)",
};

/**
 * The runs that can say anything about the WORKFLOW: ones that actually finished.
 * A run the substrate killed measured the daemon, and a run still in flight has not
 * reported yet — neither is evidence about the workflow.
 *
 * Exported and shared because the headline and the sample-floor line must be the
 * SAME quantity, not two predicates that agree today. The n handed to a gate has to
 * be the n of a single population; two counts that happen to match are that rule
 * already broken, waiting for one of them to be edited.
 */
export function workflowEvidenceRuns(runs: RunSummary[]): RunSummary[] {
  return runs.filter((r) => r.terminationCause === "completed");
}

/**
 * One sentence, the most important true fact, computed rather than authored so it
 * stays true as the data changes. The contamination case leads: a run killed by the
 * substrate says nothing about the workflow, and reporting those five together
 * would describe the daemon while naming the workflow.
 */
export function headline(runs: RunSummary[]): string {
  if (runs.length === 0) return "No runs yet.";
  const infra = runs.filter((r) => r.terminationCause === "infrastructure_killed");
  const finished = workflowEvidenceRuns(runs);
  if (infra.length > 0) {
    const reasons = new Set(infra.map((r) => r.terminationEvidence).filter((e): e is string => e != null));
    const observed =
      reasons.size === 1
        ? `${infra.length} of your ${runs.length} runs ended the same way — ${[...reasons][0]}.`
        : `${infra.length} of your ${runs.length} runs stopped without finishing, for reasons in the substrate rather than the workflow.`;
    const left = `That leaves ${finished.length} finished run${finished.length === 1 ? "" : "s"} that can tell you anything about the workflow itself.`;
    // The mechanism is a diagnosis, not an observation — say which it is. Runs that
    // share an outcome need not share a cause, and attributing all of them to one
    // bug claims more than the session history supports.
    return `${observed} We've root-caused that to a daemon bug; it isn't your workflow failing. ${left}`;
  }
  const parked = runs.reduce((a, r) => a + r.durations.parkedMs, 0);
  const elapsed = runs.reduce((a, r) => a + r.durations.elapsedMs, 0);
  if (elapsed > 0 && parked / elapsed > 0.5) {
    return `${Math.round((parked / elapsed) * 100)}% of the time across your ${runs.length} runs was Orca waiting on you.`;
  }
  return `${runs.length} run${runs.length === 1 ? "" : "s"}, all shown below.`;
}

// ── the duration decomposition ───────────────────────────────────────────────

function intervalParts(d: RunSummary["durations"]) {
  const { elapsedMs, workingMs, parkedMs, unaccountedMs } = d;
  return { elapsedMs, workingMs, parkedMs, unaccountedMs };
}

function DurationTerms({ d }: { d: RunSummary["durations"] }) {
  return (
    <span style={{ fontSize: 12, color: "var(--text-2)" }} className="mono">
      {dur(d.elapsedMs)} = {dur(d.workingMs)} working + {dur(d.parkedMs)} waiting on you
      {" + "}{dur(d.unaccountedMs)} unaccounted
      {d.accruing ? " · still running" : ""}
    </span>
  );
}

// ── cost ─────────────────────────────────────────────────────────────────────

function CostCell({ cost }: { cost: RunSummary["cost"] }) {
  const { reported, total, silent } = cost.coverage;
  // Absence is never zero. With nothing reported there is no total to render —
  // showing $0.00 with an explanation beneath it is still showing $0.00.
  if (reported === 0) {
    return (
      <div style={{ display: "grid", gap: 4 }}>
        <MeasurementLabel
          state="uninstrumented"
          fix={total === 0 ? "Wire cost capture for this provider." : "No node on this run reported a cost."}
        />
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{usd(cost.usd)}</span>
      {cost.failedUsd > 0 && (
        <span style={{ fontSize: 12, color: "var(--err)" }} className="mono">
          {usd(cost.failedUsd)} on attempts that failed
        </span>
      )}
      {cost.supersededUsd > 0 && (
        <span style={{ fontSize: 12, color: "var(--warn)" }} className="mono">
          {usd(cost.supersededUsd)} on work that was replaced
        </span>
      )}
      <span style={{ fontSize: 12, color: reported === total ? "var(--text-2)" : "var(--warn)" }} className="mono">
        {reported} of {total} nodes reported a cost
      </span>
      {silent > 0 && (
        // These nodes are absent from the ratio above, not counted as unreported —
        // so this total is understated by an amount the run cannot state. Says so
        // rather than letting the figure read as complete.
        <MeasurementLabel
          state="uninstrumented"
          lossy
          fix={`${silent} more node${silent === 1 ? "" : "s"} spent money and reported nothing, so this total is low. Emit step_launch/step_complete on the gate surrogate.`}
        />
      )}
      {cost.rollupCheck === "not_applicable" && (
        <MeasurementLabel
          state="unmeasurable_structural"
          reason="Nothing to check this total against — this run never finished."
        />
      )}
      {cost.rollupCheck === "diverged" && (
        <span style={{ fontSize: 12, color: "var(--err)", fontWeight: 600 }}>
          This total disagrees with the run&apos;s own roll-up — a step&apos;s cost is missing from one of them.
        </span>
      )}
    </div>
  );
}

// ── the launcher ─────────────────────────────────────────────────────────────

export function RunRow({ run, onOpen }: { run: RunSummary; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(run.runId)}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 190px",
        gap: 20,
        alignItems: "start",
        width: "100%",
        textAlign: "left",
        padding: "14px 16px",
        background: "var(--panel)",
        border: "1px solid var(--hairline)",
        borderRadius: 8,
        cursor: "pointer",
        color: "inherit",
      }}
    >
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>{day(run.startedAt)}</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{run.templateName}</span>
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>v{run.templateVersion}</span>
          <span style={{ fontSize: 12, color: TERMINATION_TONE[run.terminationCause], fontWeight: 600 }}>
            {TERMINATION_SENTENCE[run.terminationCause]}
          </span>
        </div>
        {run.terminationEvidence && run.terminationCause !== "completed" && (
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>{run.terminationEvidence}</span>
        )}
        <IntervalBar {...intervalParts(run.durations)} />
        <DurationTerms d={run.durations} />
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--text-2)" }}>
          <span>{run.stepsDelivered} delivered</span>
          {run.stepsBlocked > 0 && <span>{run.stepsBlocked} blocked</span>}
          {run.retriedCompletions > 0 && <span>{run.retriedCompletions} redone</span>}
          {run.spanRelaunches > 0 && <span>{run.spanRelaunches} relaunched after a crash</span>}
          {run.openInterventions > 0 && (
            <span style={{ color: "var(--err)", fontWeight: 600 }}>
              {run.openInterventions} card{run.openInterventions === 1 ? "" : "s"} still open
            </span>
          )}
        </div>
        {run.durations.integrityFlag && (
          <MeasurementLabel
            state="unmeasurable_structural"
            reason="These times don't add up — the split below can't be trusted on this run."
          />
        )}
      </div>
      <CostCell cost={run.cost} />
    </button>
  );
}

// ── the run detail ───────────────────────────────────────────────────────────

const PARK_SENTENCE: Record<Intervention["parkState"], string> = {
  awaiting_you: "waiting on you",
  abandoned: "left open when the run stopped",
  resolved: "resolved",
};

function SpanRow({ span }: { span: RunTraceSpan }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px minmax(0, 1fr) 150px",
        gap: 16,
        alignItems: "start",
        padding: "10px 0",
        borderTop: "1px solid var(--hairline)",
      }}
    >
      <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{span.name}</span>
        <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
          {span.kind === "gate" ? "gate" : "step"} · attempt {span.attempt} · {span.status}
        </span>
      </div>

      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        {/* Parked is deliberately absent here: a park between two spans belongs
            to neither, so the parks section below owns them. */}
        <IntervalBar
          elapsedMs={span.elapsedMs}
          workingMs={span.elapsedMs == null ? null : span.workingMs ?? 0}
          parkedMs={span.elapsedMs == null ? null : 0}
          unaccountedMs={span.elapsedMs == null ? null : Math.max(0, span.elapsedMs - (span.workingMs ?? 0))}
        />
        {span.elapsedMs == null ? (
          <MeasurementLabel
            state="uninstrumented"
            lossy={span.kind === "gate"}
            fix={
              span.kind === "gate"
                ? "This gate spawned a real agent; emit step_launch/step_complete on its surrogate."
                : undefined
            }
          />
        ) : (
          <span className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>
            {dur(span.elapsedMs)}
            {span.workingMs == null
              ? " · none of it observed"
              : ` · ${dur(span.workingMs)} observed, ${dur(Math.max(0, span.elapsedMs - span.workingMs))} unaccounted`}
          </span>
        )}
        {span.kind === "gate" && span.workingMs == null && (
          <MeasurementLabel
            state="uninstrumented"
            lossy
            fix="This gate spawned a real agent; emit step_launch/step_complete on its surrogate."
          />
        )}
        {span.blockedReason && (
          <span style={{ fontSize: 11.5, color: "var(--err)" }}>{span.blockedReason}</span>
        )}
        {span.verifiers && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11.5 }}>
            {span.verifiers.executable && <Chip tone="var(--run)">tests ran</Chip>}
            {span.verifiers.grounding && <Chip tone="var(--run)">claims checked</Chip>}
            {/* An LLM's opinion, carrying real weight into a graded number. Marked
                so it is never mistaken for a deterministic check. */}
            {span.verifiers.independentReview && <Chip tone="var(--warn)">a model reviewed it</Chip>}
            {!span.verifiers.executable && !span.verifiers.grounding && !span.verifiers.independentReview && (
              <Chip tone="var(--text-3)">nothing checked this</Chip>
            )}
          </div>
        )}
        {(span.restarts > 0 || span.completions > 1) && (
          <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>
            {span.restarts > 0 && `relaunched ${span.restarts}x after a crash`}
            {span.restarts > 0 && span.completions > 1 && " · "}
            {span.completions > 1 && `redone ${span.completions - 1}x`}
          </span>
        )}
      </div>

      <div style={{ display: "grid", gap: 2, justifyItems: "end" }}>
        {span.cost === null || span.cost.usd === null ? (
          <MeasurementLabel state="uninstrumented" lossy={span.kind === "gate"} />
        ) : (
          <span className="mono" style={{ fontSize: 13 }}>{usd(span.cost.usd)}</span>
        )}
      </div>
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span style={{ border: `1px solid ${tone}`, color: tone, borderRadius: 4, padding: "1px 6px", fontSize: 11 }}>
      {children}
    </span>
  );
}

function InterventionRow({ iv }: { iv: Intervention }) {
  const urgent = iv.parkState === "awaiting_you";
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "6px 0", fontSize: 12 }}>
      <span className="mono" style={{ minWidth: 64, color: urgent ? "var(--err)" : "var(--text-2)", fontWeight: urgent ? 600 : 400 }}>
        {dur(iv.durationMs)}
      </span>
      <span style={{ color: "var(--text-2)" }}>
        {iv.sourceKind === "unknown" ? "a pause" : iv.sourceKind.replace(/_/g, " ").replace(" pending", "")}
      </span>
      <span style={{ color: urgent ? "var(--err)" : "var(--text-3)" }}>{PARK_SENTENCE[iv.parkState]}</span>
      {iv.sourceKind === "unknown" && (
        <MeasurementLabel state="uninstrumented" lossy fix="Stamp the pause reason into the event." />
      )}
    </div>
  );
}

export function RunDetailPanel({ detail, onBack }: { detail: RunDetail; onBack: () => void }) {
  const { run, spans, interventions } = detail;
  const open = interventions.filter((i) => i.open);
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div>
        <button type="button" onClick={onBack} style={{ fontSize: 12, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0 }}>
          ← All runs
        </button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>
          {run.templateName} <span style={{ color: "var(--text-3)", fontWeight: 400 }}>v{run.templateVersion} · {day(run.startedAt)}</span>
        </h2>
        <span style={{ fontSize: 13, color: TERMINATION_TONE[run.terminationCause], fontWeight: 600 }}>
          {TERMINATION_SENTENCE[run.terminationCause]}
          {run.terminationEvidence ? ` — ${run.terminationEvidence}` : ""}
        </span>
        <IntervalBar {...intervalParts(run.durations)} />
        <DurationTerms d={run.durations} />
      </div>

      {open.length > 0 && (
        <section style={{ display: "grid", gap: 4 }}>
          <h3 style={{ fontSize: 13, margin: 0 }}>Still open</h3>
          {open.map((iv) => <InterventionRow key={iv.activityId} iv={iv} />)}
        </section>
      )}

      <section>
        <h3 style={{ fontSize: 13, margin: "0 0 4px" }}>What ran</h3>
        {spans.map((s) => <SpanRow key={s.workflowStepRunId} span={s} />)}
      </section>

      {interventions.length > 0 && (
        <section>
          <h3 style={{ fontSize: 13, margin: "0 0 4px" }}>Every time it stopped for you</h3>
          {interventions.map((iv) => <InterventionRow key={iv.activityId} iv={iv} />)}
        </section>
      )}
    </div>
  );
}

// ── what we can't tell you yet ───────────────────────────────────────────────

/**
 * One consolidated block, never fifteen greyed panels. Each line names a real gap
 * and the one change that would close it, so an absence is something the reader can
 * act on rather than merely notice.
 */
function CantTellYou({ runs }: { runs: RunSummary[] }) {
  const gateless = runs.length > 0;
  const workflowN = workflowEvidenceRuns(runs).length;
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h3 style={{ fontSize: 13, margin: 0 }}>What this screen can&apos;t tell you yet</h3>
      {workflowN < 5 && (
        <MeasurementLabel
          state="insufficient"
          have={workflowN}
          need={5}
          unit="runs that finished"
        />
      )}
      {gateless && (
        <MeasurementLabel state="uninstrumented" lossy fix="Gate cost and timing: emit step_launch/step_complete on the gate surrogate." />
      )}
      <MeasurementLabel
        state="uninstrumented"
        fix="What happened inside a step: only two hooks are wired, so a pre-approved tool call leaves no trace. Wire the PostToolUse hook."
      />
    </section>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export function RunLedger() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    getRunSummaries().then((r) => { if (live) setRuns(r); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    setDetail(null);
    if (!openRunId) return;
    let live = true;
    getRunDetail(openRunId).then((d) => { if (live) setDetail(d); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [openRunId]);

  if (error) return <p style={{ fontSize: 13, color: "var(--err)" }}>Couldn&apos;t load runs.</p>;
  if (runs === null) return <p style={{ fontSize: 13, color: "var(--text-3)" }}>Loading…</p>;
  if (runs.length === 0) return <p style={{ fontSize: 13, color: "var(--text-3)" }}>No runs yet.</p>;

  if (openRunId) {
    if (detail === null) return <p style={{ fontSize: 13, color: "var(--text-3)" }}>Loading…</p>;
    return <RunDetailPanel detail={detail} onBack={() => setOpenRunId(null)} />;
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <p style={{ fontSize: 14, margin: 0, lineHeight: 1.5 }}>{headline(runs)}</p>
      <div style={{ display: "grid", gap: 10 }}>
        {runs.map((r) => <RunRow key={r.runId} run={r} onOpen={setOpenRunId} />)}
      </div>
      <CantTellYou runs={runs} />
    </div>
  );
}
