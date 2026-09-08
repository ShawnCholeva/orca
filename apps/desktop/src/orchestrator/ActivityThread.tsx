import { useEffect, useRef, useState } from "react";
import type { Activity } from "@orca/contracts";
import type { ComponentType, ReactNode } from "react";
import { openArtifact } from "../api";

type ProviderRecoveryProps = {
  runId: string;
  recovery: NonNullable<Activity["providerRecovery"]>;
};

export function isMeaningfulCompleted(activity: Activity): boolean {
  return (
    activity.status === "completed" &&
    activity.finalSummary !== null &&
    activity.finalSummary.trim().length > 0 &&
    activity.sourceKind !== "weak_signal"
  );
}

// A turn-level agent activity that owns a persisted card (it has accumulated
// steps or a meaningful summary). step_result keeps its dedicated card.
export function isAgentActivityCard(activity: Activity): boolean {
  return (
    activity.sourceKind !== "step_result" &&
    activity.sourceKind !== "step_confirmation_pending" &&
    activity.sourceKind !== "provider_recovery_pending" &&
    activity.sourceKind !== "gate_decision_pending" &&
    // The orchestrator's own raw judge-turn reasoning is persisted as an
    // auditable trajectory, but it leaks first-person voice and internal
    // mechanics (and pre-empts the step-complete card's "complete" claim), so
    // it is never surfaced as a chat card — mirrors the reasoning_note rule.
    activity.sourceKind !== "orchestrator_reasoning" &&
    (activity.steps.length > 0 || isMeaningfulCompleted(activity))
  );
}

// An activity that earns a permanent, time-ordered slot in the chat timeline:
// a terminal step-result card or an agent activity card with persisted steps.
export function isTimelineCard(activity: Activity): boolean {
  return activity.sourceKind === "step_result" || isAgentActivityCard(activity);
}

// The latest still-running activity awaiting a pause interaction (confirmation,
// provider recovery, or a pending question). Active tool_use turns are now
// rendered as persisted AgentActivity cards in the timeline, so they are
// excluded here to avoid a duplicate ephemeral tail bubble.
export function pickLiveActivity(activities: Activity[]): Activity | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (
      activity?.status === "paused_for_input" &&
      (activity.sourceKind === "step_confirmation_pending" ||
        activity.sourceKind === "gate_decision_pending" ||
        activity.sourceKind === "provider_recovery_pending")
    ) {
      return activity;
    }
  }
  return null;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

// A verdict label for the refute advisory chip (5.4 L4 advisory). "unavailable"
// (the refute call itself failed) is a defensive case — the engine still
// escalates to a human pause for it, so the card should not stay silent.
const REFUTE_VERDICT_LABEL: Record<string, string> = {
  upheld: "A second AI reviewed it and agreed",
  refuted: "Independent review disputes this",
  uncertain: "Independent review was inconclusive",
  unavailable: "No independent review ran",
};

// The "nothing was run" clause used to be baked into the `upheld` label, so a step
// whose tests actually ran and passed was told that nothing had been — undercutting
// real execution evidence with the runner's own output printed two rows above.
// `evidence.executed` is the daemon's answer to exactly this question; use it.
function upheldReviewLine(executed: boolean): string {
  return executed
    ? `${REFUTE_VERDICT_LABEL.upheld}; the checks also ran and passed`
    : `${REFUTE_VERDICT_LABEL.upheld} — but nothing was run or tested`;
}

