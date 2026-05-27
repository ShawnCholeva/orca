# Instruction-Driven Workflow Steps — Phase 1 Design

**Date:** 2026-05-27
**Status:** Approved design, pre-implementation
**Scope:** Phase 1 — model-operator path (grill-me intake end-to-end)

## Problem

Today a workflow step is defined by a large, mostly-deterministic template
(`exitCriteria`, `gateType`, `requiredInputs/outputs`, `recommendedCapabilities`,
`recommendedOperatorIds`, `validationExpectations`) plus a per-step `StepRule`
implementation that hardcodes the step's behavior. The `intake` step, for example,
asks a fixed list of questions in fixed order (`nextQuestion`) and maps each answer to a
fixed exit criterion (`evaluateUserInputAsArtifact`). There is no way to:

- author a step by simply giving it instructions (e.g. Matt Pocock's "grill-me" skill),
- have the orchestrator interview the user adaptively until shared understanding is
  reached, then emit a structured result,
- pass that structured result to the next step as typed input,
- let the orchestrator route a step to the best available model.

We want steps to be authored as `(instructions, outputSchema)` and executed as a
pipeline: **input → instructions → structured output → next step's input**.

## Goals

- A workflow step is **authored** with exactly two fields: `instructions` (required) and
  `outputSchema` (required). Identity fields `id`, `ordinal`, `name` remain.
- The orchestrator LLM is **purely a router/coordinator**. It selects which operator
  executes a step; it does not perform step work itself.
- A selected **model operator** executes a step's instructions, interviewing the user
  one question at a time when needed, and finishes by producing a structured output that
  conforms to the step's `outputSchema`.
- Completion is **LLM-judged** by the executing operator (it decides when the interview
  is done), not by a fixed exit-criteria list.
- The structured output of step N becomes the input of step N+1. Step 0's input is the
  goal description.
- Cross-vendor routing is demonstrated at the **model** level: a Claude orchestrator may
  route a step to Gemini or GPT.
- The Engineering `intake` step is reseeded as a grill-me skill and runs end-to-end.

## Non-Goals (deferred to Phase 2)

- Routing to **agent operators** (claude-code, codex, opencode PTY sessions) and
  synthesizing schema-conforming output from a free-form agent session.
- Full JSON Schema support. Phase 1 uses a lightweight field-list schema.
- Rewriting non-intake Engineering steps' instructions for production quality (they will
  get placeholder instructions so the template still validates; real authoring is a
  follow-up).

## Authoring model vs. engine model

These are deliberately different surfaces:

- **Authoring (what the user edits in the UI):** `instructions`, `outputSchema`. Plus
  `name` for display. `id`/`ordinal` are managed by the editor.
- **Engine (runtime state, not authored):** the resolved step input, the selected
  operator, the interview transcript, the structured output artifact, and the hand-off to
  the next step. The engine understands more than the two authored fields; the user is not
  asked to specify any of it.

## Data model changes

### `WorkflowStepTemplate` (`packages/contracts/src/workflows/index.ts`)

Replace the current field set with:

```ts
WorkflowStepTemplate = {
  id: Id100,
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).max(100),
  instructions: BoundedString(WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES /* 8192 */, "instructions"),
  outputSchema: WorkflowStepOutputSchema,   // required, min 1 field
}
```

Removed fields: `purpose`, `requiredInputs`, `requiredOutputs`, `gateType`,
`recommendedCapabilities`, `validationExpectations`, `exitCriteria`,
`recommendedOperatorIds`.

### `WorkflowStepOutputSchema` (new)

A lightweight, dependency-free schema (no `ajv`):

```ts
WorkflowStepOutputField = {
  key: z.string().min(1).max(64),
  type: z.enum(["string", "number", "boolean", "array", "object"]),
  required: z.boolean(),
  description: z.string().max(256).optional(),   // helps the operator populate it
}
WorkflowStepOutputSchema = z.array(WorkflowStepOutputField).min(1).max(32)
```

Validation of an operator's output is a manual check: every `required` key present, and
each present key's runtime type matches its declared `type`.

### `WorkflowArtifactType` (extend enum)

Add:
- `step_output` — JSON body, the structured result of a step (conforms to that step's
  `outputSchema`). Linked to the producing `stepRunId`.
- `interview_turn` — JSON body `{ question: string, answer: string }`, one persisted turn
  of an interview. Linked to the producing `stepRunId`.

