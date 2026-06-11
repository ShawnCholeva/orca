# Step Result Scoring and Activity Visibility

**Date:** 2026-06-08 (open questions resolved 2026-06-09)
**Status:** Design approved — no open questions; ready for implementation planning
**Source PRD:** `docs/prds/step-result-scoring-and-chat-visibility.md`

> **Supersedes the PRD's mechanism.** The PRD proposed wiring `runSdkOneShot`
> into the scoring path (modeled on `selector.ts`). That routes Claude through
> `ModelProvider.complete`, which requires `ANTHROPIC_API_KEY` and violates
> Orca's interactive-subscription policy. This spec is authoritative wherever it
> conflicts with the PRD. In particular, the PRD acceptance criterion
> *"`workflow_llm_calls` shows a scoring LLM call per completed step"* is **void**:
> scoring now rides the existing shadow approval turn and produces no separate
> `workflow_llm_calls` row.

## Problem

Workflow step results are currently persisted, but completed steps consistently
receive the daemon's evaluation-failure fallback. The scoring helper calls the
orchestration transport broker without an executable transport, so it never
obtains a scoring proposal.

The PRD proposes fixing this by wiring `runSdkOneShot`. That is incompatible
with Orca's current execution policy:

- Anthropic SDK completions require `ANTHROPIC_API_KEY`.
- Orca's Claude orchestration path must use the user's interactive Claude Code
  subscription.
- Claude must run as a persistent interactive shadow session, not through
  `claude -p`.

Step results are also invisible in the desktop. They are stored only in
`workflow_step_runs.step_result_json`, while the Activity Thread has no terminal
result representation.

## Goals

- Produce real model-scored results for normally completed worker steps.
- Reuse the shadow-orchestrator turn that already approves normal completion.
- Keep Claude orchestration free of API-key and `claude -p` dependencies.
- Preserve workflow advancement when evaluation fails.
- Show one expandable result card in the Activity Thread for every terminal step
  attempt.
- Keep `workflow_step_runs.step_result_json` as the canonical result.

## Non-Goals

- No workflow gating based on score value.
- No worker self-scoring.
- No redesign of hidden-interactive or human-review transports.
- No ordinary orchestrator chat message for step results.
- No additional model evaluation for blocked, failed, or cancelled steps.
- No support for Claude model-operator execution through direct provider SDK
  calls.

## Decisions

1. Normal worker completion is approved and scored in one shadow-orchestrator
   turn.
2. The step worker remains the evidence producer; the shadow orchestrator owns
   subjective scoring.
3. Worker-exit recovery may use one dedicated structured shadow turn because no
   approval turn exists.
4. Claude model-operator execution is removed or disabled as a valid path when
   direct one-shot execution is disabled.
5. Terminal results appear as Activity Thread cards, not chat messages.
6. Cards show a concise summary by default and full metrics when expanded.
7. Evaluation failure is labeled `Evaluation failed`; the UI never presents its
   persisted zero values as a valid `0%` quality score.
8. **Scope is the full shadow-only policy, not scoring alone.** All four
   terminal scoring entry points and every `broker.propose` caller that relies
   on the SDK fast-path are addressed in this work: scoring
   (`step-result-scoring.ts`), operator selection (`selector.ts`), synthesis
   (`synthesize.ts`), and the Claude model-operator path (`service.ts:1244`).
   For shadow-only adapters each is fixed by routing through the shadow session
   or by being made provably unreachable — none may silently fall through to
   `hidden_interactive`/`human_review`.
9. **Worker-exit recovery blocks on a bounded shadow turn.** The dedicated
   structured shadow turn runs with the existing shadow-ask timeout; on timeout,
   hook failure, or malformed response it writes an evaluation-failure result and
   advances. It never blocks advancement indefinitely.
10. **Replay and reconciliation do not re-score.** When a terminal path is
    reached with `step_output` already persisted but `step_result_json` null
    (crash/restart replay at `service.ts:299`, and startup reconciliation), the
    daemon writes a deterministic evaluation-failure result with measured facts.
    No new model call is made on these rare recovery paths.
