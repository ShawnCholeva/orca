# Instruction-Driven Workflow Steps — Phase 1 Design

**Date:** 2026-05-27
**Status:** Approved with required amendments incorporated, pre-implementation
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
- Completion is **operator-judged but accountable**: the executing operator decides when
  it is done, but must return a completion self-check (confidence, assumptions, open
  questions) alongside the output, and the output is validated against `outputSchema`.
- The structured output of step N becomes part of step N+1's input. Step 0's input is the
  goal description. Every step also receives the goal and all prior step outputs (see the
  execution envelope), so later steps never lose original context.
- Cross-vendor routing is demonstrated at the **model** level: a Claude orchestrator may
  route a step to Gemini or GPT.
- Every transition is evented, **idempotent**, replayable, and inspectable.
- The Engineering `intake` step is reseeded as a grill-me skill and runs end-to-end.

## Non-Goals (deferred to Phase 2)

- Routing to **agent operators** (claude-code, codex, opencode PTY sessions) and
  synthesizing schema-conforming output from a free-form agent session.
- Full JSON Schema support. Phase 1 uses a lightweight field-list schema with `itemType`
  and one level of nested `fields`.
- Model operators having codebase retrieval / tool access. Phase 1 model operators use
  provided workspace context if present, otherwise ask the user.
- A static template pipeline-compatibility validator (output of step N vs. assumptions of
  step N+1). The richer runtime envelope removes the immediate need; revisit later.
- Template-level human-review gates between steps.

## Authoring model vs. engine model

These are deliberately different surfaces:

- **Authoring (what the user edits in the UI):** `instructions`, `outputSchema`. Plus
  `name` for display. `id`/`ordinal` are managed by the editor.
- **Engine (runtime state, not authored):** the resolved step input envelope, the selected
  operator (projected, see below), the interview transcript, the structured output
  artifact, and the hand-off to the next step. The engine understands more than the two
  authored fields; the user is not asked to specify any of it.

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

A lightweight, dependency-free schema (no `ajv`) with element typing and shallow nesting:

```ts
WorkflowStepOutputField: z.ZodType = z.lazy(() => z.object({
  key: z.string().min(1).max(64),
  type: z.enum(["string", "number", "boolean", "array", "object"]),
  required: z.boolean(),
  description: z.string().max(256).optional(),
  // when type === "array": element type
  itemType: z.enum(["string", "number", "boolean", "object"]).optional(),
  // when type === "object", or type === "array" && itemType === "object": nested fields
  fields: z.array(WorkflowStepOutputField).max(32).optional(),
}).strict())

WorkflowStepOutputSchema = z.array(WorkflowStepOutputField).min(1).max(32)
```

**Validation of an operator's output** (manual, deterministic):
- every `required` key present;
- each present key's runtime type matches its declared `type`;
- for `type: "array"` with `itemType`, every element matches `itemType`;
- for `object` (and `array` of `object`) with `fields`, validate each element/object
  against the nested `fields`.
- **Nesting depth is capped at 2** (top-level fields → one level of nested `fields`).
  Deeper structures are accepted as opaque `object`/`array` without recursive checks.

### `WorkflowArtifactType` (extend enum)

Add:
- `step_output` — JSON body, the structured result of a step (conforms to that step's
  `outputSchema`). Linked to the producing `stepRunId`. **At most one valid `step_output`
  per step run.**
- `interview_turn` — JSON body (see identity fields below), one persisted turn of an
  interview. Linked to the producing `stepRunId`.

Existing artifact types (`goal_brief`, `prd`, …) are retained for now but are no longer
produced by the intake path; cleanup of unused types is out of scope for Phase 1.

### `interview_turn` body

```ts
InterviewTurn = {
  turnIndex: number,            // 0-based, monotonic per step run
  questionDecisionId: string,   // the request_user_input decision this answers
  question: string,
  answer: string,
  answeredAt: string,           // ISO datetime
}
```

### `WorkflowStepRun` projection (extend)

Add explicit, deterministic operator-selection fields (events remain source of truth, but
the projection makes runtime decisions deterministic across retries/replays/fallbacks):

```ts
selectedOperatorId?: string,
selectedProviderId?: ModelProviderId,
selectedModelId?: string,
operatorSelectedAt?: string,    // ISO datetime
```

