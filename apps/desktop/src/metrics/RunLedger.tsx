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
 * Runs that have ENDED. Every aggregate on this screen is computed over these and
 * only these — a live run appears as a row and never inside a statistic.
 *
 * A run in progress is not an observation of a run; it is a partial observation
 * whose value changes every second. Pooling it makes a statistic that moves when
 * nothing happened, which is the same lie as a number computed over a population
 * its label doesn't name. The live case is not hypothetical: a run currently sits
 * at 39.4h elapsed / 39.2h parked and still accruing, and under any pooled figure
 * it would dominate forever and grow.
 *
 * The protection is structural rather than a bound: a forgotten run can never
 * swamp a statistic, not because it was capped but because it was never eligible.
 * Any statistic added later inherits that without its author needing to know.
 */
export function terminatedRuns(runs: RunSummary[]): RunSummary[] {
  return runs.filter((r) => r.terminationCause !== "running");
}

/**
 * One sentence, the most important true fact, computed rather than authored so it
 * stays true as the data changes. The contamination case leads: a run killed by the
 * substrate says nothing about the workflow, and reporting those five together
 * would describe the daemon while naming the workflow.
 */
export function headline(runs: RunSummary[]): string {
  if (runs.length === 0) return "No runs yet.";
  // Every count and ratio below is over ENDED runs; live ones are rows, not data.
  const ended = terminatedRuns(runs);
  const infra = ended.filter((r) => r.terminationCause === "infrastructure_killed");
  const finished = workflowEvidenceRuns(ended);
  if (infra.length > 0) {
    const reasons = new Set(infra.map((r) => r.terminationEvidence).filter((e): e is string => e != null));
    const observed =
      reasons.size === 1
        ? `${infra.length} of your ${ended.length} finished runs ended the same way — ${[...reasons][0]}.`
        : `${infra.length} of your ${ended.length} finished runs stopped without completing, for reasons in the substrate rather than the workflow.`;
    const left = `That leaves ${finished.length} finished run${finished.length === 1 ? "" : "s"} that can tell you anything about the workflow itself.`;
    // The mechanism is a diagnosis, not an observation — say which it is. Runs that
    // share an outcome need not share a cause, and attributing all of them to one
    // bug claims more than the session history supports.
    return `${observed} We've root-caused that to a daemon bug; it isn't your workflow failing. ${left}`;
  }
  const parked = ended.reduce((a, r) => a + r.durations.parkedMs, 0);
  const elapsed = ended.reduce((a, r) => a + r.durations.elapsedMs, 0);
  if (elapsed > 0 && parked / elapsed > 0.5) {
    return `${Math.round((parked / elapsed) * 100)}% of the time across your ${ended.length} finished runs was Orca waiting on you.`;
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
    // Sits directly under the bar and reads as its caption: the bar carries the
    // shape, this carries the arithmetic. They were competing at equal weight, and
    // the sentence won because it was legible while the bar was ambiguous — which
    // meant the bar cost a line and paid nothing. The terms stay visibly addable;
    // that property is what makes the intervention tax falsifiable in front of the
    // reader, and it is load-bearing rather than decorative.
    <span style={{ fontSize: "var(--fs-1)", color: "var(--text-2)", lineHeight: 1.5 }} className="mono">
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
  // The caveats below ride as tags beside the figure rather than as paragraphs
  // beneath it. They are attached, not footnoted — the number cannot be read
  // without them — but each said the same three wrapped lines on every unfinished
  // run, roughly eighteen lines of screen for a sentence that never varied. The
  // sentence each tag stands for is stated once, above the rows, by CostCaveats.
  //
  // This is NOT the $0.00 defect returning. There the figure was unmeasured and the
  // absence was demoted to a caption; here the figure IS measured and the tag
  // qualifies the cross-check. The test that separates them: which object is the
  // absence attached to? An unreported total still replaces the figure entirely,
  // in the branch above.
  return (
    <div style={{ display: "grid", gap: "var(--sp-1)", justifyItems: "end", textAlign: "right" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)" }}>
        <span className="mono" style={{ fontSize: "var(--fs-5)", fontWeight: 600, letterSpacing: -0.4 }}>{usd(cost.usd)}</span>
        {cost.rollupCheck === "not_applicable" && (
          <MeasurementLabel
            compact
            state="unmeasurable_structural"
            reason="Nothing to check this total against — this run never finished."
          />
        )}
      </div>
      {cost.failedUsd > 0 && (
        <span style={{ fontSize: "var(--fs-1)", color: "var(--err)" }} className="mono">
          {usd(cost.failedUsd)} failed
        </span>
      )}
      {cost.supersededUsd > 0 && (
        <span style={{ fontSize: "var(--fs-1)", color: "var(--warn)" }} className="mono">
          {usd(cost.supersededUsd)} replaced
        </span>
      )}
      {/* Wraps rather than compressing: with the tag pinned beside it the sentence
          broke as "reported a / cost", which reads as two facts. Given the choice
          between a wrapped tag and a wrapped phrase, break the tag. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-1)", flexWrap: "wrap", justifyContent: "flex-end" }}>
        <span style={{ fontSize: "var(--fs-1)", color: reported === total ? "var(--text-3)" : "var(--warn)", whiteSpace: "nowrap" }} className="mono">
          {reported} of {total} nodes reported a cost
        </span>
        {silent > 0 && (
          // Absent from the ratio beside it, not counted as unreported — so this
          // total is understated by an amount the run itself cannot state.
          <MeasurementLabel
            compact
            state="uninstrumented"
            lossy
            fix={`${silent} more node${silent === 1 ? "" : "s"} spent money and reported nothing, so this total is low. Emit step_launch/step_complete on the gate surrogate.`}
          />
        )}
      </div>
      {cost.rollupCheck === "diverged" && (
        // Never compacted: this one differs per run and is a defect rather than a
        // standing limit. A tag would hide the only cost caveat worth reading.
        <span style={{ fontSize: "var(--fs-2)", color: "var(--err)", fontWeight: 600 }}>
          This total disagrees with the run&apos;s own roll-up — a step&apos;s cost is missing from one of them.
        </span>
      )}
    </div>
  );
}

/**
 * The sentences the cost tags stand for, stated once, ABOVE the rows.
 *
 * Above rather than below because a caveat read after the data is a footnote, and
 * footnotes are where urgency goes to die. Each names its own count, since scale is
 * the urgency and a tag repeated six times conveys scale only to a reader who counts
 * tags. The `fix` stays at full size here — it is the entire actionable content, and
 * compacting it into six tooltips would leave the reader with an absence they can
 * notice and not resolve.
 */
export function CostCaveats({ runs }: { runs: RunSummary[] }) {
  const silentNodes = runs.reduce((a, r) => a + r.cost.coverage.silent, 0);
  const unchecked = runs.filter((r) => r.cost.rollupCheck === "not_applicable").length;
  if (silentNodes === 0 && unchecked === 0) return null;
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      {silentNodes > 0 && (
        <MeasurementLabel
          state="uninstrumented"
          lossy
          // The count rides in `fix`, not `reason`: labelForMeasurementState honours
          // `reason` only for unmeasurable_structural, so a count passed there would
          // have rendered nothing at all. It belongs beside the action regardless —
          // scale is what makes the fix worth doing.
          fix={`${silentNodes} node${silentNodes === 1 ? "" : "s"} across these runs spent money and reported nothing, so those totals are low. Emit step_launch/step_complete on the gate surrogate.`}
        />
      )}
      {unchecked > 0 && (
        <MeasurementLabel
          state="unmeasurable_structural"
          reason={`${unchecked} of these runs never finished, so their cost totals have nothing to check against.`}
        />
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
        // Widened from 190px so product's wording fits on its own line rather than
        // being shortened to fit the column. The space came from compacting the
        // repeating caveats, which is what it was for.
        gridTemplateColumns: "minmax(0, 1fr) 232px",
        gap: "var(--sp-5)",
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
      <div style={{ display: "grid", gap: "var(--sp-2)", minWidth: 0 }}>
        {/* Identity first and alone. Previously the name shared a baseline with the
            date, the version and the outcome sentence at near-equal weight, so the
            row opened with four competing entry points and the reader had none. */}
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--fs-4)", fontWeight: 600 }}>{run.templateName}</span>
          <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
            v{run.templateVersion} · {day(run.startedAt)}
          </span>
        </div>
        {/* The outcome, with its evidence on the same line rather than orphaned on
            the next one — the classification and the signal it was drawn from are one
            statement, and splitting them let the label travel without its evidence.
            The rule carries the tone so the sentence itself doesn't have to shout. */}
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "stretch" }}>
          <span style={{ width: 3, borderRadius: 2, background: TERMINATION_TONE[run.terminationCause], flexShrink: 0 }} />
          <span style={{ fontSize: "var(--fs-3)", color: "var(--text)" }}>
            {TERMINATION_SENTENCE[run.terminationCause]}
            {run.terminationEvidence && run.terminationCause !== "completed" && (
              <span style={{ color: "var(--text-3)" }}> — {run.terminationEvidence}</span>
            )}
          </span>
        </div>
        <IntervalBar {...intervalParts(run.durations)} />
        <DurationTerms d={run.durations} />
        <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap", fontSize: "var(--fs-2)", color: "var(--text-3)" }}>
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
        <span style={{ fontSize: "var(--fs-3)", fontWeight: 600 }}>{span.name}</span>
        <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>
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
          <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--text-2)" }}>
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
          <span style={{ fontSize: "var(--fs-2)", color: "var(--err)" }}>{span.blockedReason}</span>
        )}
        {span.verifiers && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: "var(--fs-2)" }}>
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
          <span style={{ fontSize: "var(--fs-2)", color: "var(--text-2)" }}>
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
          <span className="mono" style={{ fontSize: "var(--fs-3)" }}>{usd(span.cost.usd)}</span>
        )}
      </div>
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span style={{ border: `1px solid ${tone}`, color: tone, borderRadius: 4, padding: "1px 6px", fontSize: "var(--fs-1)" }}>
      {children}
    </span>
  );
}

