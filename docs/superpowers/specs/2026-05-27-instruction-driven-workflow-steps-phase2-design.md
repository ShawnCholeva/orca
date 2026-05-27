# Instruction-Driven Workflow Steps — Phase 2 Design

**Date:** 2026-05-27
**Status:** Approved design, pre-implementation. Implementation plan intentionally deferred
until Phase 1 ships (Phase 1 may change details this spec depends on).
**Scope:** Phase 2 — agent-operator execution, structured-output synthesis, agent
mid-run interview, approval-gated launches, and (separable) model-operator codebase
retrieval.
**Builds on:** `docs/superpowers/specs/2026-05-27-instruction-driven-workflow-steps-design.md`
(Phase 1).

## Context

Phase 1 made workflow steps instruction-driven: a step is authored as
`(instructions, outputSchema)`, the orchestrator routes it to a **model** operator, the
model runs the instructions (interviewing the user via an `ask`/`complete` loop) and emits
a schema-validated `step_output` that chains to the next step. Phase 1 deliberately
excluded **agent operators** (Codex, Claude Code, opencode PTY sessions) and any way for a
model to actually inspect the codebase.

Phase 2 closes those gaps so the orchestrator can route a step to whichever operator —
model **or** agent — best fits its instructions, which is the core cross-vendor
orchestration premise (e.g. a Claude orchestrator routing an Execution step to a GPT-5.3
Codex agent that edits the repo).

## Goals

- The orchestrator routes each step across **all** ready operators (model + agent), not
  just models, choosing by the step's `instructions` + input envelope.
- An **agent operator** executes a step by running its `instructions` as a session
  objective in a real PTY session (reusing Orca's session manager and the existing
  `launch_workflow_session` flow), and the step finishes with a schema-conforming
  `step_output`.
- The structured output of an agent step is obtained by **hybrid parse-then-synthesize**:
  prefer a JSON block the agent emits matching `outputSchema`; otherwise a model operator
  synthesizes the output from the session result + schema.
- During an agent step, the orchestrator can **pause the agent to ask the user structured
  questions** (the Phase 1 `ask`/`complete` input card), feeding answers back into the
  session.
- Launching a code-editing agent is **gated by the `approval_launch_agent` guardrail**:
  agent steps require user approval before the session launches; model steps stay auto.
  The gate is configurable (a higher-autonomy template may disable it).
- **Separable workstream:** model operators gain **codebase retrieval** (workspace
  summaries / snippets in the input envelope) so grill-me-style steps can actually explore
  instead of only asking the user.
- All Engineering steps get **production instructions + output schemas** (Phase 1 left
  non-intake steps as placeholders).

## Non-Goals

- Full autonomous execution (Level 5). Agent launches remain supervised by default.
- Multi-agent concurrency beyond the existing `concurrency_one` guardrail
  (max one execution agent at a time).
- A vector database / embeddings service for retrieval. Phase 2 retrieval uses existing
  workspace + memory data; richer indexing is later.
- Replacing the native agent terminal UX. Orca wraps agents; it does not reimplement them.

## Workstream A — Agent-operator execution

### A1. Routing across model + agent operators

- Remove the Phase 1 `kind: "model"` filter in the orchestrator's operator-selection step.
  Candidate set = all **ready** `OperatorDescriptor`s (model + agent), minus any excluded
  by the `allowed_operators` guardrail.
- The orchestrator LLM picks the best operator from the step `instructions` + input
  envelope + the candidate descriptors (which already expose `kind`,
  `supportsRepoEditing`, `supportsTerminal`, `capabilities`, and the Phase 1
  `providerId`/`modelId` for models). Selection is persisted on the step run via the
  Phase 1 `selectedOperatorId/...` fields (extended to allow agent operator ids).
- A step whose selected operator has `kind: "agent"` follows the **agent execution
  lifecycle** (A2); a `kind: "model"` operator follows the Phase 1 model loop unchanged.

### A2. Agent step execution lifecycle