function ConfirmFieldList({
  fields,
}: {
  fields: NonNullable<Activity["confirmationSummary"]>["fields"];
}) {
  return (
    <dl className="step-confirm-fields">
      {fields.map((f, i) => (
        <div key={i} className="step-confirm-field">
          <dt>{f.label}</dt>
          <dd>
            {Array.isArray(f.value) ? (
              <ul>{f.value.map((v, j) => <li key={j}>{v}</li>)}</ul>
            ) : (
              f.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// The synthesized frame body (lead + fields) shared by the live confirmation
// card and the persisted step-result card.
export function ConfirmationFrame({
  summary,
}: {
  summary: NonNullable<Activity["confirmationSummary"]>;
}) {
  const refute = summary.refute;
  const showRefute = !!refute && refute.verdict !== "upheld";
  return (
    <>
      <div className="step-confirm-lead">{summary.lead}</div>
      {showRefute && refute ? (
        <div
          className="step-confirm-refute"
          data-testid="step-confirm-refute"
          data-verdict={refute.verdict}
        >
          <span className="step-confirm-refute-chip">
            {REFUTE_VERDICT_LABEL[refute.verdict] ?? "Independent review flagged this"}
          </span>
          {refute.reason ? <p className="step-confirm-refute-reason">{refute.reason}</p> : null}
          {refute.issueRefs.length > 0 ? (
            <ul className="step-confirm-refute-issues">
              {refute.issueRefs.map((ref, i) => (
                <li key={i}>{ref}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {summary.fields.length > 0 ? <ConfirmFieldList fields={summary.fields} /> : null}
      {/* Fields the schema marks `display: "agent"` — handoff payload for the
          next step, not review material for the human. Folded, never dropped;
          the count makes it evident nothing was lost. */}
      {summary.details && summary.details.length > 0 ? (
        <details className="step-confirm-brief" data-testid="step-confirm-brief">
          <summary className="step-confirm-brief-summary">
            <span>Brief for the next step ({summary.details.length})</span>
          </summary>
          <ConfirmFieldList fields={summary.details} />
        </details>
      ) : null}
    </>
  );
}

type ScoreMetrics = {
  successScore: number;
  quality: {
    outputCompleteness: number;
    outputCorrectness: number;
    instructionAdherence: number;
    downstreamReadiness: number;
    riskLevel: number;
  };
  handoffReady: boolean;
};

function ScoresCaret() {
  return (
    <svg
      className="step-confirm-scores-caret"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// Shared card for both the live confirmation checkpoint (Continue / Revise) and
// the persisted result after a selection (✓ You chose Continue). Identical frame
// + scores layout; only the `action` row differs between the two callers.
export function ConfirmationCard({
  summary,
  scores,
  action,
  scoresTestid,
  fallbackText,
  stepName,
  testid = "activity-bubble",
}: {
  summary: NonNullable<Activity["confirmationSummary"]> | null;
  scores: ScoreMetrics | null;
  action: ReactNode;
  scoresTestid: string;
  fallbackText?: string;
  stepName?: string;
  testid?: string;
}) {
  const [scoresOpen, setScoresOpen] = useState(false);
  const metricsRef = useRef<HTMLDListElement>(null);
  // When the scores expand, bring the newly-revealed metrics into view so they
  // aren't left below the fold under the action row.
  useEffect(() => {
    if (scoresOpen) metricsRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [scoresOpen]);
  return (
    <div className="activity-bubble" data-testid={testid}>
      {stepName ? (
        <div className="step-confirm-head" data-testid="step-confirm-step-name">{stepName}</div>
      ) : null}
      {summary ? (
        <ConfirmationFrame summary={summary} />
      ) : fallbackText ? (
        <div className="activity-bubble-text">{fallbackText}</div>
      ) : null}
      <div className="step-confirm" data-testid="step-confirm">
        <div className="step-confirm-actions">
          {action}
          {scores || summary?.evidence ? (
            <button
              type="button"
              data-testid={scoresTestid}
              className="step-confirm-scores-toggle"
              aria-expanded={scoresOpen}
              onClick={() => setScoresOpen((o) => !o)}
            >
              <span>{summary?.evidence ? "Evidence" : "Scores"}</span>
              <ScoresCaret />
            </button>
          ) : null}
        </div>
        {scoresOpen ? (
          <div className="step-confirm-evidence" data-testid="step-confirm-evidence">
            {/* Checks run — the deterministic evidence tier (paper p.62). Execution
                checks are the trust anchor; structural/grounding are weaker and
                muted. A reasoning step with no sensor carries a scope line. */}
            {summary?.evidence ? (
              <div className="step-confirm-ev-group">
                <div className="step-confirm-ev-label">Checks run</div>
                {summary.evidence.checks.length > 0 ? (
                  <ul className="step-confirm-ev-checks" data-testid="step-confirm-ev-checks">
                    {summary.evidence.checks.map((c, i) => (
                      <li key={i} className="step-confirm-ev-check" data-kind={c.kind} data-status={c.status}>
                        <span className="step-confirm-ev-mark" aria-hidden="true">
                          {c.status === "failed" ? "✗" : c.status === "warn" ? "!" : "✓"}
                        </span>
                        <span className="step-confirm-ev-name">{c.name}</span>
                        {c.detail ? <span className="step-confirm-ev-detail">{c.detail}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!summary.evidence.executed ? (
                  <div className="step-confirm-ev-scope" data-testid="step-confirm-ev-noexec">
                    No executable checks — this step produces reasoning, not code.
                  </div>
                ) : null}
              </div>
            ) : null}
            {summary?.evidence && summary.evidence.cantVerify.length > 0 ? (
              <div className="step-confirm-ev-group" data-testid="step-confirm-ev-cantverify">
                <div className="step-confirm-ev-label">Can’t verify</div>
                <ul className="step-confirm-ev-gaps">
                  {summary.evidence.cantVerify.map((g, i) => <li key={i}>{g}</li>)}
                </ul>
              </div>
            ) : null}
            {/* Independent review — only for "upheld". Non-upheld verdicts are
                already surfaced by the prominent lead chip (ConfirmationFrame);
                restating them here would double up. */}
            {summary?.refute && summary.refute.verdict === "upheld" ? (
              <div className="step-confirm-ev-group" data-testid="step-confirm-independent">
                <div className="step-confirm-ev-label">Independent check</div>
                <div className="step-confirm-ev-review">
                  {upheldReviewLine(summary.evidence?.executed ?? false)}
                </div>
              </div>
            ) : null}
            {/* Model self-scores — demoted behind a disclosure and labeled "not
                measured" so they're never the primary signal (paper p.62). */}
            {scores ? (
              <details className="step-confirm-selfassess">
                <summary className="step-confirm-selfassess-summary">
                  <span>Model self-assessment</span>
                  <span className="step-confirm-scores-tag">its own claim — not proof</span>
                </summary>
                <dl ref={metricsRef} className="step-result-metrics step-confirm-metrics">
                  <div><dt>Self-reported success</dt><dd>{pct(scores.successScore)}</dd></div>
                  <div><dt>Complete</dt><dd>{pct(scores.quality.outputCompleteness)}</dd></div>
                  <div><dt>Correct</dt><dd>{pct(scores.quality.outputCorrectness)}</dd></div>
                  <div><dt>Followed instructions</dt><dd>{pct(scores.quality.instructionAdherence)}</dd></div>
                  <div><dt>Downstream readiness</dt><dd>{pct(scores.quality.downstreamReadiness)}</dd></div>
                  <div><dt>Risk level (higher = riskier)</dt><dd>{pct(scores.quality.riskLevel)}</dd></div>
                  <div><dt>Handoff</dt><dd>{scores.handoffReady ? "Ready" : "Not ready"}</dd></div>
                </dl>
                <div className="step-confirm-ev-footer">
                  The AI <b>claimed</b> this step complete. See the Metrics tab for how it trends and how strongly it's verified.
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What to lead an unscored step-result card with.
 *
 * The card used to print the literal string "Evaluation failed" and hide
 * `outcome.reason` behind a caret labelled "Scores" — over a self-assessment that
 * is all zeros for exactly these results, because nothing scored them. So a step
 * the daemon stopped after three restarts announced itself with the least
 * informative field on the record while the useful one ("no progress after 3
 * restarts") sat two clicks away under a misleading label.
 *
 * `stepStatus` already says which of these happened; say that, and put the reason
 * on the face of the card.
 */
const UNSCORED_HEADLINE: Record<string, string> = {
  blocked: "Orca stopped this step before it finished.",
  failed: "This step failed before it produced a result.",
  cancelled: "This step was cancelled.",
  completed: "This step finished, but Orca couldn't check the result.",
};

/**
 * `outcome.reason` is prefixed by the builder that wrote it
 * (`buildEvaluationFailedStepResult`). The prefix restates the card's own state
 * and reads as internals; the clause after it is the actual cause.
 */
function unscoredReason(reason: string): string {
  const stripped = reason.replace(/^step result evaluation failed:\s*/i, "").trim();
  if (stripped.length === 0) return reason;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function StepResultCard({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const r = activity.stepResult;
  if (!r) return null;
  const scored = r.evaluationStatus === "scored";
  const headline =
    r.resultSummary ??
    (scored
      ? r.outcome.reason
      : UNSCORED_HEADLINE[r.stepStatus] ?? "Orca couldn't check this step's result.");
  // Scored: the reason IS the headline, so the drawer repeats it only when a
  // summary displaced it. Unscored: the reason is now on the card's face.
  const reasonInDrawer = scored && r.resultSummary != null;
  const frame = activity.confirmationSummary;
  // A step confirmed via the supervised checkpoint persists with its frame. Render
  // it identically to the live confirmation card (same ConfirmationCard), only
  // swapping the Continue / Revise actions for "✓ You chose Continue".
  if (frame) {
    return (
      <ConfirmationCard
        summary={frame}
        stepName={activity.stepName}
        scores={
          scored
            ? { successScore: r.successScore, quality: r.quality, handoffReady: r.outcome.handoffReady }
            : null
        }
        scoresTestid="step-result-expand"
        action={
          <span className="step-result-confirmed" data-testid="step-result-confirmed">
            ✓ You chose Continue
          </span>
        }
      />
    );
  }
  return (
    <div className="step-result-card" data-testid="step-result-card" data-status={r.stepStatus} data-eval={r.evaluationStatus}>
      <div className="step-result-head">
        <span className="step-result-name">{activity.stepName ?? "Step"}</span>
      </div>
      <div className="step-result-summary" data-testid="step-result-summary">{headline}</div>
      {!scored ? (
        <div className="step-result-cause" data-testid="step-result-cause">
          {unscoredReason(r.outcome.reason)}
        </div>
      ) : null}
      {r.primaryArtifact ? (
        <button
          type="button"
          className="step-result-artifact"
          data-testid="step-result-artifact"
          onClick={() => { void openArtifact(r.primaryArtifact!.reference); }}
        >
          {r.primaryArtifact.description || "Artifact"}: {r.primaryArtifact.reference}
        </button>
      ) : null}
      <div className="step-result-footer">
        <span />
        <button
          type="button"
          data-testid="step-result-expand"
          className="step-confirm-scores-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {/* Nothing scored an unscored result, so its all-zero quality block is
              not a score — offering it as one invites the reader to read 0% as a
              judgement about the work. */}
          <span>{scored ? "Scores" : "Details"}</span>
          <svg
            className="step-confirm-scores-caret"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      {open ? (
        <div className="step-result-details">
          <div className="step-result-state">
            {r.stepStatus}{scored ? ` · ${pct(r.successScore)} · ${r.outcome.handoffReady ? "Ready for handoff" : "Not ready"}` : " · never scored"}
          </div>
          {reasonInDrawer ? <div className="step-result-reason">{r.outcome.reason}</div> : null}
          <div className="step-result-counts">
            {r.outcome.producedArtifactsCount} artifacts · {r.outcome.blockingIssuesCount} blockers · {r.outcome.warningsCount} warnings
          </div>
          <dl className="step-result-metrics">
            {scored ? (
              <>
                <div className="step-confirm-scores-head">
                  <span className="step-confirm-scores-title">How this step scored itself</span>
                  <span className="step-confirm-scores-tag">its own claim — not proof</span>
                </div>
                <div><dt>Complete</dt><dd>{pct(r.quality.outputCompleteness)}</dd></div>
                <div><dt>Correct</dt><dd>{pct(r.quality.outputCorrectness)}</dd></div>
                <div><dt>Followed instructions</dt><dd>{pct(r.quality.instructionAdherence)}</dd></div>
                <div><dt>Downstream readiness</dt><dd>{pct(r.quality.downstreamReadiness)}</dd></div>
                <div><dt>Risk level (higher = riskier)</dt><dd>{pct(r.quality.riskLevel)}</dd></div>
              </>
            ) : null}
            <div><dt>Duration</dt><dd>{r.performance.durationSeconds}s</dd></div>
            <div><dt>Retries</dt><dd>{r.performance.retries}</dd></div>
            {r.performance.totalTurns !== undefined ? <div><dt>Total turns</dt><dd>{r.performance.totalTurns}</dd></div> : null}
            {r.performance.toolCalls !== undefined ? <div><dt>Tool calls</dt><dd>{r.performance.toolCalls}</dd></div> : null}
          </dl>
          {scored ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-3)" }}>
              The AI <b>claimed</b> this step complete. See the Metrics tab for how it trends and how strongly it's verified.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// One terminal entry in the timeline: a scored result card or a plain summary.
export function ActivityCard({ activity }: { activity: Activity }) {
  if (activity.sourceKind === "step_result") {
    return <StepResultCard activity={activity} />;
  }
  if (activity.sourceKind === "gate_decision") {
    return (
      <div className="gate-decision-card" data-testid="gate-decision-card">
        ✓ {activity.finalSummary}
      </div>
    );
  }
  return (
    <div className="activity-summary" data-testid="activity-summary">
      {activity.finalSummary}
    </div>
  );
}

// The live "working" bubble for the active step's agent, pinned to the tail of
// the timeline. Handles confirmation checkpoints and provider recovery.
export function LiveActivity({
  activity,
  renderProviderRecovery: ProviderRecovery,
  onContinue,
  onRevise,
  onGateDecide,
  gateDeciding = false,
  gateReview = null,
}: {
  activity: Activity;
  renderProviderRecovery?: ComponentType<ProviderRecoveryProps>;
  onContinue?: (runId: string) => void;
  onRevise?: (runId: string) => void;
  onGateDecide?: (runId: string, outcome: "approved" | "rejected") => void;
  gateDeciding?: boolean;
  // A gate reviewer's verdict, surfaced as a structured evidence bundle on the card.
  gateReview?: {
    recommendedOutcome: "approved" | "rejected";
    reasoning: string | null;
    // reason: one-line rationale carried for the persisted gate record; the card shows the fuller `reasoning` instead.
    reason: string | null;
    residualRisks: { risk: string; severity: "low" | "medium" | "high" }[];
    inputsConsidered: string[];
    issueRefs: string[];
  } | null;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const isConfirmation =
    activity.status === "paused_for_input" &&
    activity.sourceKind === "step_confirmation_pending";
  const isGateDecision =
    activity.status === "paused_for_input" && activity.sourceKind === "gate_decision_pending";
  const isProviderRecovery =
    activity.status === "paused_for_input" &&
    activity.sourceKind === "provider_recovery_pending" &&
    activity.providerRecovery != null;

  // The live checkpoint shares its card with the persisted result (ConfirmationCard);
  // here the action row offers Continue / Revise.
  if (isConfirmation) {
    const scoring = activity.confirmationSummary?.scoring ?? null;
    return (
      <ConfirmationCard
        summary={activity.confirmationSummary ?? null}
        stepName={activity.stepName}
        scores={
          scoring
            ? { successScore: scoring.successScore, quality: scoring.quality, handoffReady: scoring.handoffReady }
            : null
        }
        scoresTestid="confirm-scores-toggle"
        fallbackText={activity.currentText}
        action={
          <>
            <button
              type="button"
              data-testid="step-confirm-continue"
              className="step-confirm-continue-btn"
              onClick={() => onContinue?.(activity.workflowRunId)}
            >
              Continue
            </button>
            <button
              type="button"
              data-testid="step-confirm-revise"
              className="step-confirm-revise-btn"
              onClick={() => onRevise?.(activity.workflowRunId)}
            >
              Revise
            </button>
          </>
        }
      />
    );
  }

  return (
    <div
      className={`activity-bubble${isGateDecision ? " activity-bubble--gate" : ""}`}
      data-testid="activity-bubble"
      data-status={activity.status}
    >
      <div className={isGateDecision ? "step-confirm-head" : "activity-bubble-text"}>
        {activity.currentText}
      </div>
      {isGateDecision ? (
        <div className="step-confirm" data-testid="gate-decision">
          {gateReview ? (
            <div className="gate-review" data-testid="gate-review">
              <div className="gate-review-verdict" data-testid="gate-review-verdict">
                Critic recommends{" "}
                <strong>{gateReview.recommendedOutcome === "rejected" ? "back to Proposal" : "approve"}</strong>
              </div>
              {gateReview.reasoning ? (
                <div className="gate-review-reasoning" data-testid="gate-review-reasoning">
                  {gateReview.reasoning}
                </div>
              ) : null}
              {gateReview.residualRisks.length > 0 ? (
                <div className="gate-review-group">
                  <div className="gate-review-group-label">Residual risks</div>
                  <ul className="gate-review-risks" data-testid="gate-review-risks">
                    {gateReview.residualRisks.map((r, i) => (
                      <li key={`${r.risk}-${i}`} className="gate-review-risk" data-severity={r.severity}>
                        <span className="gate-review-risk-sev" aria-hidden="true">{r.severity}</span>
                        <span className="gate-review-risk-text">{r.risk}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {gateReview.issueRefs.length > 0 ? (
                <ul className="gate-review-issues" data-testid="gate-review-issues">
                  {gateReview.issueRefs.map((ref, i) => (
                    <li key={`${ref}-${i}`}>{ref}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <div className="gate-review-unavailable" data-testid="gate-review-unavailable">
              No automated review ran — approve or reject on your own judgment.
            </div>
          )}
          <div className="step-confirm-actions">
            <button
              type="button"
              data-testid="gate-decision-approve"
              className="step-confirm-continue-btn"
              disabled={gateDeciding}
              onClick={() => onGateDecide?.(activity.workflowRunId, "approved")}
            >
              Approve
            </button>
            <button
              type="button"
              data-testid="gate-decision-reject"
              className="step-confirm-revise-btn"
              disabled={gateDeciding}
              onClick={() => onGateDecide?.(activity.workflowRunId, "rejected")}
            >
              Reject
            </button>
            {gateReview && gateReview.inputsConsidered.length > 0 ? (
              <button
                type="button"
                data-testid="gate-review-evidence-toggle"
                className="step-confirm-scores-toggle"
                aria-expanded={evidenceOpen}
                onClick={() => setEvidenceOpen((o) => !o)}
              >
                <span>Evidence reviewed</span>
                <ScoresCaret />
              </button>
            ) : null}
          </div>
          {evidenceOpen && gateReview && gateReview.inputsConsidered.length > 0 ? (
            <div className="step-confirm-evidence" data-testid="gate-review-evidence">
              <div className="gate-review-group">
                <div className="gate-review-group-label">Evidence reviewed</div>
                <ul className="gate-review-evidence-list">
                  {gateReview.inputsConsidered.map((ev, i) => (
                    <li key={`${ev}-${i}`}>{ev}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {isProviderRecovery && ProviderRecovery && activity.providerRecovery ? (
        <ProviderRecovery runId={activity.workflowRunId} recovery={activity.providerRecovery} />
      ) : null}
    </div>
  );
}