function InterventionRow({ iv }: { iv: Intervention }) {
  // Amber marks only what the reader can act on RIGHT NOW: an open park on a live
  // run. `abandoned` is open on a dead run — nothing they do helps — so styling it
  // as actionable would send them to answer cards that accomplish nothing. The
  // distinction is decided server-side and must never be re-derived here from run
  // status plus an open flag.
  const actionable = iv.parkState === "awaiting_you";
  return (
    <div style={{ display: "flex", gap: "var(--sp-3)", alignItems: "baseline", padding: "var(--sp-1) 0", fontSize: "var(--fs-2)" }}>
      <span className="mono" style={{ minWidth: 64, color: actionable ? "var(--warn)" : "var(--text-2)", fontWeight: actionable ? 600 : 400 }}>
        {dur(iv.durationMs)}
      </span>
      {/* The tag REPLACES the reason rather than sitting beside it. "a pause" was a
          placeholder standing in for the missing reason, so rendering it next to a
          marker of that same absence stated the gap twice and left a red box on every
          row — the compaction turning back into wallpaper, one size down. The absent
          thing here is the reason, so the reason slot is where its type belongs.
          Duration and park state are measured and keep their own cells. */}
      {iv.sourceKind === "unknown" ? (
        <MeasurementLabel compact state="uninstrumented" lossy fix="Stamp the pause reason into the event." />
      ) : (
        <span style={{ color: "var(--text-2)" }}>
          {iv.sourceKind.replace(/_/g, " ").replace(" pending", "")}
        </span>
      )}
      <span style={{ color: actionable ? "var(--warn)" : "var(--text-3)" }}>{PARK_SENTENCE[iv.parkState]}</span>
    </div>
  );
}