Existing artifact types (`goal_brief`, `prd`, …) are retained for now but are no longer
produced by the intake path; cleanup of unused types is out of scope for Phase 1.

### `OrchestrationDecisionKind` (extend enum)

Add `run_step_skill`. Remove `evaluate_exit_criteria` (no exit criteria anymore).

### `StepSkillProposal` (new envelope payload)

The operator's response for a `run_step_skill` request:

```ts
StepSkillProposal = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ask"), question: z.string().min(1).max(2000), rationale: z.string().max(1000).optional() }),
  z.object({ action: z.literal("complete"), output: z.record(z.unknown()) }),
])
```

`complete.output` is then checked against the step's `outputSchema`.

## Engine: per-step lifecycle

Implemented in `apps/daemon/src/workflows/orchestrator/service.ts`,
`requestNextDecision`. The deterministic block (rule satisfaction, `missingInputs`,
`outstanding`/exit-criteria, `gateType` branch) is removed and replaced by:

```
resolve step input
if no operator selected for this step yet:
    -> selectOperator   (orchestrator LLM routes among model operators)
else:
    -> runStepSkill     (selected operator executes instructions)
```

### 1. Resolve step input

- `ordinal === 0` → `goal.description`.
- `ordinal === N` → body of the `step_output` artifact produced by the step at
  `ordinal N-1`.

### 2. Select operator (routing)

- Reuse the existing `select_operator` decision + `operatorSelector` + `broker` +
  `workflow.operator.selected` event.
- Change the selection input: instead of `recommendedCapabilities` /
  `recommendedOperatorIds`, the orchestrator is given the step's `instructions`, the step
  input, and the list of **ready model operators** (`OperatorDescriptor` with `kind:
  "model"`). It returns the chosen operator id + reason.
- The selection is made once per step and persisted (derive from the latest
  `workflow.operator.selected` event for the step run; no schema change required).
- Phase 1 restricts candidates to `kind: "model"`. Agent operators are filtered out.

### 3. Run step skill (execution)

- The selected operator's `providerId`/`modelId` are parsed from its operator id
  (e.g. `orca/anthropic:claude-sonnet-4-6`).
- Call `broker.propose({ kind: "run_step_skill", goalId, workflowRunId, stepRunId,
  providerId, modelId, payload: { instructions, stepInput, transcript } }, {
  validateProposal })`.
  - `transcript` = ordered `interview_turn` artifacts for this step run
    (`[{question, answer}, …]`).
  - `validateProposal` parses `StepSkillProposal`; if `action: "complete"`, it also runs
    the `outputSchema` check. A schema-invalid completion is rejected (triggers broker
    fallback / retry; see Error handling).
- On parsed result:
  - **`ask`** → record a `request_user_input` decision (question = `proposal.question`)
    and the existing `request_user_input` recommendation. This already renders as the
    input card in `OrcaChat`. `commitUserInputDecision` is generalized to accept an
    explicit question argument (today it derives the question from `rule.nextQuestion`).
  - **`complete`** → create the `step_output` artifact (JSON body = `proposal.output`),
    then emit the existing `advance_step` recommendation (or `mark_run_complete` if it is
    the last step).

### 4. Answer persistence + auto-advance (`apps/daemon/src/workflows/steps/routes.ts`)

- The submit route already calls `requestNextDecision` after a user answer, so the loop
  auto-advances.
- For instruction-driven steps, the submit route no longer calls
  `evaluateUserInputAsArtifact`. Instead it creates an `interview_turn` artifact from
  `{ lastQuestion, answerText }`, where `lastQuestion` is the most recent
  `request_user_input` decision's reason for this step run. Secret redaction
  (`redactSecrets`) is preserved.

### 5. Hand-off

- The next `requestNextDecision` resolves the new step's input from the previous step's
  `step_output` and repeats from step 2.

## Removals

- Delete the `StepRule` registry and all rule files
  (`apps/daemon/src/workflows/steps/rules/*`): `types.ts`, `common.ts`, `index.ts`,
  `intake.ts`, `research.ts`, `prd.ts`, `issue_breakdown.ts`, `execution.ts`, `qa.ts`,
  `review.ts`, `done.ts`.
- Remove `nextQuestion`, `evaluateUserInputAsArtifact`, `evaluateArtifactSatisfies`,
  `evaluateGoalContextSatisfies`, `onArtifactCreated`, `evaluateSessionSummarySatisfies`
  usage from the engine and submit route.
