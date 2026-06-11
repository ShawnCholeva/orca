# PRD: Fix step-result scoring + surface step_result in Orca chat

- **Status:** Superseded by design spec (`docs/superpowers/specs/2026-06-08-step-result-scoring-and-activity-visibility-design.md`)
- **Author:** Generated from live debug session (2026-06-07)
- **Owner:** TBD (handoff to implementing agent)
- **Area:** `apps/daemon` — workflow orchestrator / orchestration-transport

> **Note (2026-06-09):** The root-cause analysis below is accurate, but the
> proposed fix (§6.A, wire `runSdkOneShot`) is **not** the chosen approach — it
> routes Claude through `ModelProvider.complete`/`ANTHROPIC_API_KEY`, which
> violates Orca's interactive-subscription policy. The design spec is
> authoritative for the implementation. See its "Supersedes" note for details.

---

## 1. Summary

Two related defects make workflow step results worthless and invisible:

1. **Scoring is broken on every step.** The step-result scoring path calls the
   orchestration transport broker without the `runSdkOneShot` executor, so it
   never takes the working SDK fast-path. For Anthropic-backed runs it falls
   through to a transport plan that cannot succeed, and **every step lands a
   zero-score fallback** (`evaluationStatus: "failed"`, `successScore: 0`).
2. **`step_result` is never surfaced in Orca chat.** It is persisted only in
   `workflow_step_runs.step_result_json`; the `workflow.step.completed` event
   payload carries none of the result fields, so the chat surface can never
   display it.

Both must be fixed for the user's goal ("see the step_results at the end of each
step of the workflow") to be met with *real* scores.

---

## 2. Background / Current Behavior

`step_result` is persisted in `workflow_step_runs.step_result_json`, one row per
step attempt. It is `NULL` while a step is `active` and written exactly once when
the step finishes.

Inspect any step's result:

```sql
SELECT ordinal, step_template_id, status, step_result_json
FROM workflow_step_runs
ORDER BY workflow_run_id, ordinal;
```

Observed in the live DB (`~/.orca/orca.db`): every completed step contains an
identical zero-score fallback, regardless of how well the step actually
performed (one step did its real work fine in 96s and still scored 0):

```json
{
  "stepStatus": "completed",
  "evaluationStatus": "failed",
  "successScore": 0,
  "quality": { "outputCompleteness": 0, "outputCorrectness": 0,
               "instructionAdherence": 0, "downstreamReadiness": 0, "riskLevel": 1 },
  "outcome": { "reason": "step result evaluation failed: step result scoring did not produce a proposal",
               "producedArtifactsCount": 1, "handoffReady": false }
}
```

---

## 3. Root Cause (verified against source)

All references confirmed in this repo.

1. **`apps/daemon/src/workflows/orchestrator/step-result-scoring.ts:66`** — the
   scoring loop calls `deps.broker.propose(request, { validateProposal })`,
   passing **only** `validateProposal` and **no** `runSdkOneShot` (or any other
   transport executor).

2. **`apps/daemon/src/workflows/orchestration-transport/broker.ts:108`** — the
   working SDK fast-path is gated on:
   ```ts
   if (options?.runSdkOneShot && !options.runOneShot && !options.runHiddenInteractive) {
     return this.proposeSdkCompatibility(parsedRequest, options);
   }
   ```
   With no `runSdkOneShot`, this is `false`, so execution falls through to the
   provider transport plan.

3. **`apps/daemon/src/workflows/orchestration-transport/policy.ts`** — for
   provider `orca/anthropic`, `resolveTransportPlan` returns
   `["hidden_interactive", "human_review"]`.

4. The plan executes in order:
   - `hidden_interactive` cannot spawn (no interactive executor was supplied) →
     fails with `interactive_spawn_failed`.
   - `human_review` returns `needs_human_review` (not `"proposed"`).
   - The `for (let attempt = 0; attempt < 2; attempt++)` loop retries once, both
     attempts fail to produce a proposal, and the path yields
     `"step result scoring did not produce a proposal"` → the zero-score
     fallback is written.

### Proven-working contrast

**`apps/daemon/src/workflows/operators/selector.ts:222`** calls the *same*
`broker.propose`, but passes a `runSdkOneShot` executor (lines ~223–240) that
runs the provider completion and records the LLM call. It therefore takes the
SDK fast-path at `broker.ts:108` and succeeds. This is the exact shape the
scoring path is missing.

---

## 4. Evidence (live DB)

| Source | Observation | Meaning |
|---|---|---|
| `events` (transport.fallback) | 6× `hidden_interactive` / `interactive_spawn_failed` / `orca/anthropic` | 3 completed steps × 2 loop attempts each |
| `orchestration_transport_attempts` | 6 `hidden_interactive` = failed, 6 `human_review` = pending | every attempt failed or stalled at human review |
| `workflow_llm_calls` | **0 rows** | the SDK path — the only path that inserts an LLM call — was **never** taken; no scoring LLM call has ever run |

---

## 5. Secondary Issue — Chat Observability Gap

`step_result` lives only in `workflow_step_runs.step_result_json`. The
`workflow.step.completed` event payload keys are exactly:

```
[goalId, ordinal, stepRunId, stepTemplateId, workflowRunId]
```

No result fields are included, so the Orca chat surface cannot display
`step_result` even once scoring is fixed.

---

## 6. Proposed Fix

**A. Wire the SDK one-shot executor into the scoring path.**
In `step-result-scoring.ts:66`, pass a `runSdkOneShot` executor to
`broker.propose` modeled on `selector.ts:222` (run the provider completion,
insert/update the `workflow_llm_calls` row, return the parsed proposal). This
makes scoring take the SDK fast-path instead of the unsupported
`hidden_interactive` plan.

**Also audit for the same omission:**
- `apps/daemon/src/workflows/orchestrator/synthesize.ts` (synthesize call to `broker.propose`)
- any `service.ts` orchestration call that proposes without `runSdkOneShot`

**B. Surface `step_result` in chat.**
Include `step_result` (or a summary: `successScore`, `evaluationStatus`,
`quality`, `outcome.reason`) in the `workflow.step.completed` event payload
and/or the chat fetch, so the chat surface can render it at the end of each step.

---

## 7. Acceptance Criteria

- [ ] Completed steps persist `step_result` with `evaluationStatus: "scored"`
      and a real, non-zero `successScore` reflecting actual step quality.
- [ ] ~~`workflow_llm_calls` shows a scoring LLM call per completed step (no longer 0 rows).~~
      **Void under the chosen design** — scoring rides the shadow approval turn and
      writes no separate `workflow_llm_calls` row.
- [ ] No `transport.fallback` / `interactive_spawn_failed` events are emitted for
      the scoring path.
- [ ] `step_result` (or its summary) is visible in Orca chat at the end of each step.
- [ ] `synthesize.ts` and any other affected `broker.propose` callers are fixed or
      confirmed unaffected.

---

## 8. Scope / Out of Scope / Risks

**In scope:** wiring `runSdkOneShot` into the scoring (and synthesize) path;
adding `step_result` to the step-completed event payload / chat fetch.

**Out of scope:** redesigning the `hidden_interactive` / `human_review`
transports themselves; broader chat UI redesign beyond surfacing the result.

**Risks / notes:**
- Adding LLM calls to scoring introduces latency and token cost per step —
  acceptable, since this is the intended behavior.
- Ensure `workflow_llm_calls` rows are correctly recorded on both success and
  failure (mirror `selector.ts` error handling).
- Re-run a workflow after the fix and re-query `workflow_step_runs.step_result_json`
  to confirm real scores before closing.