11. **Result-card ordering is deterministic.** Activities order by terminal
    `finishedAt`, tiebroken by a deterministic secondary key (activity
    id/sequence), so the result card reliably follows the step's worker-turn
    summaries even when timestamps collide.
12. **Reliability bar is unit tests, not a prompt-eval gate.** Scoring is
    validated; missing/malformed scoring yields a non-blocking evaluation-failure
    result. The approval-action and scoring-validation branches are covered by
    unit tests. No separate scoring-fill-rate eval harness is built for this
    work; fill-rate is observed in practice post-ship.

## Execution and Scoring

### Normal Worker Completion

The existing normal path is:

1. A step worker emits a valid `orca:step-complete` block.
2. The daemon validates the block against the step output schema.
3. The shadow orchestrator judges the worker response.
4. The shadow orchestrator returns `approve_step_complete`.
5. The daemon writes the output artifact, terminates the worker, and advances.

Extend `approve_step_complete` so the same shadow turn also returns a scoring
proposal:

```ts
{
  kind: "approve_step_complete",
  scoring: {
    successScore: number,
    quality: {
      outputCompleteness: number,
      outputCorrectness: number,
      instructionAdherence: number,
      downstreamReadiness: number,
      riskLevel: number
    },
    reason: string,
    handoffReady: boolean
  },
  rationale?: string
}
```

The approval action and its nested scoring payload are validated separately.
The action parser must preserve a valid `approve_step_complete` decision even
when `scoring` is missing or malformed. The daemon then validates `scoring` with
`StepResultScoringProposal`, combines valid scoring with daemon-owned
`StepResultScoringFacts`, and builds the strict `WorkflowStepResult`.

The order is:

1. Capture and validate the approval plus scoring proposal.
2. Persist the step output artifact.
3. Build the scored result from the proposal and measured facts.
4. Terminate the worker best-effort.
5. Persist the result during the terminal step transition.
6. Advance the workflow regardless of score value.

The worker does not see or author the score. Its output, artifacts, assumptions,
warnings, and completion statement are evidence supplied to the independent
shadow orchestrator.

### Invalid or Missing Approval Scoring

An invalid or missing scoring proposal must not block completion after the
orchestrator approved the output.

The daemon writes an evaluation-failure result with:

- the real terminal step status;
- daemon-measured duration, retries, artifact count, blocker count, and warning
  count;
- `evaluationStatus: "failed"`;
- a bounded, secret-redacted failure reason.

Worker termination and workflow advancement still proceed.

### Worker-Exit Recovery

`onWorkflowSessionCompleted` handles a worker that exits before the normal
approval flow finishes.

The recovery path:

1. Read the captured session tail.
2. Parse and validate a structured output block when present.
3. Use one narrowly typed structured shadow turn to evaluate valid recovered
   output, or to recover and evaluate output when no valid block exists.
4. Validate the final output against the step schema.
5. Validate scoring against `StepResultScoringProposal`.
6. Persist the output and scored result, then advance.

The dedicated recovery turn uses `ShadowSessionManager.ask()` through a small
typed shadow-evaluation interface. It launches or reuses plain interactive
`claude` in tmux, pastes the prompt, and receives the completed action through
hooks. It does not call `ModelProvider.complete`, require an API key, or invoke
`claude -p`.

This recovery turn **blocks** the terminal transition but is bounded by the
existing shadow-ask timeout. On timeout, hook failure, malformed response, or
schema rejection, the daemon writes the bounded `evaluationStatus: "failed"`
result and advances — it never waits on the shadow turn indefinitely.

### Blocked, Failed, and Cancelled Steps

Blocked, failed, and cancelled steps do not receive another model call. Their
daemon-authored terminal results remain authoritative:

- terminal state and measured facts are shown;
- `evaluationStatus: "failed"` communicates that no subjective score exists;
- the result reason explains the terminal or evaluation condition.

### Replay and Reconciliation

A terminal scoring path can be re-entered after a crash or restart with the
step's `step_output` already persisted but `step_result_json` still null (the
idempotency branch at `service.ts:299`, and startup reconciliation). On these
paths there is no live approval turn and no live worker session to score
against.