/** The sentence the `discarded` pause tags stand for, once, above the rows it marks. */
function ParkCaveat({ interventions }: { interventions: Intervention[] }) {
  const unlabelled = interventions.filter((i) => i.sourceKind === "unknown").length;
  if (unlabelled === 0) return null;
  return (
    <MeasurementLabel
      state="uninstrumented"
      lossy
      fix={`${unlabelled} of these pauses lost the record of why they stopped. Stamp the pause reason into the event.`}
    />
  );
}

export function RunDetailPanel({ detail, onBack }: { detail: RunDetail; onBack: () => void }) {
  const { run, spans, interventions } = detail;
  const actionable = interventions.filter((i) => i.parkState === "awaiting_you");
  return (
    <div style={{ display: "grid", gap: "var(--sp-5)" }}>
      <div>
        <button type="button" onClick={onBack} style={{ fontSize: "var(--fs-2)", background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0 }}>
          ← All runs
        </button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <h2 style={{ fontSize: "var(--fs-5)", margin: 0 }}>
          {run.templateName} <span style={{ color: "var(--text-3)", fontWeight: 400 }}>v{run.templateVersion} · {day(run.startedAt)}</span>
        </h2>
        <span style={{ fontSize: "var(--fs-3)", color: TERMINATION_TONE[run.terminationCause], fontWeight: 600 }}>
          {TERMINATION_SENTENCE[run.terminationCause]}
          {run.terminationEvidence ? ` — ${run.terminationEvidence}` : ""}
        </span>
        <IntervalBar {...intervalParts(run.durations)} />
        <DurationTerms d={run.durations} />
      </div>

      {/* Sectioned by ACTIONABILITY, not by an `open` flag. The previous heading
          said "Still open" over three rows each reading "left open when the run
          stopped" — a contradiction in one glance — and those same rows appeared
          again below, so the screen both misdescribed them and counted them twice.
          Nothing here is `awaiting_you` on the founder's data today, so this section
          is absent rather than empty: a heading over no rows teaches the reader that
          headings mean nothing. */}
      {actionable.length > 0 && (
        <section style={{ display: "grid", gap: "var(--sp-1)" }}>
          <h3 style={{ fontSize: "var(--fs-4)", margin: 0 }}>Waiting on you now</h3>
          <ParkCaveat interventions={actionable} />
          {actionable.map((iv) => <InterventionRow key={iv.activityId} iv={iv} />)}
        </section>
      )}

      <section style={{ display: "grid", gap: "var(--sp-1)" }}>
        <h3 style={{ fontSize: "var(--fs-4)", margin: 0 }}>What ran</h3>
        {spans.map((s) => <SpanRow key={s.workflowStepRunId} span={s} />)}
      </section>

      {interventions.length > 0 && (
        <section style={{ display: "grid", gap: "var(--sp-1)" }}>
          <h3 style={{ fontSize: "var(--fs-4)", margin: 0 }}>Every time it stopped for you</h3>
          <ParkCaveat interventions={interventions} />
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
  const workflowN = workflowEvidenceRuns(terminatedRuns(runs)).length;
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h3 style={{ fontSize: "var(--fs-3)", margin: 0 }}>What this screen can&apos;t tell you yet</h3>
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

/** A failed fetch, said in place, with the one control that can undo it. */
function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)" }}>
      <span style={{ fontSize: "var(--fs-3)", color: "var(--err)" }}>Couldn&apos;t load {what}.</span>
      <button
        type="button"
        onClick={onRetry}
        style={{ fontSize: "var(--fs-2)", background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0 }}
      >
        Try again
      </button>
    </div>
  );
}

export function RunLedger() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  // Two fetches, two failure states. One shared flag meant a failed DETAIL fetch
  // destroyed the LIST the reader was already looking at, replacing every loaded
  // row with a dead-end sentence. Not an edge case here: any agent saving a file
  // restarts the daemon, so a transient 500 mid-session is routine.
  const [listError, setListError] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setListError(false);
    getRunSummaries().then((r) => { if (live) setRuns(r); }).catch(() => { if (live) setListError(true); });
    return () => { live = false; };
  }, [reload]);

  useEffect(() => {
    setDetail(null);
    setDetailError(false);
    if (!openRunId) return;
    let live = true;
    getRunDetail(openRunId).then((d) => { if (live) setDetail(d); }).catch(() => { if (live) setDetailError(true); });
    return () => { live = false; };
  }, [openRunId, reload]);

  if (listError && runs === null) return <LoadError what="runs" onRetry={() => setReload((n) => n + 1)} />;
  if (runs === null) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>Loading…</p>;
  if (runs.length === 0) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>No runs yet.</p>;

  if (openRunId) {
    if (detailError) {
      return (
        <div style={{ display: "grid", gap: "var(--sp-3)" }}>
          <button type="button" onClick={() => setOpenRunId(null)} style={{ fontSize: "var(--fs-2)", background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, justifySelf: "start" }}>
            ← All runs
          </button>
          <LoadError what="this run" onRetry={() => setReload((n) => n + 1)} />
        </div>
      );
    }
    if (detail === null) return <p style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>Loading…</p>;
    return <RunDetailPanel detail={detail} onBack={() => setOpenRunId(null)} />;
  }

  return (
    <div style={{ display: "grid", gap: "var(--sp-5)" }}>
      {/* The headline is the one sentence that leads the screen, so it takes the
          display step rather than sitting one notch above body text. */}
      <p style={{ fontSize: "var(--fs-4)", margin: 0, lineHeight: 1.5, maxWidth: "78ch" }}>{headline(runs)}</p>
      <CostCaveats runs={runs} />
      <div style={{ display: "grid", gap: "var(--sp-2)" }}>
        {runs.map((r) => <RunRow key={r.runId} run={r} onOpen={setOpenRunId} />)}
      </div>
      <CantTellYou runs={runs} />
    </div>
  );
}