```
select operator (agent) -> persist selection
  -> if approval_launch_agent guardrail active:
       emit launch_workflow_session recommendation  (user approves)
     else:
       launch directly
  -> launch workflow session: objective = step instructions,
     context = StepExecutionInput envelope (+ retrieval context if available)
  -> session runs (native agent UX). Mid-run structured questions: see A4.
  -> on session completion:
       collect session result (summary + emitted output block, if any)
       -> synthesize step_output (A3)
       -> validate against outputSchema
            valid   -> store step_output (linkedSessionId = session id) -> advance/complete
            invalid -> retry synthesis once -> else block run "step output did not match schema"
```

- Reuse the existing `launch_workflow_session` recommendation + `CreateSessionDialog`
  prefill path (`OrcaChat` already constructs `CreateSessionPrefill` with `adapterId`,
  `role`, `objective`, `workflowStepRunId`, `fromRecommendationId`).
- The launched session is linked to the step run (`workflowStepRunId`), so completion can be
  correlated back to the step.
- Concurrency respects the existing `concurrency_one` guardrail.

### A3. Structured-output synthesis (hybrid parse-then-synthesize)

1. **Parse:** the agent's `instructions` are augmented (by the engine, at dispatch time)
   with a trailing convention:
   > When finished, emit your structured result as a single fenced block:
   > ```` ```orca-output\n{ ...JSON matching the requested schema... }\n``` ````
   On session completion, the engine extracts the last `orca-output` block, JSON-parses it,
   and validates against `outputSchema`. If valid → use it (no model call).