These paths do **not** issue a new model call. The daemon writes a deterministic
evaluation-failure result built from measured facts (real terminal status,
duration, retries, artifact/blocker/warning counts, `evaluationStatus: "failed"`,
bounded reason) and advances. This keeps crash recovery deterministic and cheap;
only the live normal-completion and worker-exit paths produce model-scored
results.

### Direct-SDK Caller Scope

This work resolves the shared root cause across every `broker.propose` caller
that depended on the SDK fast-path, not the scoring path alone. With no API key,
each otherwise falls through to `hidden_interactive`/`human_review`:

- **Scoring** (`step-result-scoring.ts`) — replaced by the shadow approval-turn
  scoring described above; the separate broker scoring call is removed.
- **Operator selection** (`selector.ts`) — must use the shadow session for
  shadow-only adapters, never `runSdkOneShot`.
- **Synthesis** (`synthesize.ts`) — must use the shadow session for shadow-only
  adapters, or be provably unreachable for them.
- **Claude model operator** (`service.ts:1244`) — disabled under shadow-only
  policy (see below).

A caller is "fixed" when, for a shadow-only adapter, it either routes through a
shadow-session path or is provably unreachable. For adapters that legitimately
enable `one_shot` (with an API key), the existing SDK path remains valid and
unchanged.

### Claude Model Operators

The current model-operator path asks a model provider to produce a complete
`StepSkillProposal` without creating a worker session. For Claude, that path
ultimately depends on direct provider/API execution and conflicts with the
configured execution-mode policy.

For adapters whose `one_shot` mode is disabled:

- operator selection must not choose a direct model operator;
- workflow steps use interactive agent operators;
- orchestration decisions use the provider's shadow session;
- no fallback silently re-enables `ModelProvider.complete`.

Existing direct-SDK callers, including operator selection and synthesis, must be
audited. A caller is fixed when it either uses a shadow-session path or is
provably unreachable for shadow-only adapters.

## Activity Data Model

`workflow_step_runs.step_result_json` remains the sole canonical result. Do not
copy the full result into `activities`, workflow events, or orchestrator
messages.

Add a terminal-result activity source kind, for example `step_result`.
For every terminal transition:

1. Persist `step_result_json`.
2. Emit the existing terminal workflow event.
3. Materialize one completed result activity for that step attempt.
4. Emit `activity.changed`.

Result-activity creation is idempotent. Enforce at most one `step_result`
activity per `step_run_id`, including replay and daemon recovery.

Startup reconciliation scans terminal step rows that have a canonical result but
no result activity and materializes the missing activity. This closes the gap if
the daemon exits after the terminal transaction but before activity projection.

The activity row identifies ordering and presentation type. The activity
projection joins the row to:

- `workflow_step_runs.step_result_json`;
- the workflow template step name;
- terminal timestamps.

The shared `Activity` projection exposes optional result-card data only for
`sourceKind: "step_result"`, including the parsed `WorkflowStepResult` and step
name. Other activity kinds remain unchanged.

Existing worker-turn summaries remain separate completed activities. The final
result card follows those summaries as the terminal outcome for the step
attempt. Ordering is by terminal `finishedAt`, tiebroken by a deterministic
secondary key (activity id/sequence), so the result card reliably sorts after
the step's worker-turn summaries even when timestamps collide.

Workflow event payloads remain identifier-only and within the existing 4 KiB
cap. The desktop already refreshes Activity Thread data on `activity.changed`
and workflow events.

## Activity Thread UI

### Collapsed Card

Every terminal step result initially renders a concise card containing:

- step name;
- terminal state;
- percentage score only when `evaluationStatus === "scored"`;
- evaluation status;
- handoff readiness when scored;
- short reason;
- artifact, blocker, and warning counts;
- an expand/collapse control.

### Expanded Metrics

Expansion reveals:

- output completeness;
- output correctness;
- instruction adherence;
- downstream readiness;
- risk level;
- duration;
- retries;
- optional total turns and tool-call counts when measured;
- full reason;
- all outcome facts.

Scores are displayed as percentages derived from their stored `0..1` values.
Risk level remains clearly labeled as risk so a higher value is not mistaken for
a better score.