Remove `satisfiedExitCriteria` / `outstandingExitCriteria` (no exit criteria). Step run
still tracks `status`, `ordinal`, `attempt`, timestamps, `blockedReason`.

### `OperatorDescriptor` (extend)

Add provider/model identity so the engine never parses them out of the operator id string:

```ts
providerId?: ModelProviderId,   // present for kind: "model"
modelId?: z.string().min(1).max(80),
```

### `OrchestrationDecisionKind` (extend enum)

Add `run_step_skill`. Remove `evaluate_exit_criteria` (no exit criteria anymore).

### `StepSkillProposal` (new envelope payload)

The operator's response for a `run_step_skill` request:

```ts
StepSkillProposal = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ask"),
    question: z.string().min(1).max(2000),
    rationale: z.string().max(1000).optional(),
  }),
  z.object({
    action: z.literal("complete"),
    output: z.record(z.unknown()),
    completion: z.object({
      confidence: z.enum(["low", "medium", "high"]),
      assumptions: z.array(z.string().max(500)).max(20),
      openQuestions: z.array(z.string().max(500)).max(20),
      whyComplete: z.string().max(1000),
    }),
  }),
])
```

`complete.output` is then checked against the step's `outputSchema`. The `completion`
self-check is persisted on the `step_output` artifact (in its JSON body under a
`_completion` key) and surfaced to the user.

### `SubmitWorkflowUserInputRequest` (amend)

Add a required `questionDecisionId` for instruction-driven steps so an answer is paired
with the exact question it answers (idempotency + correctness):

```ts
questionDecisionId: Id,   // the request_user_input decision being answered
```

## Step execution input envelope

Every `run_step_skill` request carries a full envelope, not just the previous output, so
later steps retain the goal and all prior context:

```ts
StepExecutionInput = {
  goal: { id: string, description: string },
  currentStep: { id, ordinal, name, instructions, outputSchema },
  previousStepOutput: unknown | null,        // step N-1's step_output body, or null at ordinal 0
  priorStepOutputs: Array<{ stepId, stepName, output: unknown }>,  // all earlier outputs in order
  transcript: InterviewTurn[],               // this step's interview so far
}
```

At ordinal 0, `previousStepOutput` is `null` and the operator works from
`goal.description`. Conceptually "step N's output becomes step N+1's input", but the
actual model payload is this envelope.

## Engine: per-step lifecycle

Implemented in `apps/daemon/src/workflows/orchestrator/service.ts`,
`requestNextDecision`. The deterministic block (rule satisfaction, `missingInputs`,
`outstanding`/exit-criteria, `gateType` branch) is removed and replaced by:

```
if a valid step_output already exists for the current step:
    -> advance (intermediate) or emit mark_run_complete recommendation (final)
elif this step has an active unanswered request_user_input decision:
    -> no-op (waiting on the user); return current state
elif no operator selected for this step yet:
    -> selectOperator        (orchestrator LLM routes among ready model operators)
else:
    -> runStepSkill          (selected operator executes instructions)
```

### 1. Resolve input

Build the `StepExecutionInput` envelope (above).

### 2. Select operator (routing)

- Reuse the existing `select_operator` decision + `operatorSelector` + `broker` +
  `workflow.operator.selected` event.
- Selection input is the step's `instructions`, the input envelope, and the list of
  **ready model operators** (`OperatorDescriptor` with `kind: "model"`). It returns the
  chosen operator id + reason.
- On selection, **project** `selectedOperatorId/ProviderId/ModelId/operatorSelectedAt`
  onto the step run. Provider/model come from the chosen `OperatorDescriptor` fields (no
  string parsing).
- Phase 1 restricts candidates to `kind: "model"`. Agent operators are filtered out.

### 3. Run step skill (execution)

- Use the step run's projected `selectedProviderId`/`selectedModelId`.
- Call `broker.propose({ kind: "run_step_skill", goalId, workflowRunId, stepRunId,
  providerId, modelId, payload: StepExecutionInput }, { validateProposal })`.
  - `validateProposal` parses `StepSkillProposal`; if `action: "complete"`, it also runs
    the `outputSchema` check. A schema-invalid completion is rejected (triggers broker
    fallback / retry; see Error handling).
