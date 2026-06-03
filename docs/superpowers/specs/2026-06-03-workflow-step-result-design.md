# Workflow Step Result Measurement

**Date:** 2026-06-03
**Branch:** main
**Status:** Design approved, pending spec review

## Problem

Workflow steps currently track lifecycle state, timing, selected operator metadata,
and artifacts, but they do not persist a strict result summary that can be used to
measure how a step behaved.

The user wants every terminal step to have a hidden `step_result` record with
scores, quality dimensions, performance facts, and outcome facts. The UI does not
need to show this data. In v1, Orca should collect the metrics only; workflow
advancement must not depend on the result scores.

## Goals

- Persist a strict `step_result` for every terminal workflow step run.
- Separate the step lifecycle result from the evaluation/scoring result.
- Let the daemon own measurable facts and evaluation-failure fallback results.
- Let the orchestrator model own normal subjective scoring.
- Treat step-agent output as evidence, not as self-scoring authority.
- Keep desktop UI unchanged.
- Do not add placeholder/default values that pretend a value was measured.

## Non-Goals

- No UI rendering for `step_result`.
- No workflow gating based on scores in v1.
- No changes to the existing `workflow_step_runs.status` values.
- No self-scoring by the agent that performed the step.
- No broad telemetry system for turns/tool calls unless reliable counters already
  exist at implementation time.

## Contract

Add a strict shared contract for `WorkflowStepResult` and include it on
`WorkflowStepRun` as `stepResult`.

`stepResult` is nullable while a step is non-terminal. Once a step reaches a
terminal state, it must be present and must satisfy the full schema.

```ts
step_result {
  step_id: string,

  step_status: "completed" | "partial" | "blocked" | "failed" | "cancelled",
  evaluation_status: "scored" | "failed",

  success_score: number, // 0.0 - 1.0

  quality: {
    output_completeness: number,
    output_correctness: number,
    instruction_adherence: number,
    downstream_readiness: number,
    risk_level: number
  },

  performance: {
    duration_seconds: number,
    retries: number,
    total_turns?: number,
    tool_calls?: number
  },

  outcome: {
    reason: string,
    produced_artifacts_count: number,
    blocking_issues_count: number,
    warnings_count: number,
    handoff_ready: boolean
  }
}
```

All score fields are bounded from `0.0` through `1.0`. Counts are non-negative
integers. `reason` is bounded and secret-redacted before persistence.

`total_turns` and `tool_calls` stay optional because the current workflow step
state does not yet expose reliable counters. They should only be populated when
implementation finds a real system source for them.

## Status Mapping

Keep the existing DB status enum unchanged:

- `passed`
- `blocked`
- `failed`
- `skipped`

Map it into `step_result.step_status`:

- `passed -> completed`
- `blocked -> blocked`
- `failed -> failed`
- `skipped -> cancelled`

If a future terminal path represents incomplete-but-usable output, it may map to
`partial`. No current path should invent `partial`.

## Responsibilities

### Daemon

The daemon computes factual fields:

- `step_id`
- `step_status`
- `performance.duration_seconds`
- `performance.retries`
- `outcome.produced_artifacts_count`
- `outcome.blocking_issues_count`
- `outcome.warnings_count`

The daemon also writes the full result if orchestrator scoring fails. In that
case, the result must say evaluation failed, not pretend the step itself was
scored successfully.

### Step Agent

The step agent provides evidence through the existing step output, handoff notes,
warnings, assumptions, open questions, and artifacts. The step agent does not
write or own `success_score`, `quality`, or final `handoff_ready`.

### Orchestrator Model

The orchestrator model owns normal subjective evaluation:

- `success_score`
- every `quality` dimension
- `outcome.reason`
- `outcome.handoff_ready`

The model scores against the goal, step instructions, output schema, available
artifacts, and downstream readiness. The daemon validates the model proposal
against the strict contract before persistence.

## Evaluation Failure

Workflow progression must not depend on score quality in v1. The scoring attempt
must be bounded; if the orchestrator evaluation call times out, errors, or
returns an invalid proposal, the daemon still writes a strict `step_result` with
`evaluation_status: "failed"`.

For example:

```json
{
  "step_id": "step-1",
  "step_status": "completed",
  "evaluation_status": "failed",
  "success_score": 0,
  "quality": {
    "output_completeness": 0,
    "output_correctness": 0,
    "instruction_adherence": 0,
    "downstream_readiness": 0,
    "risk_level": 1
  },
  "performance": {
    "duration_seconds": 42,
    "retries": 0
  },
  "outcome": {
    "reason": "step result evaluation failed: evaluation proposal did not validate",
    "produced_artifacts_count": 1,
    "blocking_issues_count": 0,
    "warnings_count": 0,
    "handoff_ready": false
  }
}
```

These are not default placeholders. They are an explicit measurement of the
evaluation subsystem failing to score the step result.

## Persistence

Add `step_result_json` to `workflow_step_runs`.

Projection behavior:

- Active/non-terminal steps expose `stepResult: null`.
- Terminal steps expose the parsed `WorkflowStepResult`.
- Invalid persisted JSON should be treated as a daemon bug and fail contract
  parsing during development/tests.

Terminal transition behavior:

- On successful scoring, persist the orchestrator-scored result in the same
  terminal transition flow.
- On scoring timeout/failure, persist the daemon-authored evaluation-failure
  result.
- Do not delay or block workflow advancement based on the score value.

## Events

Step terminal events may include `stepResult` if the payload cap permits it.
If including the full result risks the existing workflow event payload budget,
events should carry only identifiers and consumers can fetch the step run.

This design does not require a new UI event or visible desktop change.

## Files

Expected implementation touch points:

- `packages/contracts/src/workflows/index.ts` - add `WorkflowStepResult` and
  expose `stepResult` on `WorkflowStepRun`.
- `packages/contracts/src/__tests__/workflow-contracts.test.ts` - cover scored
  and evaluation-failed results.
- `apps/daemon/migrations/0022_workflow_step_result.sql` - add
  `step_result_json`.
- `apps/daemon/src/migrations.ts` and migration tests - register and verify the
  migration.
- `apps/daemon/src/workflows/steps/projection.ts` - parse `step_result_json`.
- `apps/daemon/src/workflows/steps/usecases.ts` - persist step results on
  terminal step transitions.
- `apps/daemon/src/workflows/orchestrator/*` - add scoring request/proposal path
  if needed for orchestrator evaluation.
- Focused daemon tests around terminal completion, blocked, failed, and
  evaluation-failure behavior.

## Testing

- Contract tests accept valid scored results and valid evaluation-failed results.
- Contract tests reject out-of-range scores and missing required fields.
- Migration test applies the new migration and confirms `step_result_json`
  exists.
- Projection test returns `stepResult: null` for active steps and parsed result
  for terminal steps.
- Step usecase tests prove terminal transitions persist a strict `step_result`.
- Orchestrator/service tests prove scoring failure still terminalizes the step and
  writes `evaluation_status: "failed"`.
- Existing desktop tests should not need updates because the UI does not render
  the new field.

## Risks

- **Scoring latency/cost.** Mitigated by v1 measurement-only behavior; scores do
  not gate workflow progression.
- **Overloaded failure semantics.** Mitigated by separating `step_status` from
  `evaluation_status`.
- **Incomplete telemetry.** Mitigated by requiring only daemon facts that exist
  today and keeping `total_turns` / `tool_calls` optional until real counters are
  available.
- **Payload growth.** Mitigated by storing the full result on the step run and
  keeping event payloads minimal if needed.