### Evaluation Failure

When `evaluationStatus === "failed"`:

- the headline says `Evaluation failed`;
- no percentage is displayed;
- quality dimensions are omitted because their persisted zero values are
  fallback contract values, not measurements;
- expansion shows the failure reason and daemon-measured performance/outcome
  facts.

The terminal step state remains visually distinct from evaluation state. A
completed step with failed evaluation must not look like a failed step.

### Terminal States

Cards render for:

- completed;
- blocked;
- failed;
- cancelled.

State styling communicates the workflow outcome without conflating it with
evaluation success.

## Error Handling and Recovery

- Shadow timeout, hook failure, malformed response, and schema rejection produce
  a bounded evaluation-failure result.
- Scoring failure never blocks workflow advancement.
- Worker termination occurs after scoring capture or bounded scoring failure.
- Result-activity creation is recoverable from terminal step rows and must not
  alter workflow state.
- Activity projection errors remain presentation failures; they do not mutate
  canonical results.
- Persisted and displayed reasons use existing secret-redaction and size bounds.

## Testing

### Contracts

- `approve_step_complete` accepts a valid scoring proposal.
- Missing, malformed, and out-of-range nested scoring preserves the approval
  action but fails `StepResultScoringProposal` validation.
- Activity contracts accept result activities with parsed step results and
  reject result payloads on incompatible source kinds.

### Shadow Orchestration

- One normal shadow turn both approves completion and supplies scoring.
- The Claude path launches plain interactive `claude`.
- Tests prove scoring does not call `ModelProvider.complete`.
- Tests prove scoring does not require `ANTHROPIC_API_KEY`.
- Tests prove no path invokes `claude -p`.

### Orchestrator Service

- Scored results combine shadow-owned scoring with daemon-owned facts.
- Invalid approval scoring writes an evaluation-failure result and advances.
- Worker termination happens after proposal capture.
- Worker-exit recovery handles valid output, malformed output, shadow failure,
  shadow timeout, and fallback persistence; the recovery turn is bounded and
  always advances.
- Replay/reconciliation (output present, result null) writes a deterministic
  evaluation-failure result with no model call and advances.
- Shadow-only adapters cannot select or execute direct model operators.
- For shadow-only adapters, operator selection and synthesis route through the
  shadow session and never invoke `runSdkOneShot`; no scoring/selection/synthesis
  path emits a `transport.fallback` or `human_review` attempt.
- One_shot-enabled adapters retain their existing SDK path unchanged.

### Activity Subsystem

- Each terminal event creates one result activity.
- Event replay and recovery do not duplicate result activities.
- Projection returns the step name and canonical parsed result.
- Completed turn summaries and terminal result cards retain deterministic order.

### Desktop

- All terminal states render result cards.
- Cards are concise by default and reveal full metrics when expanded.
- Scored results show percentages.
- Evaluation failures show `Evaluation failed` and never `0%`.
- Completed-step and evaluation-failure styling remain semantically distinct.

### End-to-End

Run a workflow through normal worker completion and verify:

- `step_result_json` has `evaluationStatus: "scored"` and a real score;
- no scoring-related transport fallback or human-review attempt occurs;
- no API key is needed;
- no `claude -p` process is used;
- one expandable terminal result card appears in the Activity Thread.

Also run or simulate blocked, failed, cancelled, and worker-exit paths and verify
their cards and fallback semantics.

## Acceptance Criteria

- Normal completed worker steps are approved and scored by the same shadow
  orchestrator turn.
- Claude scoring uses interactive subscription authentication only.
- Completed workflow steps no longer receive universal zero-score fallbacks.
- Evaluation failure remains non-blocking and is presented honestly.
- Every terminal step attempt has exactly one Activity Thread result card.
- The card is concise when collapsed and exposes full valid metrics on expansion.
- Direct Claude model-operator execution is disabled under shadow-only policy.
- Operator selection and synthesis no longer fall through to
  `hidden_interactive`/`human_review` for shadow-only Claude.
- Worker-exit recovery scoring is bounded and never blocks advancement
  indefinitely.
- Replay and startup reconciliation never issue a scoring model call.