- On parsed result:
  - **`ask`** → record a `request_user_input` decision (question = `proposal.question`)
    and the existing `request_user_input` recommendation. Renders as the input card in
    `OrcaChat`. `commitUserInputDecision` is generalized to accept an explicit question.
  - **`complete`** → create the `step_output` artifact (JSON body = `proposal.output`
    plus `_completion`), then:
    - **intermediate step** → **auto-advance**: create the next step run and request its
      decision in the same flow. No user click, no advance recommendation.
    - **final step** → emit a `mark_run_complete` recommendation requiring user
      acceptance (goal-completion safety; preserves the existing mark-done guardrail).

### 4. Answer persistence + auto-advance (`apps/daemon/src/workflows/steps/routes.ts`)

- The submit route already calls `requestNextDecision` after a user answer, so the loop
  advances.
- For instruction-driven steps, the submit route no longer calls
  `evaluateUserInputAsArtifact`. Instead it:
  - requires `questionDecisionId` and verifies it is the step run's active unanswered
    `request_user_input` decision;
  - creates an `interview_turn` artifact `{ turnIndex, questionDecisionId, question,
    answer, answeredAt }` (question read from that decision; `turnIndex` = count of
    existing turns). Secret redaction (`redactSecrets`) is preserved.

### 5. Hand-off

- The next `requestNextDecision` for the new step resolves its input envelope and repeats
  from step 2.

## Idempotency rules

These are required and tested:

- A step run has **at most one active unanswered** `request_user_input` decision. If one
  exists, `requestNextDecision` does not call `run_step_skill` and does not create a new
  question.
- A user answer **must reference** the `request_user_input` decision it answers
  (`questionDecisionId`); a mismatched or already-answered id is rejected.
- A `request_user_input` decision produces **at most one** `interview_turn` artifact
  (keyed by `questionDecisionId`).
- A step run produces **at most one valid** `step_output` artifact. If one exists,
  `requestNextDecision` must not call `run_step_skill` again — it advances instead.
- `advance_step` (intermediate auto-advance creating the next step run) and
  `mark_run_complete` recommendations are **deduped per producing `step_output`**.

## Removals

- Delete the `StepRule` registry and all rule files
  (`apps/daemon/src/workflows/steps/rules/*`).
- Remove `nextQuestion`, `evaluateUserInputAsArtifact`, `evaluateArtifactSatisfies`,
  `evaluateGoalContextSatisfies`, `onArtifactCreated`, `evaluateSessionSummarySatisfies`.
- Remove deterministic satisfaction / `missingInputs` / `outstanding` / exit-criteria /
  `gateType` logic from `requestNextDecision`.
- Remove the removed step fields and step-run exit-criteria fields from DB projections,
  seed data, contracts, UI, and tests (incl. the `WorkflowBanner` / `StepTimeline`
  exit-criteria display).

## UI changes

- `apps/desktop/src/workflows/StepEditor.tsx`: reduce to two inputs — an **Instructions**
  textarea and an **Output schema** editor (repeatable rows of `key`, `type` select,
  `required` checkbox, optional `description`, plus `itemType` when `type` is `array` and
  a nested-fields control when `object`). Remove editors for the deleted fields.
- `TemplateDetail.tsx` / `WorkflowsPage.tsx`: drop display of removed fields.
- `OrcaChat`: the input card already handles `request_user_input`; pass the active
  `questionDecisionId` through on submit. When a `step_output` is created, show its
  `_completion` self-check (confidence + remaining assumptions/open questions) so
  completion is visible, not silent. Remove exit-criteria display from `WorkflowBanner`.

## Engineering template reseed (`seed-engineering.ts`)

- Bump `ENGINEERING_VERSION`.
- Each step now has `{ id, ordinal, name, instructions, outputSchema }`.
- `intake` instructions = the grill-me skill text. Codebase-exploration wording, adjusted
  for a Phase 1 model operator without tool access:

  > Interview the user relentlessly about this goal until you reach shared understanding,
  > walking each branch of the decision tree and resolving dependencies one at a time. Ask
  > one question at a time. For each question, provide your recommended answer. When a
  > question may be answerable from attached workspace context, first use the available
  > workspace summaries or snippets; if no trustworthy workspace context is available, ask
  > the user directly instead of pretending to know. Complete only when the brief is
  > unambiguous; report remaining assumptions and open questions in the completion
  > self-check.

  `intake.outputSchema` = goal-brief fields: `problem` (string, required),
  `success_outcome` (string, required), `constraints` (array<string>, required),
  `relevant_workspaces` (array<string>), `open_questions` (array<string>).