- Remove the deterministic satisfaction / `missingInputs` / `outstanding` / exit-criteria
  / `gateType` logic from `requestNextDecision`.
- Remove the removed step fields from DB projections, seed data, contracts, UI, and tests.
- `WorkflowStepRun.satisfiedExitCriteria` / `outstandingExitCriteria` are removed from the
  step-run projection (no exit criteria). Step run still tracks `status`, `ordinal`,
  `attempt`, timestamps, `blockedReason`.

## UI changes

- `apps/desktop/src/workflows/StepEditor.tsx`: reduce to two inputs — an **Instructions**
  textarea and an **Output schema** editor (repeatable rows of `key`, `type` select,
  `required` checkbox, optional `description`). Remove editors for the deleted fields.
- `TemplateDetail.tsx` / `WorkflowsPage.tsx`: drop display of removed fields.
- `OrcaChat` already renders the input card for `request_user_input`; no change needed for
  the interview loop. The `WorkflowBanner`'s exit-criteria display is removed.

## Engineering template reseed (`seed-engineering.ts`)

- Bump `ENGINEERING_VERSION`.
- Each step now has `{ id, ordinal, name, instructions, outputSchema }`.
- `intake` instructions = the grill-me skill text (interview relentlessly, one question at
  a time, recommend an answer for each, explore the codebase when a question is
  answerable that way, finish when shared understanding is reached). `intake.outputSchema`
  = the goal-brief fields (e.g. `problem`, `success_outcome`, `constraints` (array),
  `relevant_workspaces` (array), `open_questions` (array)).
- Other steps (`research`, `prd`, …) get placeholder instructions + minimal output schemas
  so the template validates. Real authoring of those is a follow-up.
- Template-level `guardrails` are retained as-is (they are not step fields). Guardrails
  referencing removed concepts (`appliesToSteps` on validation, `launch_workflow_session`
  approval) become inert in Phase 1 since no agents launch; revisit in Phase 2.

## Error handling

- **Schema-invalid completion:** rejected by `validateProposal`; broker fallback applies.
  If no transport succeeds, retry the `run_step_skill` request once. If it still fails,
  block the run with reason `"step output did not match schema"`.
- **Operator unavailable / not ready:** if no ready model operator exists, block the run
  with a clear reason (surfaced in `OrcaChat` as an action error / banner).
- **Empty / whitespace answer:** existing submit validation already rejects it.
- **Transcript size:** the request payload limit is 64 KiB
  (`ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES`). Cap the interview at a sane turn count
  (e.g. 20) and truncate older turns if the payload would exceed the limit; block with a
  reason if a single turn cannot fit.

## Events

Reused without new event types: `workflow.decision.requested/recorded`,
`workflow.operator.selected`, `workflow.user.input.requested/submitted`,
`workflow.artifact.created`, `workflow.recommendation.created/accepted`. The
`run_step_skill` kind rides existing transport attempt events. No new event type is
required; `interview_turn` and `step_output` are ordinary `workflow.artifact.created`
events.

## Testing

Unit tests (stub the broker — no live LLM), mirroring existing
`service`/`steps`/`seed` test patterns:

- input resolution (ordinal 0 = goal description; ordinal N = prior `step_output`);
- operator routing returns a model operator; agent operators filtered out;
- `ask` path records a `request_user_input` decision with the operator's question;
- submit creates an `interview_turn` artifact pairing last question + answer; auto-advance
  fires the next turn;
- transcript reconstruction order;
- `complete` path validates output, creates `step_output`, emits `advance_step`;
- last step `complete` emits `mark_run_complete`;
- schema-mismatch completion is rejected → fallback → block-after-retry;
- contracts: `WorkflowStepTemplate` accepts `{id, ordinal, name, instructions,
  outputSchema}` and rejects the removed fields; `outputSchema` min-1-field enforced;
- seed: Engineering template validates under the new shape.

## Open questions

- Exact grill-me instruction wording and intake `outputSchema` fields — settle during
  implementation against the live loop.
- Whether operator selection should be re-evaluated mid-step if the chosen model becomes
  unavailable — Phase 1 assumes select-once; revisit if it bites.

## Phase 2 (out of scope, recorded for continuity)

- Agent-operator execution: route to claude-code/codex/opencode, run instructions as a
  session objective, and synthesize a schema-conforming `step_output` from the session
  result.
- Production instructions for all Engineering steps.
- Cleanup of now-unused artifact types and inert guardrails.