2. **Synthesize (fallback):** if the block is missing or invalid, issue a
   `synthesize_step_output` request to a **model** operator (the goal's orchestrator model)
   with payload `{ sessionResult, outputSchema, stepInput }`; the model returns an object
   validated against `outputSchema`.
3. The chosen output is stored as a `step_output` artifact with `source: "agent"` (parse
   path) or `source: "orchestrator"` (synthesis path) and `linkedSessionId` set.

`sessionResult` = the session summary + a bounded tail of session output (reuse the
existing session-summary mechanism and `ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES`-style
bound). Raw full transcripts are never sent (Phase 1 context-efficiency principle).

### A4. Agent + orchestrated interview (mid-run structured questions)

This is the most complex piece and is a candidate for its own implementation sub-phase.

- The agent session signals "I need a structured decision from the user" via a hook /
  sentinel in its output (reuse the worker-hook infrastructure:
  `WorkerHookTrace`, `OrchestrationWorkerState: "awaiting_input"`,
  `supportsPromptHooks`/`supportsStateHooks`). For agents without hook support, this
  feature is unavailable and the agent simply uses its native terminal prompt instead.
- On the signal, the orchestrator surfaces a Phase 1 `request_user_input` decision +
  input card (same UI), recording an `interview_turn` artifact on answer.
- The answer is injected back into the session (written to the session's stdin / resumed
  via the adapter), and the agent continues.
- The step still completes via A2/A3 (the interview does not replace synthesis; it informs
  the agent mid-run).

### A5. Launch approval via guardrail

- When the selected operator is an agent and the `approval_launch_agent` guardrail is
  active for the template, the engine emits a `launch_workflow_session` recommendation and
  **waits** (no launch) until the user accepts. This is the existing guardrail
  (`configJson.actions: ["launch_workflow_session"]`) — no new guardrail type.
- If the guardrail is absent/disabled (higher-autonomy template), the engine launches the
  session directly.
- Model steps are never gated by this guardrail (they don't launch sessions).

## Workstream B — Codebase retrieval for model operators (separable)

Independently buildable; can be split into its own plan.

- Extend the `StepExecutionInput` envelope with an optional `workspaceContext`:
  ```ts
  workspaceContext?: {
    workspaces: Array<{ id: string; name: string; root: string }>;
    summaries: Array<{ workspaceId: string; summary: string }>;   // from goal memory
    snippets?: Array<{ path: string; excerpt: string }>;          // optional, bounded
  }
  ```
- Source: the goal's attached workspaces + existing Goal memory (architecture notes,
  session summaries). Phase 2 does **not** add embeddings; `snippets` is best-effort from
  what memory already holds.
- The grill-me intake instructions' "use available workspace context" clause becomes real:
  a model can answer a question from `workspaceContext` instead of asking the user.
- Bounded by the 64 KiB request payload limit; truncate summaries/snippets to fit.

## Workstream C — Production step instructions

- Author real `instructions` + `outputSchema` for `research`, `prd`, `issue_breakdown`,
  `execution`, `qa`, `review`, `done` (Phase 1 shipped placeholders).
- `execution` is the first natural **agent** step (code editing); its `outputSchema` should
  capture `changed_files` (array<string>), `validation` (object: ran/passed/skipped +
  reason), `summary` (string), `blocked` (boolean + reason).
- Bump `ENGINEERING_VERSION` again.
- This workstream is content, not engine; it can land incrementally per step.

## Workstream D — Optional pipeline-compatibility validation

- Deferred-but-recorded from Phase 1. A static pass over a template that warns when an
  earlier step's `outputSchema` cannot plausibly satisfy a later step's declared input
  assumptions. Phase 1's runtime envelope makes this non-blocking; include only if it
  proves useful in practice. Lowest priority in Phase 2.

## Data model changes

- `OrchestrationDecisionKind` += `synthesize_step_output`.
- `WorkflowArtifact.source` already includes `agent`; `step_output` from the parse path
  uses it.
- `StepExecutionInput` += optional `workspaceContext` (Workstream B).
- `SynthesisRequest` payload (new zod schema): `{ sessionResult: string, outputSchema:
  WorkflowStepOutputSchema, stepInput: StepExecutionInput }`, bounded to the request limit.
- No new event types required: agent launch reuses `launch_workflow_session` recommendation
  + session events; synthesis rides transport-attempt events; mid-run questions reuse
  `workflow.user.input.requested/submitted` + worker-hook traces.
- Operator-selection persistence (Phase 1 `selectedOperatorId` etc.) now also stores agent
  operator ids; `selectedProviderId`/`selectedModelId` are null for agent selections.

## Error handling

- **Agent emits no/invalid output block:** fall back to model synthesis (A3.2).
- **Synthesis output invalid:** retry synthesis once; then block run
  ("step output did not match schema").
- **Session fails / is cancelled / hangs:** mark the step blocked with the session's
  failure reason; surface in `OrcaChat`. Reuse existing session failure states.
- **No ready operator of any kind:** block run with a clear reason.
- **Mid-run interview on a non-hook agent:** feature unavailable; the agent uses native
  prompting; no orchestrated card is shown.
- **Approval never granted:** the run stays paused on the `launch_workflow_session`
  recommendation (no timeout in Phase 2).

## Testing

Unit tests (stub broker, session manager, and synthesis model — no live agents/LLMs):

- routing returns an agent operator when instructions imply code editing; respects
  `allowed_operators`;
- agent step with `approval_launch_agent` active emits a `launch_workflow_session`
  recommendation and does not launch until accepted; disabled guardrail launches directly;
- synthesis parse path: valid `orca-output` block → `step_output` (source `agent`), no model
  call;
- synthesis fallback: missing/invalid block → model synthesis → validated `step_output`
  (source `orchestrator`);
- synthesis invalid twice → run blocked;
- mid-run interview: hook signal → `request_user_input` + `interview_turn` → answer injected
  → session resumes (mock adapter);
- session failure → step blocked with reason;
- Workstream B: `workspaceContext` assembled and truncated to the payload bound; a model can
  resolve a question from context (transcript shows no `ask` when context suffices — stubbed);
- Workstream C: Engineering template validates with production instructions; `execution`
  output schema parses.

## Open questions

- Exact agent "needs input" signal: a stdout sentinel vs. an adapter-specific hook. Resolve
  per adapter when A4 is implemented; design supports either.
- Whether synthesis should always run even when a valid block is present (for consistency)
  — current decision: trust a valid block, synthesize only on miss.
- Whether `execution` results should also create Orca Tasks (issue breakdown → tasks) —
  likely yes, but tracked separately from this spec.

## Recommended decomposition at plan time

Phase 2 is larger than Phase 1 and spans independent concerns. Suggested plan split when
the time comes (after Phase 1 ships):

1. **A1–A3, A5:** agent routing + approval-gated launch + execution + hybrid synthesis
   (the core; delivers agent-executed steps end-to-end).
2. **A4:** agent mid-run orchestrated interview (most complex; isolate it).
3. **Workstream B:** model-operator codebase retrieval.
4. **Workstream C:** production step instructions (incremental, content-only).
5. **Workstream D:** optional pipeline-compatibility validation (only if warranted).

Each sub-plan should produce working, testable software on its own.