- Other steps (`research`, `prd`, …) get placeholder instructions + minimal output schemas
  so the template validates. Real authoring of those is a follow-up.
- Template-level `guardrails` are retained as-is (not step fields). Guardrails referencing
  removed concepts become inert in Phase 1; revisit in Phase 2.

## Error handling

- **Schema-invalid completion:** rejected by `validateProposal`; broker fallback applies.
  If no transport succeeds, retry the `run_step_skill` request once. If it still fails,
  block the run with reason `"step output did not match schema"`.
- **Low-confidence completion:** accepted (the run advances) but the `_completion` block
  is surfaced prominently; not blocked in Phase 1.
- **Bad / empty question from operator:** `StepSkillProposal` requires a non-empty
  question (min 1 char). A parse failure is treated like any invalid proposal → fallback →
  retry once → block with reason.
- **Operator unavailable / not ready:** if no ready model operator exists, block the run
  with a clear reason (surfaced in `OrcaChat`).
- **Empty / whitespace answer:** existing submit validation rejects it.
- **Transcript size:** request payload limit is 64 KiB
  (`ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES`). Cap the interview at 20 turns and truncate
  oldest turns if the payload would exceed the limit; block with a reason if a single turn
  cannot fit.

## Events

Reused without new event types: `workflow.decision.requested/recorded`,
`workflow.operator.selected`, `workflow.user.input.requested/submitted`,
`workflow.artifact.created`, `workflow.recommendation.created/accepted`. The
`run_step_skill` kind rides existing transport-attempt events. `interview_turn` and
`step_output` are ordinary `workflow.artifact.created` events.

## Testing

Unit tests (stub the broker — no live LLM), mirroring existing
`service`/`steps`/`seed` test patterns:

- input envelope construction (goal + previousStepOutput + priorStepOutputs + transcript);
- operator routing returns a model operator with projected provider/model; agents filtered;
- `ask` path records a `request_user_input` decision with the operator's question;
- submit requires/validates `questionDecisionId`; creates one `interview_turn` with correct
  `turnIndex`; rejects mismatched/duplicate decision ids; auto-advances next turn;
- transcript reconstruction order;
- `complete` path validates output, creates a single `step_output` (with `_completion`),
  intermediate → auto-advance to next step run, final → `mark_run_complete` recommendation;
- output schema validation: required keys, primitive types, `array<itemType>`, nested
  `fields`, depth cap;
- schema-mismatch completion → fallback → block-after-retry;
- idempotency: duplicate `requestNextDecision` does not double-create questions, turns,
  step_outputs, or advance recommendations;
- contracts: `WorkflowStepTemplate` accepts the new shape and rejects removed fields;
  `outputSchema` min-1-field; `StepSkillProposal` parsing; `OperatorDescriptor`
  provider/model fields;
- seed: Engineering template validates under the new shape.

## Implementation readiness checklist

- [x] `interview_turn` has `turnIndex` + `questionDecisionId`.
- [x] Explicit idempotency rules defined.
- [x] `selectedOperatorId`/provider/model projected onto `WorkflowStepRun`.
- [x] Provider/model come from `OperatorDescriptor`, not id-string parsing.
- [x] Step execution input is a richer envelope (goal + prior outputs + transcript).
- [x] Array/object schema validation strengthened (`itemType`, nested `fields`, depth 2).
- [x] Bad-question handling defined.
- [x] Low-confidence completion handling defined.
- [x] `advance_step` auto-accepted for intermediate steps; final step confirmed.
- [x] Model operators' codebase access clarified (workspace context if present, else ask).

## Open questions

- Exact grill-me wording and intake `outputSchema` fields — refine against the live loop.
- Whether to add a static template pipeline-compatibility pass later (output of N vs.
  assumptions of N+1) — deferred; the runtime envelope covers Phase 1.

## Phase 2 (out of scope, recorded for continuity)

- Agent-operator execution: route to claude-code/codex/opencode, run instructions as a
  session objective, and synthesize a schema-conforming `step_output` from the session.
- Production instructions for all Engineering steps.
- Codebase retrieval/tool access for model operators.
- Optional static pipeline-compatibility validation.
- Cleanup of now-unused artifact types and inert guardrails.
