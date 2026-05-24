# Orca — Milestone 8 Implementation Plan

**Source PRD:** `docs/ideas/orca-engineering-workflow-prd.md`
**Supporting design notes:** `docs/ideas/orca-workflow-driven-orchestrator-goal.md`, `docs/ideas/orca-workflow-metrics-goal.md`
**Builds on:** `docs/implementation-plans/milestone-7.md` (M7 must be complete and green).
**Status:** Not started.

**Scope guard.** Tasks below MUST NOT introduce: Level 5 autonomy, auto-launching agents without explicit user approval, per-goal workflow template overrides (templates remain global), visual DAG workflow builders, cross-goal workflows, external GitHub/Jira sync, advanced policy languages, metrics dashboards, self-adapting workflows, agent performance optimization, embedding/vector ranking, raw model prompt/response logging, raw transcript/output-tail reads during workflow orchestration, persistence of provider prompts or responses in domain events, branching/parallel workflow steps (linear only in MVP), workflow templates editable per-goal, prompt template editors as a product surface, generic skill invocation endpoints, multi-agent scheduling, new top-level packages, or any workflow run mutation via WebSocket commands. Any task requiring such code is out of scope for M8 and belongs in a follow-up milestone.

### Inherited constraints from M1 / M2 / M3 / M4 / M5 / M6 / M7

**DaemonContext seam.** All new M8 use cases MUST be wired through the explicit `DaemonContext`. M8 adds: `modelProviderRegistry: ModelProviderRegistry` (provider plugins keyed by id), `operatorSelector: OperatorSelector` (deterministic fallback + LLM-backed default), `workflowEngine: WorkflowEngine` (step lifecycle), `guardrailEvaluator: GuardrailEvaluator`. No DI framework, no container, no decorators.

**Registry immutability (M2).** Adapter, skill, provider, and workflow-template registrations happen before the HTTP listener accepts connections. Built-in Engineering template is seeded at first boot inside an idempotent migration-style step. Custom templates are mutable rows; the Engineering built-in row is read-only at the route layer.

**Native-import isolation (M4).** Only `apps/daemon/src/pty/manager.ts` may `import` `node-pty`. M8 does not touch this.

**Output isolation rule (M4, carried forward).** Terminal output remains persisted only in M4's session output store. M8 workflow orchestration MUST NOT read raw M4 output tails or transcripts. Allowed signal sources: M3 refinement, M3 workspace projection, M4 session row + lifecycle/status fields, M5 session_summaries, M5 memory items, M5 decisions, M6 context packages (id + small metadata), M7 tasks/recommendations/conflicts/feedback rows, M8 workflow runs/step runs/artifacts/decisions/guardrail evaluations.

**Content-free events rule (M5/M6/M7, extended).** All M8 domain events carry ids, status, counts, byte sizes, changed-field keys, and failure codes. They MUST NOT carry workflow artifact bodies, decision-trace `reason` text, operator-selection rationale, guardrail evaluation messages, raw LLM prompts/responses, or raw memory/decision/summary text. 4 KiB per-event payload cap enforced in tests. Workflow decision rows are not events; they may store bounded, redacted `reason` text because decision transparency is an explicit PRD requirement.

**Atomicity rule (carried forward).** Every M8 daemon write that emits domain events MUST insert events and projection rows inside the same SQLite transaction and broadcast on the event bus **only after** `COMMIT` returns. Cross-projection cascades (workflow advancement that creates an artifact AND emits an operator-selection AND writes a decision trace) MUST commit in a single TX.

**Goal-scoped boundary (carried forward).** Every M8 workflow run, step run, artifact, guardrail evaluation, LLM call, and decision row carries `goal_id`. Every list/read is Goal-scoped, including direct-id reads under `/v1/goals/:goalId/...`. Workflow templates are global; template references from runs are checked for read-availability but templates themselves are not Goal-scoped.

**Supervision-only rule (extended from M7).** No M8 endpoint, runner, or rule may auto-launch a session, auto-prepare a context package, auto-run a validation command, or auto-advance a workflow step that requires a `human-approval` gate. The orchestrator emits structured *recommendations* using existing M7 recommendation lifecycle (proposed → accepted) and only the user-approved acceptance executes the corresponding M3/M4/M6/M7 flow.

**Existing wire shapes frozen.** All existing M1-M7 endpoint responses, event names, event payloads, and WebSocket frames remain byte-identical. M8 only adds: new endpoints (Section "API surface" below), new event types (Section "Events"), new tables (Section "Database"), optional `orchestratorProvider` and `orchestratorModel` fields on `CreateGoalRequest`/`Goal`, optional `workflowRunId`, `workflowStepRunId`, `workflowArtifactId` fields on existing M7 task/recommendation/M4 session/M6 context-package writes. Existing event payloads, including `goal.created`, MUST NOT gain fields. Without the optional response/request fields the M1-M7 flows are byte-identical.

The single proof point for M8 is:

```text
User creates a Goal and selects an Orchestrator LLM provider/model
  -> daemon stores provider+model on Goal
  -> user starts an Engineering workflow run from Orchestrator chat
  -> daemon creates workflow_run + first workflow_step_run (Intake) atomically
  -> orchestrator emits intake question via OperatorSelector (uses the Goal's Orchestrator LLM)
  -> user answers; goal_brief artifact persisted; exit criteria satisfied; advance recommendation produced
  -> user accepts advance recommendations; daemon advances run through Research → PRD → Issue Breakdown
  -> Issue Breakdown step writes M7 tasks (origin='generator') linked back to the step run
  -> Execution step recommends launch via M7 recommendation (proposed); user accepts; existing M4/M6 prefill flow runs
  -> session completion writes M5 summary; QA + Review steps consume implementation_result + qa_report artifacts
  -> Done step writes final_summary + memory_update artifacts
  -> every orchestrator decision writes a bounded/redacted workflow_decisions row with influenced-by source refs
  -> Workflows tab shows Engineering template (locked) and any custom templates
  -> Orchestrator chat shows current run state, current step, artifacts, next action, "why this action" decision trace
  -> all state survives daemon restart; in-flight LLM calls reconcile to failure
```

---

## Conventions

- **Task ID:** `M8-NNN` (zero-padded, sequenced for default execution order).
- **Affected Areas:** paths relative to repo root.
- **Validation Steps:** every task lists at least one deterministic command or scenario.
- **No task may exceed its declared scope** even if adjacent work seems easy — additive scope belongs in a follow-up task.
- **Full-suite gates:** `pnpm -r typecheck` and `pnpm -r test` run at **M8-010** (provider+template+run lifecycle complete), **M8-018** (operator selection + decision trace + step rules complete), and **M8-026** (final). Targeted tests run inside every other task.
- **Atomicity rule:** every workflow_run state transition, step_run state transition, artifact creation, decision trace write, guardrail evaluation, and operator selection inserts the row(s) and all associated domain events in **one** SQLite transaction. Broadcast occurs **only after** `COMMIT`.
- **Workflow event helper:** M8 introduces `apps/daemon/src/workflows/events.ts` with `appendWorkflowEvent(...)` as a thin helper around the existing `events` table insert pattern. It MUST insert inside the caller's transaction and return a `DomainEvent` for the caller to stage in `toPublish`; callers publish staged events on `ctx.bus` only after the transaction returns. The snippets below use `appendWorkflowEvent` as shorthand, but implementations MUST preserve the existing post-commit publish pattern from M1-M7.
- **Template versioning:** `workflow_templates` rows include `version` integer. Runs store `template_version_at_start`. Editing a template increments the version on save; historical runs read the version captured at start. Built-in Engineering template is `id='orca/engineering'`, version monotonically increasing across releases.
- **Step-run fingerprint:** `sha256(workflow_run_id + ':' + step_template_id + ':' + attempt)` ensures retry of the same step creates a distinct step_run row.
- **Decision idempotency:** decision id is a UUID; same `(workflow_run_id, step_run_id, decision_type, input_fingerprint)` returns the existing decision row instead of creating a new one within a single trigger evaluation window.
- **LLM call boundaries:** every LLM call goes through `ModelProvider.complete(request)`. The request carries a structured prompt; response is parsed against zod schema before persistence. Failed parse → `failure_code='invalid_output'`; failed network → `failure_code='provider_error'`. **Prompts and raw responses are NEVER persisted** — only `provider_id`, `provider_version`, `model`, `usage_tokens_input?`, `usage_tokens_output?`, `latency_ms`, `failure_code?`, `failure_message?` (≤256 chars after redaction) are stored.
- **Privacy rule:** never log artifact body, decision rationale, operator-selection reason, guardrail evaluation message, LLM prompt, LLM response, memory/decision/summary body, secrets, or workspace file paths. Apply M5's best-effort secret redaction helper to every persisted free-text field at API boundaries (`password=`, `token=`, `api_key=`, `authorization: bearer`).
- **Suggestion-only rule (extended):** the orchestrator produces structured `WorkflowDecision` rows + (for executable actions) M7 recommendation rows. The user accept-flow from M7 is reused; M8 adds NEW M7 recommendation types `advance_workflow_step`, `launch_workflow_session`, `complete_workflow_run`, `mark_artifact_satisfied`, `request_user_input`. No workflow mutation or downstream M3/M4/M6/M7 flow may happen before the user accepts the recommendation. Accepting `launch_workflow_session` returns the `proposedAction` for prefill; accepting `advance_workflow_step` or `complete_workflow_run` executes only the approved workflow-internal transition.
- **Defaults (from the PRD):** workflow template name ≤ 100 chars; description ≤ 2 KiB; step purpose ≤ 1 KiB; guardrail label ≤ 100 chars; artifact title ≤ 256 chars; artifact body ≤ 64 KiB; decision reason ≤ 1 KiB; operator-selection rationale ≤ 2 KiB; influenced-by entries ≤ 32 per decision; per-event payload ≤ 4 KiB; failure message ≤ 256 chars; operator-selection alternatives considered ≤ 8.
- **Operators considered registered when:** the underlying adapter is registered in M2's adapter registry AND (for agent adapters) the M4 readiness check returns `ready` OR (for model operators) the corresponding ModelProvider is registered AND has a stored API key OR (for `human`) is always available.
- **ACP/A2A compatibility note.** ACP/A2A is a follow-up adapter target, not a hard M8 dependency. M8 MUST keep `OperatorRegistry`, `OperatorDescriptor`, session/result association fields, and operator-selection inputs protocol-neutral so a future ACP-backed operator can be registered without changing workflow tables. Borrow ACP-compatible concepts now where they are cheap and internal: manifest-like operator metadata, input/output MIME/content-type capabilities, run lifecycle mapping, async/stream readiness, and an `awaiting`/resume mental model for `request_user_input`. Do not expose ACP routes as Orca's internal workflow API in M8.
- **Execution assignment format:** each task declares `Model` and `Effort`. Use `GPT Codex 5.3` for code-heavy implementation, tests, and repo edits; `GPT 5.5` for high-risk architecture/contract/orchestration reasoning; `GPT 5.4` for bounded UI/docs/content tasks. Effort is `medium` or `high` only.

---

## Tasks

---

### M8-000 — Baseline Verification

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Lock in a known-good M1-M7 baseline before any M8 change lands. Establishes the regression anchor so every later M8 failure is unambiguously attributable to M8 work, and so the M8-010, M8-018, and M8-026 gates can compare against a recorded green state.

**Scope.**
- IS: install, typecheck, run tests, record commit SHA and test summary, verify named M1-M7 regression anchors PASS, record pre-existing dirty paths.
- IS NOT: any code change, dependency upgrade, new test, doc edit, or migration.

**Requirements.**
- From a clean working tree, run:
  - `pnpm install --frozen-lockfile`
  - `pnpm -r typecheck`
  - `pnpm -r test`
- Confirm the following named tests appear in the test summary as PASS:
  - the M1 integration anchor (Goal CRUD + live events);
  - the M2 plugin/skill registry test;
  - the M3 Goal-with-workspaces integration test;
  - the M4 session lifecycle integration test (final M4 anchor);
  - the M5 daemon proof-loop integration test (final M5 anchor);
  - the M6 daemon proof-loop integration test (final M6 anchor);
  - the M7 orchestration-loop integration test (final M7 anchor).
- Record in `docs/implementation-plans/notes/m8-000-baseline.md`:
  - `git rev-parse HEAD`;
  - final test summary line counts (typecheck + test);
  - pre-existing dirty paths from `git status` (do not attribute them to M8).

**Affected Areas.** None — verification only. New file: `docs/implementation-plans/notes/m8-000-baseline.md`.

**Validation Steps.**
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` exits 0 with all M1-M7 anchors PASS.
- Notes file committed.

**Acceptance Criteria.**
- Baseline SHA, test counts, and dirty-path list captured in the notes file.

---

### M8-001 — Shared Contracts: Workflow Templates, Runs, Artifacts, Guardrails, Decisions, Operator Selection, Provider Config

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Define the cross-process schemas that the daemon, desktop, and tests share. All payloads validated with zod; types exported.

**Scope.**
- IS: zod schemas + TypeScript types for every M8 entity, request/response shapes for new endpoints, M8 event-name literals, optional-field extensions on existing M1-M7 contracts.
- IS NOT: persistence, HTTP handlers, UI, runtime behavior.

**Requirements.**

Add to `packages/contracts/src/index.ts` (or create per-domain files under `packages/contracts/src/workflows/` if the diff exceeds ~600 lines):

```ts
// === Enums ===

export const WorkflowStepGateType = z.enum([
  "automated",
  "human-approval",
  "human-input",
  "validation",
]);
export type WorkflowStepGateType = z.infer<typeof WorkflowStepGateType>;

export const WorkflowArtifactType = z.enum([
  "goal_brief",
  "open_questions",
  "research_summary",
  "prd",
  "issue_breakdown",
  "implementation_result",
  "test_report",
  "qa_report",
  "review_report",
  "final_summary",
  "memory_update",
]);
export type WorkflowArtifactType = z.infer<typeof WorkflowArtifactType>;

export const WorkflowRunStatus = z.enum([
  "active",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

export const WorkflowStepRunStatus = z.enum([
  "pending",
  "active",
  "blocked",
  "passed",
  "failed",
  "skipped",
]);
export type WorkflowStepRunStatus = z.infer<typeof WorkflowStepRunStatus>;

export const OperatorKind = z.enum(["agent", "model", "human"]);
export type OperatorKind = z.infer<typeof OperatorKind>;

export const ModelProviderId = z.enum([
  "orca/anthropic",
  "orca/openai",
  "orca/google-gemini",
]);
export type ModelProviderId = z.infer<typeof ModelProviderId>;

export const WorkflowDecisionType = z.enum([
  "start_workflow",
  "advance_step",
  "select_operator",
  "request_artifact",
  "request_user_input",
  "evaluate_exit_criteria",
  "evaluate_guardrail",
  "mark_run_complete",
  "block_run",
]);
export type WorkflowDecisionType = z.infer<typeof WorkflowDecisionType>;

export const WorkflowInfluenceKind = z.enum([
  "workflow_step",
  "guardrail",
  "artifact",
  "task_state",
  "operator_readiness",
  "user_input",
  "memory",
  "decision",
  "session_summary",
]);
export type WorkflowInfluenceKind = z.infer<typeof WorkflowInfluenceKind>;

export const WorkflowInfluenceEffect = z.enum([
  "required",
  "blocked",
  "preferred",
  "disallowed",
  "satisfied",
  "missing",
]);
export type WorkflowInfluenceEffect = z.infer<typeof WorkflowInfluenceEffect>;

export const GuardrailKind = z.enum([
  "approval_required",
  "allowed_operators",
  "risk_rule",
  "validation_rule",
  "context_rule",
  "concurrency_rule",
  "cost_speed_preference",
]);
export type GuardrailKind = z.infer<typeof GuardrailKind>;

// === Workflow template ===

export const WorkflowGuardrailConfig = z.object({
  id: z.string().min(1).max(100),
  kind: GuardrailKind,
  label: z.string().min(1).max(100),
  configJson: z.unknown().refine((v) => JSON.stringify(v).length <= 2048, "guardrail config exceeds 2 KiB"),
});
export type WorkflowGuardrailConfig = z.infer<typeof WorkflowGuardrailConfig>;

export const WorkflowStepTemplate = z.object({
  id: z.string().min(1).max(100),
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).max(100),
  purpose: z.string().max(1024),
  requiredInputs: z.array(WorkflowArtifactType).max(20),
  requiredOutputs: z.array(WorkflowArtifactType).max(20),
  gateType: WorkflowStepGateType,
  recommendedCapabilities: z.array(z.string().min(1).max(80)).max(20),
  validationExpectations: z.array(z.string().min(1).max(256)).max(20),
  exitCriteria: z.array(z.string().min(1).max(256)).max(20),
  recommendedOperatorIds: z.array(z.string().min(1).max(100)).max(10),
});
export type WorkflowStepTemplate = z.infer<typeof WorkflowStepTemplate>;

export const WorkflowTemplate = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().max(2048),
  version: z.number().int().nonnegative(),
  isBuiltIn: z.boolean(),
  isLocked: z.boolean(),
  steps: z.array(WorkflowStepTemplate).min(1).max(20),
  guardrails: z.array(WorkflowGuardrailConfig).max(20),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplate>;

// === Workflow run / step run ===

export const WorkflowRun = z.object({
  id: z.string(),
  goalId: z.string(),
  templateId: z.string(),
  templateVersion: z.number().int().nonnegative(),
  status: WorkflowRunStatus,
  currentStepRunId: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  blockedReason: z.string().max(256).nullable(),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;

export const WorkflowStepRun = z.object({
  id: z.string(),
  goalId: z.string(),
  workflowRunId: z.string(),
  stepTemplateId: z.string(),
  ordinal: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  status: WorkflowStepRunStatus,
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  blockedReason: z.string().max(256).nullable(),
  satisfiedExitCriteria: z.array(z.string().min(1).max(256)).max(20),
  outstandingExitCriteria: z.array(z.string().min(1).max(256)).max(20),
});
export type WorkflowStepRun = z.infer<typeof WorkflowStepRun>;

// === Artifacts ===

export const WorkflowArtifact = z.object({
  id: z.string(),
  goalId: z.string(),
  workflowRunId: z.string().nullable(),
  stepRunId: z.string().nullable(),
  type: WorkflowArtifactType,
  title: z.string().min(1).max(256),
  body: z.string().max(65536),
  source: z.enum(["user", "agent", "orchestrator", "system"]),
  linkedSessionId: z.string().nullable(),
  linkedTaskId: z.string().nullable(),
  linkedContextPackageId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type WorkflowArtifact = z.infer<typeof WorkflowArtifact>;

// === Operator selection ===

export const OperatorSelection = z.object({
  operatorId: z.string().min(1).max(100),
  operatorKind: OperatorKind,
  reason: z.string().max(2048),
  requiredCapabilities: z.array(z.string().min(1).max(80)).max(20),
  alternativesConsidered: z.array(z.string().min(1).max(100)).max(8),
  confidence: z.number().min(0).max(1),
  requiresUserApproval: z.boolean(),
});
export type OperatorSelection = z.infer<typeof OperatorSelection>;

// === Decision trace ===

export const WorkflowDecisionInfluence = z.object({
  kind: WorkflowInfluenceKind,
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(128),
  effect: WorkflowInfluenceEffect,
});
export type WorkflowDecisionInfluence = z.infer<typeof WorkflowDecisionInfluence>;

export const WorkflowDecisionTrace = z.object({
  decisionId: z.string(),
  goalId: z.string(),
  workflowRunId: z.string(),
  stepRunId: z.string().nullable(),
  decisionType: WorkflowDecisionType,
  selectedAction: z.string().max(200),
  reason: z.string().max(1024),
  influencedBy: z.array(WorkflowDecisionInfluence).max(32),
  alternativesConsidered: z.array(z.string().max(200)).max(8).optional(),
  confidence: z.number().min(0).max(1).optional(),
  operatorSelectionJson: OperatorSelection.optional(),
  createdAt: z.string().datetime(),
});
export type WorkflowDecisionTrace = z.infer<typeof WorkflowDecisionTrace>;

// === Provider config ===

export const ModelProviderInfo = z.object({
  id: ModelProviderId,
  displayName: z.string().min(1).max(80),
  available: z.boolean(),
  reason: z.string().max(256).optional(),
  models: z.array(z.object({
    id: z.string().min(1).max(80),
    displayName: z.string().min(1).max(80),
    capabilities: z.array(z.string().min(1).max(80)).max(20),
  })).max(20),
});
export type ModelProviderInfo = z.infer<typeof ModelProviderInfo>;

export const OrchestratorModelChoice = z.object({
  providerId: ModelProviderId,
  modelId: z.string().min(1).max(80),
});
export type OrchestratorModelChoice = z.infer<typeof OrchestratorModelChoice>;

// === HTTP request/response shapes ===

export const ListWorkflowTemplatesResponse = z.object({
  templates: z.array(WorkflowTemplate),
});
export type ListWorkflowTemplatesResponse = z.infer<typeof ListWorkflowTemplatesResponse>;

export const CreateWorkflowTemplateRequest = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2048),
  steps: z.array(WorkflowStepTemplate.omit({ ordinal: true }).extend({ ordinal: z.number().int().nonnegative().optional() })).min(1).max(20),
  guardrails: z.array(WorkflowGuardrailConfig).max(20),
});
export type CreateWorkflowTemplateRequest = z.infer<typeof CreateWorkflowTemplateRequest>;

export const DuplicateWorkflowTemplateRequest = z.object({
  sourceTemplateId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
});
export type DuplicateWorkflowTemplateRequest = z.infer<typeof DuplicateWorkflowTemplateRequest>;

export const StartWorkflowRunRequest = z.object({
  goalId: z.string(),
  templateId: z.string(),
});
export type StartWorkflowRunRequest = z.infer<typeof StartWorkflowRunRequest>;

export const SubmitWorkflowUserInputRequest = z.object({
  stepRunId: z.string(),
  answerText: z.string().max(8192).optional(),
  satisfiedExitCriteria: z.array(z.string().min(1).max(256)).max(20).optional(),
  artifactInputs: z.array(z.object({
    type: WorkflowArtifactType,
    title: z.string().min(1).max(256),
    body: z.string().max(65536),
  })).max(10).optional(),
});
export type SubmitWorkflowUserInputRequest = z.infer<typeof SubmitWorkflowUserInputRequest>;

export const RequestNextOrchestratorDecisionRequest = z.object({
  workflowRunId: z.string(),
});
export type RequestNextOrchestratorDecisionRequest = z.infer<typeof RequestNextOrchestratorDecisionRequest>;

export const NextOrchestratorDecisionResponse = z.object({
  decision: WorkflowDecisionTrace,
  recommendationIds: z.array(z.string()).max(5),
});
export type NextOrchestratorDecisionResponse = z.infer<typeof NextOrchestratorDecisionResponse>;

// === Extensions to existing contracts ===

// Goal: add orchestratorProvider, orchestratorModel
// CreateGoalRequest: add optional orchestratorModel: OrchestratorModelChoice
// Goal extends with: orchestratorProvider, orchestratorModel (both nullable string)
// goal.created payload remains byte-identical to M1-M7 and does not include these fields.
// DomainEventType extends with goal.orchestrator_model_changed for the PATCH route only.
// CreateSessionRequest extends with: workflowStepRunId?: string
// CreateContextPackageRequest extends with: workflowStepRunId?: string
// M7 Recommendation type union extends with:
//   'advance_workflow_step' | 'launch_workflow_session' |
//   'complete_workflow_run' | 'mark_artifact_satisfied' | 'request_user_input'
// M7 ProposedAction discriminated union adds:
//   { kind: 'advance_workflow_step'; workflowRunId: string; workflowStepRunId: string; toStepTemplateId: string }
//   { kind: 'launch_workflow_session'; workflowStepRunId: string; ...createSessionFields }
//   { kind: 'complete_workflow_run'; workflowRunId: string; workflowStepRunId: string }
//   { kind: 'mark_artifact_satisfied'; workflowStepRunId: string; artifactType: WorkflowArtifactType }
//   { kind: 'request_user_input'; workflowStepRunId: string; question: string }

// === Event literals ===

export const M8EventType = z.enum([
  "workflow.template.created",
  "workflow.template.updated",
  "workflow.template.duplicated",
  "workflow.run.started",
  "workflow.run.paused",
  "workflow.run.blocked",
  "workflow.run.completed",
  "workflow.run.failed",
  "workflow.run.cancelled",
  "workflow.step.started",
  "workflow.step.completed",
  "workflow.step.blocked",
  "workflow.step.skipped",
  "workflow.step.failed",
  "workflow.artifact.created",
  "workflow.guardrail.evaluated",
  "workflow.operator.selected",
  "workflow.decision.requested",
  "workflow.decision.recorded",
  "workflow.user.input.requested",
  "workflow.user.input.submitted",
  "workflow.recommendation.created",
  "workflow.recommendation.accepted",
  "workflow.recommendation.rejected",
  "workflow.task.dag.created",
  "workflow.task.dag.updated",
  "workflow.validation.run",
  "workflow.validation.passed",
  "workflow.validation.failed",
  "workflow.validation.skipped",
]);
export type M8EventType = z.infer<typeof M8EventType>;

// Also extend the existing DomainEventType with:
// - "goal.orchestrator_model_changed"
// Payload: { providerId: ModelProviderId; modelId: string }
// This is emitted only by PATCH /v1/goals/:goalId/orchestrator-model.
// The existing "goal.created" payload is unchanged.
```

Add per-event payload schemas (one zod object per literal) matching the Section "Events" table later in this plan. Each payload MUST serialize to ≤4 KiB; enforce with a per-schema test using `JSON.stringify(payload).length <= 4096`.

**Affected Areas.**
- `packages/contracts/src/index.ts` (or new files under `packages/contracts/src/workflows/`)
- `packages/contracts/src/__tests__/workflow-contracts.test.ts`

**Validation Steps.**
- `pnpm --filter @orca/contracts typecheck` exits 0.
- `pnpm --filter @orca/contracts test` exits 0.
- Tests verify: round-trip parse for each schema; rejection of oversize bodies (>64 KiB artifact body, >4 KiB event payload, >2 KiB guardrail config); discriminated-union exhaustiveness for `ProposedAction`; event-payload byte cap.

**Acceptance Criteria.**
- All schemas exported from `@orca/contracts`.
- Tests cover happy-path + every byte cap.
- No daemon or desktop change yet.

---

### M8-002 — SQLite Migrations: workflow_* tables, goal/session/context-package ALTERs

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Add the persistence layer. Migrations are forward-only, idempotent, and run during the existing M1 migration boot phase. Indices match the dominant access patterns (by goal_id, by run_id, by step_run_id, by template_id).

**Scope.**
- IS: forward-only migrations adding new tables and ALTER TABLE column adds. No data backfill (M1-M7 rows simply have NULL new fields).
- IS NOT: usecases, routes, projection helpers, UI.

**Requirements.**

Create `apps/daemon/src/migrations/008-workflows.ts` adding:

```sql
CREATE TABLE workflow_templates (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  version            INTEGER NOT NULL DEFAULT 1,
  is_built_in        INTEGER NOT NULL DEFAULT 0,
  is_locked          INTEGER NOT NULL DEFAULT 0,
  steps_json         TEXT NOT NULL DEFAULT '[]',
  guardrails_json    TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_workflow_templates_built_in ON workflow_templates(is_built_in);

CREATE TABLE workflow_runs (
  id                       TEXT PRIMARY KEY,
  goal_id                  TEXT NOT NULL REFERENCES goals(id),
  template_id              TEXT NOT NULL REFERENCES workflow_templates(id),
  template_version         INTEGER NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('active','paused','blocked','completed','failed','cancelled')),
  current_step_run_id      TEXT,
  blocked_reason           TEXT,
  started_at               TEXT NOT NULL,
  finished_at              TEXT
);
CREATE INDEX idx_workflow_runs_goal_status ON workflow_runs(goal_id, status, started_at DESC);
CREATE UNIQUE INDEX idx_workflow_runs_active_per_goal
  ON workflow_runs(goal_id)
  WHERE status IN ('active','paused','blocked');

CREATE TABLE workflow_step_runs (
  id                         TEXT PRIMARY KEY,
  goal_id                    TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id            TEXT NOT NULL REFERENCES workflow_runs(id),
  step_template_id           TEXT NOT NULL,
  ordinal                    INTEGER NOT NULL,
  attempt                    INTEGER NOT NULL DEFAULT 1,
  status                     TEXT NOT NULL CHECK (status IN ('pending','active','blocked','passed','failed','skipped')),
  satisfied_exit_criteria_json TEXT NOT NULL DEFAULT '[]',
  outstanding_exit_criteria_json TEXT NOT NULL DEFAULT '[]',
  blocked_reason             TEXT,
  started_at                 TEXT,
  finished_at                TEXT,
  fingerprint                TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_workflow_step_runs_fp
  ON workflow_step_runs(workflow_run_id, step_template_id, attempt);
CREATE INDEX idx_workflow_step_runs_goal
  ON workflow_step_runs(goal_id, ordinal);
CREATE INDEX idx_workflow_step_runs_run_ordinal
  ON workflow_step_runs(workflow_run_id, ordinal);

CREATE TABLE workflow_artifacts (
  id                         TEXT PRIMARY KEY,
  goal_id                    TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id            TEXT REFERENCES workflow_runs(id),
  step_run_id                TEXT REFERENCES workflow_step_runs(id),
  type                       TEXT NOT NULL,
  title                      TEXT NOT NULL,
  body                       TEXT NOT NULL,
  source                     TEXT NOT NULL CHECK (source IN ('user','agent','orchestrator','system')),
  linked_session_id          TEXT REFERENCES sessions(id),
  linked_task_id             TEXT REFERENCES tasks(id),
  linked_context_package_id  TEXT REFERENCES context_packages(id),
  created_at                 TEXT NOT NULL
);
CREATE INDEX idx_workflow_artifacts_goal_type
  ON workflow_artifacts(goal_id, type, created_at DESC);
CREATE INDEX idx_workflow_artifacts_run_step
  ON workflow_artifacts(workflow_run_id, step_run_id);

CREATE TABLE workflow_decisions (
  id                          TEXT PRIMARY KEY,
  goal_id                     TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id             TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id                 TEXT REFERENCES workflow_step_runs(id),
  decision_type               TEXT NOT NULL,
  selected_action             TEXT NOT NULL,
  reason                      TEXT NOT NULL,
  influenced_by_json          TEXT NOT NULL DEFAULT '[]',
  alternatives_considered_json TEXT NOT NULL DEFAULT '[]',
  confidence                  REAL,
  operator_selection_json     TEXT,
  input_fingerprint           TEXT NOT NULL,
  created_at                  TEXT NOT NULL
);
CREATE INDEX idx_workflow_decisions_run_created
  ON workflow_decisions(workflow_run_id, created_at DESC);
CREATE INDEX idx_workflow_decisions_goal_created
  ON workflow_decisions(goal_id, created_at DESC);
CREATE INDEX idx_workflow_decisions_step
  ON workflow_decisions(step_run_id) WHERE step_run_id IS NOT NULL;
CREATE UNIQUE INDEX idx_workflow_decisions_fp_window
  ON workflow_decisions(workflow_run_id, COALESCE(step_run_id,''), decision_type, input_fingerprint);

CREATE TABLE workflow_guardrail_evaluations (
  id                       TEXT PRIMARY KEY,
  goal_id                  TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id          TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id              TEXT REFERENCES workflow_step_runs(id),
  guardrail_id             TEXT NOT NULL,
  guardrail_kind           TEXT NOT NULL,
  decision_id              TEXT REFERENCES workflow_decisions(id),
  result                   TEXT NOT NULL CHECK (result IN ('allow','deny','require_approval')),
  message                  TEXT,
  created_at               TEXT NOT NULL
);
CREATE INDEX idx_workflow_guardrail_eval_run
  ON workflow_guardrail_evaluations(workflow_run_id, created_at DESC);
CREATE INDEX idx_workflow_guardrail_eval_goal
  ON workflow_guardrail_evaluations(goal_id, created_at DESC);

CREATE TABLE workflow_llm_calls (
  id                  TEXT PRIMARY KEY,
  goal_id             TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id     TEXT REFERENCES workflow_runs(id),
  step_run_id         TEXT REFERENCES workflow_step_runs(id),
  decision_id         TEXT REFERENCES workflow_decisions(id),
  provider_id         TEXT NOT NULL,
  provider_version    TEXT NOT NULL,
  model               TEXT NOT NULL,
  usage_tokens_input  INTEGER,
  usage_tokens_output INTEGER,
  latency_ms          INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  failure_code        TEXT,
  failure_message     TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_workflow_llm_calls_provider_created
  ON workflow_llm_calls(provider_id, created_at DESC);
CREATE INDEX idx_workflow_llm_calls_goal_created
  ON workflow_llm_calls(goal_id, created_at DESC);

-- ALTER goals
ALTER TABLE goals ADD COLUMN orchestrator_provider TEXT;
ALTER TABLE goals ADD COLUMN orchestrator_model TEXT;
ALTER TABLE goals ADD COLUMN active_workflow_run_id TEXT REFERENCES workflow_runs(id);

-- ALTER sessions
ALTER TABLE sessions ADD COLUMN workflow_step_run_id TEXT REFERENCES workflow_step_runs(id);

-- ALTER context_packages
ALTER TABLE context_packages ADD COLUMN workflow_step_run_id TEXT REFERENCES workflow_step_runs(id);

-- ALTER tasks (M7)
ALTER TABLE tasks ADD COLUMN workflow_step_run_id TEXT REFERENCES workflow_step_runs(id);

-- ALTER recommendations (M7)
ALTER TABLE recommendations ADD COLUMN workflow_step_run_id TEXT REFERENCES workflow_step_runs(id);
```

Register `008-workflows.ts` in the existing migration registry.

**Affected Areas.**
- `apps/daemon/src/migrations/008-workflows.ts` (NEW)
- `apps/daemon/src/migrations.ts` (register migration)
- `apps/daemon/src/migrations.test.ts` (extend)
- `apps/daemon/src/workflows/events.ts` (NEW helper for content-free workflow event rows + staged post-commit publish)

**Validation Steps.**
- `pnpm --filter @orca/daemon test migrations` exits 0.
- New test cases assert: each table exists post-migration; `goal_id` is present on every goal-scoped workflow table; columns and indices present; idempotent re-run is a no-op; `PRAGMA foreign_keys=ON` still passes.

**Acceptance Criteria.**
- Migration runs cleanly on a fresh DB and on a DB carrying M1-M7 data.
- Test exercises both paths.

---

### M8-003 — ModelProvider Interface + Anthropic Provider Implementation

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Define the seam every LLM call goes through. Anthropic is the first implementation. Provider must produce structured outputs that pass zod validation; failures map to typed failure codes. **No prompt/response persistence** beyond the metadata fields in `workflow_llm_calls`.

**Scope.**
- IS: interface, Anthropic SDK install + impl, retry/timeout policy, structured-output parsing, key resolution from OS env or secure store.
- IS NOT: OpenAI/Gemini impls (M8-004/005), provider registry (M8-006), UI for provider configuration (M8-022/023).

**Requirements.**

Install `@anthropic-ai/sdk` in `apps/daemon`. Add prompt-cache headers; default to `claude-sonnet-4-6` if no model passed.

Create `apps/daemon/src/llm/types.ts`:

```ts
export interface ModelCompletionRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchemaName: string;
  responseSchema: unknown;
  maxOutputTokens?: number;
  temperature?: number;
  callMetadata: { goalId?: string; workflowRunId?: string; stepRunId?: string; decisionId?: string };
}

export interface ModelCompletionResponse<T = unknown> {
  parsed: T;
  rawTextLength: number;
  usageTokensInput?: number;
  usageTokensOutput?: number;
  latencyMs: number;
  providerVersion: string;
}

export interface ModelProvider {
  readonly id: import("@orca/contracts").ModelProviderId;
  readonly displayName: string;
  readonly version: string;
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  listModels(): Promise<Array<{ id: string; displayName: string; capabilities: string[] }>>;
  complete<T>(req: ModelCompletionRequest): Promise<ModelCompletionResponse<T>>;
}

export type ProviderFailureCode =
  | "missing_api_key"
  | "provider_error"
  | "invalid_output"
  | "rate_limited"
  | "timeout"
  | "internal_error";

export class ProviderError extends Error {
  constructor(public readonly code: ProviderFailureCode, message: string) {
    super(message);
  }
}
```

Create `apps/daemon/src/llm/anthropic.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ModelProvider, ModelCompletionRequest, ModelCompletionResponse, ProviderError } from "./types";

const MODELS = [
  { id: "claude-opus-4-7",   displayName: "Claude Opus 4.7",   capabilities: ["reasoning", "long_context", "tool_use"] },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", capabilities: ["reasoning", "tool_use"] },
  { id: "claude-haiku-4-5",  displayName: "Claude Haiku 4.5",  capabilities: ["fast", "cheap"] },
];

export function createAnthropicProvider(opts: { apiKeyEnvVar?: string; clientFactory?: () => Anthropic } = {}): ModelProvider {
  const envVar = opts.apiKeyEnvVar ?? "ANTHROPIC_API_KEY";
  let client: Anthropic | null = null;

  const ensureClient = () => {
    if (client) return client;
    const key = process.env[envVar];
    if (!key) throw new ProviderError("missing_api_key", `${envVar} not set`);
    client = opts.clientFactory ? opts.clientFactory() : new Anthropic({ apiKey: key });
    return client;
  };

  return {
    id: "orca/anthropic",
    displayName: "Anthropic",
    version: "0.1.0",
    async isAvailable() {
      const key = process.env[envVar];
      return key ? { available: true } : { available: false, reason: `${envVar} not set` };
    },
    async listModels() {
      return MODELS;
    },
    async complete<T>(req: ModelCompletionRequest): Promise<ModelCompletionResponse<T>> {
      const c = ensureClient();
      const started = Date.now();
      try {
        const msg = await c.messages.create({
          model: req.model || "claude-sonnet-4-6",
          max_tokens: req.maxOutputTokens ?? 1024,
          temperature: req.temperature ?? 0,
          system: req.systemPrompt + `\n\nReturn ONLY a JSON object matching the schema "${req.responseSchemaName}". No prose.`,
          messages: [{ role: "user", content: req.userPrompt }],
        });
        const text = msg.content.map(b => b.type === "text" ? b.text : "").join("").trim();
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw new ProviderError("invalid_output", "non-JSON response"); }
        const schema = req.responseSchema as z.ZodTypeAny;
        const result = schema.safeParse(parsed);
        if (!result.success) throw new ProviderError("invalid_output", result.error.issues[0]?.message ?? "schema mismatch");
        return {
          parsed: result.data as T,
          rawTextLength: text.length,
          usageTokensInput: msg.usage?.input_tokens,
          usageTokensOutput: msg.usage?.output_tokens,
          latencyMs: Date.now() - started,
          providerVersion: "0.1.0",
        };
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        const message = e instanceof Error ? e.message.slice(0, 256) : "unknown error";
        if (/rate.?limit/i.test(message)) throw new ProviderError("rate_limited", message);
        if (/timeout/i.test(message)) throw new ProviderError("timeout", message);
        throw new ProviderError("provider_error", message);
      }
    },
  };
}
```

Add `apps/daemon/src/llm/anthropic.test.ts` covering: missing key path; invalid-JSON response path; schema mismatch path; happy path with fake `Anthropic` client.

**Affected Areas.**
- `apps/daemon/package.json` (add `@anthropic-ai/sdk` dependency)
- `apps/daemon/src/llm/types.ts` (NEW)
- `apps/daemon/src/llm/anthropic.ts` (NEW)
- `apps/daemon/src/llm/anthropic.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test llm/anthropic` PASS.
- `pnpm --filter @orca/daemon typecheck` PASS.

**Acceptance Criteria.**
- Anthropic provider returns parsed object on happy path with fake client.
- Failure codes map deterministically.
- No prompt/response text is logged or returned beyond `rawTextLength`.

---

### M8-004 — OpenAI Provider Implementation

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Ship OpenAI as a second provider behind the same interface.

**Scope.**
- IS: `openai` SDK install + impl mirroring M8-003 contract, GPT-4o/GPT-4o-mini/GPT-5 (if API supports) model list, structured output via `response_format: { type: "json_schema" }` where supported, else parse JSON from text.
- IS NOT: provider selection UI, registry wiring.

**Requirements.**

Install `openai` in `apps/daemon`. Create `apps/daemon/src/llm/openai.ts`:

```ts
import OpenAI from "openai";
import { z } from "zod";
import { ModelProvider, ModelCompletionRequest, ModelCompletionResponse, ProviderError } from "./types";

const MODELS = [
  { id: "gpt-5",          displayName: "GPT-5",          capabilities: ["reasoning", "long_context"] },
  { id: "gpt-4o",         displayName: "GPT-4o",         capabilities: ["reasoning", "tool_use"] },
  { id: "gpt-4o-mini",    displayName: "GPT-4o mini",    capabilities: ["fast", "cheap"] },
];

export function createOpenAIProvider(opts: { apiKeyEnvVar?: string; clientFactory?: () => OpenAI } = {}): ModelProvider {
  const envVar = opts.apiKeyEnvVar ?? "OPENAI_API_KEY";
  let client: OpenAI | null = null;
  const ensureClient = () => {
    if (client) return client;
    const key = process.env[envVar];
    if (!key) throw new ProviderError("missing_api_key", `${envVar} not set`);
    client = opts.clientFactory ? opts.clientFactory() : new OpenAI({ apiKey: key });
    return client;
  };

  return {
    id: "orca/openai",
    displayName: "OpenAI",
    version: "0.1.0",
    async isAvailable() {
      const key = process.env[envVar];
      return key ? { available: true } : { available: false, reason: `${envVar} not set` };
    },
    async listModels() { return MODELS; },
    async complete<T>(req: ModelCompletionRequest): Promise<ModelCompletionResponse<T>> {
      const c = ensureClient();
      const started = Date.now();
      try {
        const resp = await c.chat.completions.create({
          model: req.model || "gpt-4o-mini",
          temperature: req.temperature ?? 0,
          max_tokens: req.maxOutputTokens ?? 1024,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: req.systemPrompt + `\n\nReturn ONLY a JSON object matching schema "${req.responseSchemaName}".` },
            { role: "user", content: req.userPrompt },
          ],
        });
        const text = resp.choices[0]?.message?.content?.trim() ?? "";
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw new ProviderError("invalid_output", "non-JSON response"); }
        const schema = req.responseSchema as z.ZodTypeAny;
        const result = schema.safeParse(parsed);
        if (!result.success) throw new ProviderError("invalid_output", result.error.issues[0]?.message ?? "schema mismatch");
        return {
          parsed: result.data as T,
          rawTextLength: text.length,
          usageTokensInput: resp.usage?.prompt_tokens,
          usageTokensOutput: resp.usage?.completion_tokens,
          latencyMs: Date.now() - started,
          providerVersion: "0.1.0",
        };
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        const message = e instanceof Error ? e.message.slice(0, 256) : "unknown error";
        if (/rate.?limit/i.test(message)) throw new ProviderError("rate_limited", message);
        if (/timeout/i.test(message)) throw new ProviderError("timeout", message);
        throw new ProviderError("provider_error", message);
      }
    },
  };
}
```

Mirror `apps/daemon/src/llm/openai.test.ts` for the same four paths from M8-003.

**Affected Areas.**
- `apps/daemon/package.json`
- `apps/daemon/src/llm/openai.ts` (NEW)
- `apps/daemon/src/llm/openai.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test llm/openai` PASS.

**Acceptance Criteria.**
- Tests cover missing key, invalid JSON, schema mismatch, success.

---

### M8-005 — Google Gemini Provider Implementation

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Third provider so the goal-creation picker can offer a real cross-platform choice when keys are present.

**Scope.**
- IS: `@google/generative-ai` SDK install + impl mirroring M8-003 contract.
- IS NOT: UI, registry wiring.

**Requirements.**

Install `@google/generative-ai` in `apps/daemon`. Create `apps/daemon/src/llm/gemini.ts`:

```ts
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { ModelProvider, ModelCompletionRequest, ModelCompletionResponse, ProviderError } from "./types";

const MODELS = [
  { id: "gemini-2.5-pro",   displayName: "Gemini 2.5 Pro",   capabilities: ["reasoning", "long_context"] },
  { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", capabilities: ["fast", "cheap"] },
];

export function createGeminiProvider(opts: { apiKeyEnvVar?: string; clientFactory?: () => GoogleGenerativeAI } = {}): ModelProvider {
  const envVar = opts.apiKeyEnvVar ?? "GOOGLE_API_KEY";
  let client: GoogleGenerativeAI | null = null;
  const ensureClient = () => {
    if (client) return client;
    const key = process.env[envVar];
    if (!key) throw new ProviderError("missing_api_key", `${envVar} not set`);
    client = opts.clientFactory ? opts.clientFactory() : new GoogleGenerativeAI(key);
    return client;
  };

  return {
    id: "orca/google-gemini",
    displayName: "Google Gemini",
    version: "0.1.0",
    async isAvailable() {
      const key = process.env[envVar];
      return key ? { available: true } : { available: false, reason: `${envVar} not set` };
    },
    async listModels() { return MODELS; },
    async complete<T>(req: ModelCompletionRequest): Promise<ModelCompletionResponse<T>> {
      const c = ensureClient();
      const started = Date.now();
      try {
        const model = c.getGenerativeModel({
          model: req.model || "gemini-2.5-flash",
          generationConfig: {
            temperature: req.temperature ?? 0,
            maxOutputTokens: req.maxOutputTokens ?? 1024,
            responseMimeType: "application/json",
          },
        });
        const result = await model.generateContent([
          { text: req.systemPrompt + `\n\nReturn ONLY a JSON object matching schema "${req.responseSchemaName}".` },
          { text: req.userPrompt },
        ]);
        const text = result.response.text().trim();
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw new ProviderError("invalid_output", "non-JSON response"); }
        const schema = req.responseSchema as z.ZodTypeAny;
        const validated = schema.safeParse(parsed);
        if (!validated.success) throw new ProviderError("invalid_output", validated.error.issues[0]?.message ?? "schema mismatch");
        const usage = result.response.usageMetadata;
        return {
          parsed: validated.data as T,
          rawTextLength: text.length,
          usageTokensInput: usage?.promptTokenCount,
          usageTokensOutput: usage?.candidatesTokenCount,
          latencyMs: Date.now() - started,
          providerVersion: "0.1.0",
        };
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        const message = e instanceof Error ? e.message.slice(0, 256) : "unknown error";
        if (/rate.?limit/i.test(message)) throw new ProviderError("rate_limited", message);
        if (/timeout/i.test(message)) throw new ProviderError("timeout", message);
        throw new ProviderError("provider_error", message);
      }
    },
  };
}
```

Mirror `apps/daemon/src/llm/gemini.test.ts`.

**Affected Areas.**
- `apps/daemon/package.json`
- `apps/daemon/src/llm/gemini.ts` (NEW)
- `apps/daemon/src/llm/gemini.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test llm/gemini` PASS.

**Acceptance Criteria.**
- Same four test cases pass.

---

### M8-006 — ModelProviderRegistry + Goal Orchestrator Choice Persistence

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Wire all three providers into the daemon, expose `GET /v1/model-providers` for the goal-creation picker, and persist the chosen `orchestrator_provider`/`orchestrator_model` on the Goal row.

**Scope.**
- IS: registry class, `DaemonContext.modelProviderRegistry`, HTTP route, goal-creation/update extension, broadcast events.
- IS NOT: any orchestrator chat UI plumbing (M8-023), workflow runtime (M8-009+).

**Requirements.**

Create `apps/daemon/src/llm/registry.ts`:

```ts
import { ModelProvider } from "./types";
import { ModelProviderInfo, ModelProviderId } from "@orca/contracts";

export class ModelProviderRegistry {
  private providers = new Map<ModelProviderId, ModelProvider>();
  register(provider: ModelProvider) {
    if (this.providers.has(provider.id)) throw new Error(`duplicate provider ${provider.id}`);
    this.providers.set(provider.id, provider);
  }
  get(id: ModelProviderId): ModelProvider | undefined { return this.providers.get(id); }
  list(): ModelProvider[] { return [...this.providers.values()]; }
  async describe(): Promise<ModelProviderInfo[]> {
    const out: ModelProviderInfo[] = [];
    for (const p of this.providers.values()) {
      const avail = await p.isAvailable();
      const models = await p.listModels();
      out.push({
        id: p.id, displayName: p.displayName,
        available: avail.available, reason: avail.reason,
        models,
      });
    }
    return out;
  }
}
```

Register all three providers in the daemon bootstrap (`apps/daemon/src/index.ts` or wherever `DaemonContext` is built). Add `modelProviderRegistry: ModelProviderRegistry` to `DaemonContext`.

Add HTTP route in `apps/daemon/src/server.ts`:

```
GET /v1/model-providers  →  ModelProviderRegistry.describe()
```

Extend `CreateGoalRequest` in goal usecase:
- `orchestratorModel?: OrchestratorModelChoice`
- If provided, validate `providerId` exists in registry AND `modelId` is listed by that provider's `listModels()`.
- Persist into `goals.orchestrator_provider` and `goals.orchestrator_model`.
- Include in `Goal` read responses.
- Do **not** add these fields to `goal.created`; that event payload stays byte-identical to M1-M7.

Add `PATCH /v1/goals/:goalId/orchestrator-model` taking `OrchestratorModelChoice`; emits new content-free `goal.orchestrator_model_changed` event with `{ providerId, modelId }` only.

**Affected Areas.**
- `apps/daemon/src/llm/registry.ts` (NEW)
- `apps/daemon/src/llm/registry.test.ts` (NEW)
- `apps/daemon/src/daemon-context.ts` (extend)
- `apps/daemon/src/index.ts` (register providers)
- `apps/daemon/src/server.ts` (mount route)
- `apps/daemon/src/goals.ts` (extend create + add patch)
- `apps/daemon/src/goals.test.ts` (extend)
- `packages/contracts/src/index.ts` (extend `Goal`, `CreateGoalRequest`)

**Validation Steps.**
- `pnpm --filter @orca/daemon test goals llm/registry` PASS.
- New test: `POST /v1/goals` with `orchestratorModel` round-trips; `GET /v1/model-providers` returns three entries; invalid provider/model rejected with 400.

**Acceptance Criteria.**
- Picker data path works end-to-end (HTTP → registry → Anthropic/OpenAI/Gemini providers).
- Goal persists choice.

---

### M8-007 — Workflow Template Projection, Usecases, Routes

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** CRUD + read APIs for workflow templates. Built-in templates are read-only at route layer; custom templates are mutable.

**Scope.**
- IS: projection helpers, usecases (`createCustomTemplate`, `updateCustomTemplate`, `duplicateTemplate`, `getTemplate`, `listTemplates`), HTTP routes, version bump on update, events.
- IS NOT: Engineering seed itself (M8-008), UI (M8-022).

**Requirements.**

Create `apps/daemon/src/workflows/templates/projection.ts`:

```ts
import { Database } from "better-sqlite3";
import { WorkflowTemplate } from "@orca/contracts";

export function getTemplateById(db: Database, id: string): WorkflowTemplate | null {
  const row = db.prepare(`SELECT * FROM workflow_templates WHERE id = ?`).get(id);
  return row ? rowToTemplate(row) : null;
}

export function listTemplates(db: Database): WorkflowTemplate[] {
  return db.prepare(`SELECT * FROM workflow_templates ORDER BY is_built_in DESC, name ASC`)
    .all().map(rowToTemplate);
}

function rowToTemplate(row: any): WorkflowTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    isBuiltIn: !!row.is_built_in,
    isLocked: !!row.is_locked,
    steps: JSON.parse(row.steps_json),
    guardrails: JSON.parse(row.guardrails_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

Create `apps/daemon/src/workflows/templates/usecases.ts`:

```ts
import { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  WorkflowTemplate, CreateWorkflowTemplateRequest, DuplicateWorkflowTemplateRequest,
} from "@orca/contracts";
import { getTemplateById } from "./projection";
import { appendWorkflowEvent } from "../events";

export function createCustomTemplate(
  db: Database, now: () => string, req: CreateWorkflowTemplateRequest,
): WorkflowTemplate {
  const id = `custom/${randomUUID()}`;
  const steps = req.steps.map((s, i) => ({ ...s, ordinal: s.ordinal ?? i }));
  return db.transaction(() => {
    db.prepare(`INSERT INTO workflow_templates
      (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
      VALUES (?,?,?,?,0,0,?,?,?,?)`).run(
        id, req.name, req.description, 1,
        JSON.stringify(steps), JSON.stringify(req.guardrails),
        now(), now());
    appendWorkflowEvent(db, "workflow.template.created", { templateId: id, version: 1 });
    return getTemplateById(db, id)!;
  })();
}

export function updateCustomTemplate(
  db: Database, now: () => string, id: string, req: CreateWorkflowTemplateRequest,
): WorkflowTemplate {
  const existing = getTemplateById(db, id);
  if (!existing) throw new Error("not_found");
  if (existing.isLocked) throw new Error("locked");
  const steps = req.steps.map((s, i) => ({ ...s, ordinal: s.ordinal ?? i }));
  return db.transaction(() => {
    db.prepare(`UPDATE workflow_templates SET
      name=?, description=?, version=version+1, steps_json=?, guardrails_json=?, updated_at=?
      WHERE id=?`).run(req.name, req.description,
        JSON.stringify(steps), JSON.stringify(req.guardrails), now(), id);
    const next = getTemplateById(db, id)!;
    appendWorkflowEvent(db, "workflow.template.updated", { templateId: id, version: next.version });
    return next;
  })();
}

export function duplicateTemplate(
  db: Database, now: () => string, req: DuplicateWorkflowTemplateRequest,
): WorkflowTemplate {
  const src = getTemplateById(db, req.sourceTemplateId);
  if (!src) throw new Error("not_found");
  const id = `custom/${randomUUID()}`;
  return db.transaction(() => {
    db.prepare(`INSERT INTO workflow_templates
      (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
      VALUES (?,?,?,?,0,0,?,?,?,?)`).run(
        id, req.name, src.description, 1,
        JSON.stringify(src.steps), JSON.stringify(src.guardrails),
        now(), now());
    appendWorkflowEvent(db, "workflow.template.duplicated", { templateId: id, sourceTemplateId: src.id });
    return getTemplateById(db, id)!;
  })();
}
```

Add routes in `apps/daemon/src/workflows/templates/routes.ts`:

```
GET    /v1/workflow-templates                 → listTemplates
GET    /v1/workflow-templates/:id             → getTemplateById
POST   /v1/workflow-templates                 → createCustomTemplate (reject built-in id prefix)
PATCH  /v1/workflow-templates/:id             → updateCustomTemplate (404/409 on locked)
POST   /v1/workflow-templates/:id/duplicate   → duplicateTemplate
```

Wire routes in `server.ts`. Add `apps/daemon/src/workflows/templates/usecases.test.ts` and `projection.test.ts`.

**Affected Areas.**
- `apps/daemon/src/workflows/templates/projection.ts` (NEW)
- `apps/daemon/src/workflows/templates/projection.test.ts` (NEW)
- `apps/daemon/src/workflows/templates/usecases.ts` (NEW)
- `apps/daemon/src/workflows/templates/usecases.test.ts` (NEW)
- `apps/daemon/src/workflows/templates/routes.ts` (NEW)
- `apps/daemon/src/server.ts` (mount)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/templates` PASS.
- Tests: create → list → get → update (version bumps) → duplicate (locked source produces editable copy) → updating built-in returns 409.

**Acceptance Criteria.**
- CRUD round-trips; events emitted; built-in protection enforced at route + usecase layer.

---

### M8-008 — Engineering Built-in Template Seed

**Execution Assignment.** Model: `GPT 5.4`; Effort: `medium`.

**Purpose.** Seed the locked Engineering template at first boot so it appears in the Workflows tab. Idempotent: re-runs are no-ops; version increments only when the seed definition itself changes.

**Scope.**
- IS: deterministic seed function executed during daemon bootstrap, after migrations and before HTTP listen.
- IS NOT: orchestrator integration (M8-016+), step rules (M8-020).

**Requirements.**

Create `apps/daemon/src/workflows/templates/seed-engineering.ts`:

```ts
import { Database } from "better-sqlite3";
import { WorkflowTemplate, WorkflowStepTemplate, WorkflowGuardrailConfig } from "@orca/contracts";

const ENGINEERING_ID = "orca/engineering";
const ENGINEERING_VERSION = 1;

const steps: WorkflowStepTemplate[] = [
  {
    id: "intake", ordinal: 0, name: "Intake / Alignment",
    purpose: "Reach shared understanding before planning via one-question-at-a-time grilling.",
    requiredInputs: [], requiredOutputs: ["goal_brief"],
    gateType: "human-input",
    recommendedCapabilities: ["alignment", "question_generation"],
    validationExpectations: [],
    exitCriteria: [
      "problem statement exists",
      "desired outcome exists",
      "success criteria exist",
      "known constraints captured",
      "unresolved questions captured or resolved",
    ],
    recommendedOperatorIds: ["orca/anthropic:claude-sonnet-4-6", "orca/anthropic:claude-haiku-4-5"],
  },
  {
    id: "research", ordinal: 1, name: "Research",
    purpose: "Understand the repo, architecture, user flow, risks, and module boundaries.",
    requiredInputs: ["goal_brief"], requiredOutputs: ["research_summary"],
    gateType: "automated",
    recommendedCapabilities: ["repo_navigation", "architecture", "summarization"],
    validationExpectations: [],
    exitCriteria: [
      "relevant files identified",
      "current implementation summarized",
      "dependencies and risks captured",
      "unknowns captured",
      "likely implementation area and module boundaries identified",
    ],
    recommendedOperatorIds: ["agent:claude-code", "orca/google-gemini:gemini-2.5-pro"],
  },
  {
    id: "prd", ordinal: 2, name: "PRD / Destination",
    purpose: "Turn alignment and research into a buildable destination document.",
    requiredInputs: ["goal_brief", "research_summary"], requiredOutputs: ["prd"],
    gateType: "human-approval",
    recommendedCapabilities: ["prd_writing", "product_thinking"],
    validationExpectations: [],
    exitCriteria: [
      "problem and solution stated",
      "user stories or behavior statements exist",
      "acceptance criteria exist",
      "non-goals exist",
      "implementation and testing decisions captured",
      "definition of done exists",
    ],
    recommendedOperatorIds: ["orca/anthropic:claude-sonnet-4-6"],
  },
  {
    id: "issue_breakdown", ordinal: 3, name: "Issue Breakdown",
    purpose: "Convert PRD into independently grabbable vertical-slice tasks.",
    requiredInputs: ["prd"], requiredOutputs: ["issue_breakdown"],
    gateType: "human-approval",
    recommendedCapabilities: ["task_decomposition", "dependency_inference"],
    validationExpectations: [],
    exitCriteria: [
      "work split into clear tasks",
      "dependencies explicit",
      "first vertical slice reaches user/test-visible behavior where possible",
      "validation expectations exist",
      "suggested role/capabilities exist for each task",
    ],
    recommendedOperatorIds: ["orca/anthropic:claude-sonnet-4-6", "orca/openai:gpt-4o"],
  },
  {
    id: "execution", ordinal: 4, name: "Execution",
    purpose: "Recommend and supervise bounded agent work for next unblocked task.",
    requiredInputs: ["issue_breakdown"],
    requiredOutputs: ["implementation_result", "test_report"],
    gateType: "human-approval",
    recommendedCapabilities: ["code_editing", "test_writing", "validation"],
    validationExpectations: ["unit tests run", "typecheck run"],
    exitCriteria: [
      "assigned task completed or blocked with reason",
      "changed files summarized when applicable",
      "validation run or skipped with reason",
      "failures captured",
    ],
    recommendedOperatorIds: ["agent:codex", "agent:claude-code", "agent:opencode"],
  },
  {
    id: "qa", ordinal: 5, name: "QA",
    purpose: "Human-led product judgment with Orca-generated checklist; gate on taste.",
    requiredInputs: ["implementation_result"], requiredOutputs: ["qa_report"],
    gateType: "human-input",
    recommendedCapabilities: ["qa", "human_judgment"],
    validationExpectations: ["acceptance criteria checked"],
    exitCriteria: [
      "acceptance criteria checked",
      "passing/failing items recorded",
      "bugs/gaps captured",
      "rework required or not required is explicit",
    ],
    recommendedOperatorIds: ["human", "orca/google-gemini:gemini-2.5-pro"],
  },
  {
    id: "review", ordinal: 6, name: "Fresh-Context Review",
    purpose: "Review in a separate context instead of degraded implementer context.",
    requiredInputs: ["prd", "research_summary", "implementation_result", "qa_report"],
    requiredOutputs: ["review_report"],
    gateType: "automated",
    recommendedCapabilities: ["code_review", "architecture_review"],
    validationExpectations: [],
    exitCriteria: [
      "architecture drift assessed",
      "test gaps assessed",
      "maintainability risks captured",
      "blocking issues identified or ruled out",
      "follow-up tasks created where needed",
    ],
    recommendedOperatorIds: ["orca/anthropic:claude-opus-4-7", "agent:claude-code"],
  },
  {
    id: "done", ordinal: 7, name: "Done",
    purpose: "Finalize durable outcome and memory.",
    requiredInputs: ["review_report", "qa_report", "implementation_result"],
    requiredOutputs: ["final_summary", "memory_update"],
    gateType: "human-approval",
    recommendedCapabilities: ["summarization", "memory_curation"],
    validationExpectations: [],
    exitCriteria: [
      "final result summarized",
      "important decisions captured",
      "follow-up work captured",
      "goal marked complete or left active with explicit remaining work",
    ],
    recommendedOperatorIds: ["orca/anthropic:claude-sonnet-4-6"],
  },
];

const guardrails: WorkflowGuardrailConfig[] = [
  { id: "approval_launch_agent", kind: "approval_required", label: "Require approval to launch agents",
    configJson: { actions: ["launch_workflow_session"] } },
  { id: "approval_mark_done",    kind: "approval_required", label: "Require approval to mark Done",
    configJson: { actions: ["mark_run_complete"] } },
  { id: "validation_required",   kind: "validation_rule",   label: "Require tests/typecheck or explicit skip reason",
    configJson: { appliesToSteps: ["execution"], required: ["unit_tests", "typecheck"] } },
  { id: "context_summary",       kind: "context_rule",      label: "Use summaries/artifacts, not raw terminal logs",
    configJson: { allowRawTerminalOutput: false } },
  { id: "concurrency_one",       kind: "concurrency_rule",  label: "Max one execution task running at a time",
    configJson: { maxConcurrentExecution: 1 } },
  { id: "cost_speed_balanced",   kind: "cost_speed_preference", label: "Prefer cheapest sufficient",
    configJson: { preference: "cheapest_sufficient" } },
];

export function seedEngineeringTemplate(db: Database, now: () => string): void {
  const existing = db.prepare(`SELECT version FROM workflow_templates WHERE id = ?`).get(ENGINEERING_ID) as { version: number } | undefined;
  if (existing && existing.version >= ENGINEERING_VERSION) return;
  db.transaction(() => {
    if (existing) {
      db.prepare(`UPDATE workflow_templates SET version=?, steps_json=?, guardrails_json=?, updated_at=? WHERE id=?`)
        .run(ENGINEERING_VERSION, JSON.stringify(steps), JSON.stringify(guardrails), now(), ENGINEERING_ID);
    } else {
      db.prepare(`INSERT INTO workflow_templates
        (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
        VALUES (?,?,?,?,1,1,?,?,?,?)`).run(
          ENGINEERING_ID, "Engineering",
          "Built-in workflow optimized for AI-assisted software delivery.",
          ENGINEERING_VERSION, JSON.stringify(steps), JSON.stringify(guardrails),
          now(), now());
    }
  })();
}
```

Call `seedEngineeringTemplate(db, now)` during daemon bootstrap, after `runMigrations` and before HTTP listen.

**Affected Areas.**
- `apps/daemon/src/workflows/templates/seed-engineering.ts` (NEW)
- `apps/daemon/src/workflows/templates/seed-engineering.test.ts` (NEW)
- `apps/daemon/src/index.ts` (invoke seed)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/templates/seed-engineering` PASS.
- Tests: first run inserts; second run with same version is no-op; bumping `ENGINEERING_VERSION` triggers update; row is locked and built-in.

**Acceptance Criteria.**
- Engineering present after boot; locked; eight steps in correct order; six guardrails.

---

### M8-009 — Workflow Run Lifecycle: Start, Pause, Resume, Cancel, Complete

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Persist `workflow_runs` row, gate at most one active run per goal, link to `goals.active_workflow_run_id`, emit lifecycle events.

**Scope.**
- IS: usecases for `startRun`, `pauseRun`, `resumeRun`, `cancelRun`, `completeRun`, `markBlocked`; projection helpers; HTTP routes.
- IS NOT: step lifecycle (M8-010), artifacts (M8-011), orchestrator decisions (M8-016).

**Requirements.**

Create `apps/daemon/src/workflows/runs/projection.ts`, `usecases.ts`, `routes.ts`.

`usecases.ts` core:

```ts
import { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { WorkflowRun } from "@orca/contracts";
import { appendWorkflowEvent } from "../events";
import { getTemplateById } from "../templates/projection";

export function startWorkflowRun(
  db: Database, now: () => string,
  args: { goalId: string; templateId: string },
): WorkflowRun {
  const template = getTemplateById(db, args.templateId);
  if (!template) throw new Error("template_not_found");
  const existingActive = db.prepare(`
    SELECT id FROM workflow_runs WHERE goal_id = ? AND status IN ('active','paused','blocked')
  `).get(args.goalId);
  if (existingActive) throw new Error("active_run_exists");
  const id = randomUUID();
  return db.transaction(() => {
    db.prepare(`INSERT INTO workflow_runs
      (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at)
      VALUES (?,?,?,?,'active',NULL,NULL,?,NULL)`).run(
        id, args.goalId, args.templateId, template.version, now());
    db.prepare(`UPDATE goals SET active_workflow_run_id = ? WHERE id = ?`).run(id, args.goalId);
    appendWorkflowEvent(db, "workflow.run.started", {
      workflowRunId: id, goalId: args.goalId,
      templateId: args.templateId, templateVersion: template.version,
    });
    return readRun(db, id);
  })();
}

export function pauseRun(db: Database, now: () => string, id: string): WorkflowRun {
  return db.transaction(() => {
    db.prepare(`UPDATE workflow_runs SET status='paused' WHERE id=? AND status='active'`).run(id);
    appendWorkflowEvent(db, "workflow.run.paused", { goalId: readRun(db, id).goalId, workflowRunId: id });
    return readRun(db, id);
  })();
}

export function resumeRun(db: Database, now: () => string, id: string): WorkflowRun {
  return db.transaction(() => {
    db.prepare(`UPDATE workflow_runs SET status='active', blocked_reason=NULL WHERE id=? AND status IN ('paused','blocked')`).run(id);
    appendWorkflowEvent(db, "workflow.run.started", { goalId: readRun(db, id).goalId, workflowRunId: id, resumed: true });
    return readRun(db, id);
  })();
}

export function cancelRun(db: Database, now: () => string, id: string): WorkflowRun {
  return db.transaction(() => {
    db.prepare(`UPDATE workflow_runs SET status='cancelled', finished_at=? WHERE id=?`).run(now(), id);
    db.prepare(`UPDATE goals SET active_workflow_run_id=NULL WHERE active_workflow_run_id=?`).run(id);
    appendWorkflowEvent(db, "workflow.run.cancelled", { goalId: readRun(db, id).goalId, workflowRunId: id });
    return readRun(db, id);
  })();
}

export function completeRun(db: Database, now: () => string, id: string): WorkflowRun {
  return db.transaction(() => {
    db.prepare(`UPDATE workflow_runs SET status='completed', finished_at=? WHERE id=? AND status='active'`).run(now(), id);
    db.prepare(`UPDATE goals SET active_workflow_run_id=NULL WHERE active_workflow_run_id=?`).run(id);
    appendWorkflowEvent(db, "workflow.run.completed", { goalId: readRun(db, id).goalId, workflowRunId: id });
    return readRun(db, id);
  })();
}

export function markRunBlocked(db: Database, now: () => string, id: string, reason: string): WorkflowRun {
  return db.transaction(() => {
    db.prepare(`UPDATE workflow_runs SET status='blocked', blocked_reason=? WHERE id=?`).run(reason.slice(0, 256), id);
    appendWorkflowEvent(db, "workflow.run.blocked", { goalId: readRun(db, id).goalId, workflowRunId: id });
    return readRun(db, id);
  })();
}

function readRun(db: Database, id: string): WorkflowRun {
  const row: any = db.prepare(`SELECT * FROM workflow_runs WHERE id=?`).get(id);
  return {
    id: row.id, goalId: row.goal_id,
    templateId: row.template_id, templateVersion: row.template_version,
    status: row.status, currentStepRunId: row.current_step_run_id,
    startedAt: row.started_at, finishedAt: row.finished_at,
    blockedReason: row.blocked_reason,
  };
}
```

Routes:
```
POST   /v1/goals/:goalId/workflow-runs              → startRun
GET    /v1/goals/:goalId/workflow-runs              → listRunsForGoal
GET    /v1/goals/:goalId/workflow-runs/:id          → getRun (404 if run.goal_id differs)
POST   /v1/goals/:goalId/workflow-runs/:id/pause    → pauseRun (404 if run.goal_id differs)
POST   /v1/goals/:goalId/workflow-runs/:id/resume   → resumeRun (404 if run.goal_id differs)
POST   /v1/goals/:goalId/workflow-runs/:id/cancel   → cancelRun (404 if run.goal_id differs)
```

**Affected Areas.**
- `apps/daemon/src/workflows/runs/projection.ts` (NEW)
- `apps/daemon/src/workflows/runs/usecases.ts` (NEW)
- `apps/daemon/src/workflows/runs/routes.ts` (NEW)
- `apps/daemon/src/workflows/runs/usecases.test.ts` (NEW)
- `apps/daemon/src/server.ts` (mount)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/runs` PASS.
- Tests: only one active run per goal; pause→resume; cancel terminal; events emitted in TX.

**Acceptance Criteria.**
- Lifecycle transitions enforced via SQL CHECK + usecase guards.

---

### M8-010 — Workflow Step Run Lifecycle + Exit-Criteria Bookkeeping (GATE: full-suite typecheck + test)

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Step runs are the unit the orchestrator drives. Tracks per-step status, satisfied vs outstanding exit criteria, attempts on retry. Provides advance-step usecase that consumes exit-criteria satisfaction and creates the next step run.

**Scope.**
- IS: usecases (`createInitialStep`, `markStepBlocked`, `recordExitCriteriaSatisfaction`, `advanceToNextStep`, `failStep`, `skipStep`), projection helpers, fingerprint, atomic state transitions, events.
- IS NOT: orchestrator decision-making about *whether* to advance (M8-016), guardrail evaluation (M8-012).

**Requirements.**

Create `apps/daemon/src/workflows/steps/usecases.ts`:

```ts
import { Database } from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { WorkflowStepRun } from "@orca/contracts";
import { getTemplateById } from "../templates/projection";
import { appendWorkflowEvent } from "../events";

export function stepFingerprint(runId: string, stepTemplateId: string, attempt: number): string {
  return createHash("sha256").update(`${runId}:${stepTemplateId}:${attempt}`).digest("hex");
}

export function createInitialStep(db: Database, now: () => string, workflowRunId: string): WorkflowStepRun {
  const run: any = db.prepare(`SELECT * FROM workflow_runs WHERE id=?`).get(workflowRunId);
  if (!run) throw new Error("run_not_found");
  const template = getTemplateById(db, run.template_id)!;
  const first = template.steps.find(s => s.ordinal === 0)!;
  return insertStep(db, now, run.goal_id, workflowRunId, first.id, first.ordinal, 1, first.exitCriteria);
}

export function advanceToNextStep(db: Database, now: () => string, currentStepRunId: string): WorkflowStepRun | null {
  return db.transaction(() => {
    const cur: any = db.prepare(`SELECT * FROM workflow_step_runs WHERE id=?`).get(currentStepRunId);
    if (!cur) throw new Error("step_not_found");
    const run: any = db.prepare(`SELECT * FROM workflow_runs WHERE id=?`).get(cur.workflow_run_id);
    const template = getTemplateById(db, run.template_id)!;
    db.prepare(`UPDATE workflow_step_runs SET status='passed', finished_at=? WHERE id=?`).run(now(), currentStepRunId);
    appendWorkflowEvent(db, "workflow.step.completed", {
      goalId: cur.goal_id, workflowRunId: cur.workflow_run_id, stepRunId: currentStepRunId,
      stepTemplateId: cur.step_template_id,
    });
    const next = template.steps.find(s => s.ordinal === cur.ordinal + 1);
    if (!next) {
      db.prepare(`UPDATE workflow_runs SET status='completed', finished_at=?, current_step_run_id=NULL WHERE id=?`).run(now(), cur.workflow_run_id);
      db.prepare(`UPDATE goals SET active_workflow_run_id=NULL WHERE active_workflow_run_id=?`).run(cur.workflow_run_id);
      appendWorkflowEvent(db, "workflow.run.completed", { goalId: run.goal_id, workflowRunId: cur.workflow_run_id });
      return null;
    }
    return insertStep(db, now, run.goal_id, cur.workflow_run_id, next.id, next.ordinal, 1, next.exitCriteria);
  })();
}

export function recordExitCriteriaSatisfaction(
  db: Database, now: () => string, stepRunId: string, satisfied: string[],
): WorkflowStepRun {
  return db.transaction(() => {
    const row: any = db.prepare(`SELECT * FROM workflow_step_runs WHERE id=?`).get(stepRunId);
    const current: string[] = JSON.parse(row.satisfied_exit_criteria_json);
    const outstanding: string[] = JSON.parse(row.outstanding_exit_criteria_json);
    const updatedSatisfied = Array.from(new Set([...current, ...satisfied]));
    const updatedOutstanding = outstanding.filter(c => !updatedSatisfied.includes(c));
    db.prepare(`UPDATE workflow_step_runs SET satisfied_exit_criteria_json=?, outstanding_exit_criteria_json=? WHERE id=?`)
      .run(JSON.stringify(updatedSatisfied), JSON.stringify(updatedOutstanding), stepRunId);
    return readStep(db, stepRunId);
  })();
}

export function markStepBlocked(db: Database, now: () => string, stepRunId: string, reason: string): WorkflowStepRun {
  return db.transaction(() => {
    db.prepare(`UPDATE workflow_step_runs SET status='blocked', blocked_reason=? WHERE id=?`).run(reason.slice(0,256), stepRunId);
    const row: any = db.prepare(`SELECT goal_id, workflow_run_id FROM workflow_step_runs WHERE id=?`).get(stepRunId);
    appendWorkflowEvent(db, "workflow.step.blocked", { goalId: row.goal_id, workflowRunId: row.workflow_run_id, stepRunId });
    return readStep(db, stepRunId);
  })();
}

export function failStep(db: Database, now: () => string, stepRunId: string): WorkflowStepRun {
  return db.transaction(() => {
    db.prepare(`UPDATE workflow_step_runs SET status='failed', finished_at=? WHERE id=?`).run(now(), stepRunId);
    const row: any = db.prepare(`SELECT goal_id, workflow_run_id FROM workflow_step_runs WHERE id=?`).get(stepRunId);
    appendWorkflowEvent(db, "workflow.step.failed", { goalId: row.goal_id, workflowRunId: row.workflow_run_id, stepRunId });
    return readStep(db, stepRunId);
  })();
}

function insertStep(
  db: Database, now: () => string, goalId: string, runId: string, templateStepId: string,
  ordinal: number, attempt: number, exitCriteria: string[],
): WorkflowStepRun {
  const id = randomUUID();
  const fp = stepFingerprint(runId, templateStepId, attempt);
  db.prepare(`INSERT INTO workflow_step_runs
    (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
     satisfied_exit_criteria_json, outstanding_exit_criteria_json,
     blocked_reason, started_at, finished_at, fingerprint)
    VALUES (?,?,?,?,?,?,'active','[]',?,NULL,?,NULL,?)`).run(
      id, goalId, runId, templateStepId, ordinal, attempt,
      JSON.stringify(exitCriteria), now(), fp);
  db.prepare(`UPDATE workflow_runs SET current_step_run_id=? WHERE id=?`).run(id, runId);
  appendWorkflowEvent(db, "workflow.step.started", {
    goalId, workflowRunId: runId, stepRunId: id, stepTemplateId: templateStepId, ordinal,
  });
  return readStep(db, id);
}

function readStep(db: Database, id: string): WorkflowStepRun {
  const row: any = db.prepare(`SELECT * FROM workflow_step_runs WHERE id=?`).get(id);
  return {
    id: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id,
    stepTemplateId: row.step_template_id, ordinal: row.ordinal, attempt: row.attempt,
    status: row.status,
    satisfiedExitCriteria: JSON.parse(row.satisfied_exit_criteria_json),
    outstandingExitCriteria: JSON.parse(row.outstanding_exit_criteria_json),
    blockedReason: row.blocked_reason,
    startedAt: row.started_at, finishedAt: row.finished_at,
  };
}
```

Wire `startWorkflowRun` (M8-009) to call `createInitialStep` in the same TX.

**Gate.** After this task lands, run `pnpm -r typecheck && pnpm -r test`. All M1-M8-010 tests pass. Record green SHA in `docs/implementation-plans/notes/m8-010-gate.md`.

**Affected Areas.**
- `apps/daemon/src/workflows/steps/usecases.ts` (NEW)
- `apps/daemon/src/workflows/steps/usecases.test.ts` (NEW)
- `apps/daemon/src/workflows/runs/usecases.ts` (update `startWorkflowRun` to invoke `createInitialStep`)
- `docs/implementation-plans/notes/m8-010-gate.md` (NEW)

**Validation Steps.**
- `pnpm -r typecheck && pnpm -r test` PASS.
- Tests cover: create → advance through all 8 Engineering steps → run completes; blocked + resume re-uses the active step (attempt stays at 1); fail+retry creates attempt=2 row with new fingerprint.

**Acceptance Criteria.**
- Run advances; events emit in TX; per-step exit criteria bookkeeping correct.

---

### M8-011 — Workflow Artifact Projection, Usecases, Routes

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Persist DB-owned artifacts (goal_brief, research_summary, prd, issue_breakdown, implementation_result, test_report, qa_report, review_report, final_summary, memory_update, open_questions) produced during a run. Artifacts link to run, step run, optional task/session/context-package.

**Scope.**
- IS: projection, usecases (`createArtifact`, `listArtifactsForRun`, `listArtifactsForGoal`, `getArtifact`), HTTP routes, event emission.
- IS NOT: per-step rules that generate artifacts (M8-020).

**Requirements.**

Create `apps/daemon/src/workflows/artifacts/projection.ts`:

```ts
import { Database } from "better-sqlite3";
import { WorkflowArtifact, WorkflowArtifactType } from "@orca/contracts";

export function getArtifactById(db: Database, id: string): WorkflowArtifact | null {
  const row: any = db.prepare(`SELECT * FROM workflow_artifacts WHERE id=?`).get(id);
  return row ? toArtifact(row) : null;
}

export function listArtifactsForRun(db: Database, runId: string): WorkflowArtifact[] {
  return db.prepare(`SELECT * FROM workflow_artifacts WHERE workflow_run_id=? ORDER BY created_at ASC`)
    .all(runId).map(toArtifact);
}

export function listArtifactsForGoal(db: Database, goalId: string, type?: WorkflowArtifactType): WorkflowArtifact[] {
  if (type) {
    return db.prepare(`SELECT * FROM workflow_artifacts WHERE goal_id=? AND type=? ORDER BY created_at DESC`)
      .all(goalId, type).map(toArtifact);
  }
  return db.prepare(`SELECT * FROM workflow_artifacts WHERE goal_id=? ORDER BY created_at DESC`)
    .all(goalId).map(toArtifact);
}

function toArtifact(row: any): WorkflowArtifact {
  return {
    id: row.id, goalId: row.goal_id,
    workflowRunId: row.workflow_run_id, stepRunId: row.step_run_id,
    type: row.type, title: row.title, body: row.body, source: row.source,
    linkedSessionId: row.linked_session_id, linkedTaskId: row.linked_task_id,
    linkedContextPackageId: row.linked_context_package_id,
    createdAt: row.created_at,
  };
}
```

Create `apps/daemon/src/workflows/artifacts/usecases.ts`:

```ts
import { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { WorkflowArtifact, WorkflowArtifactType } from "@orca/contracts";
import { appendWorkflowEvent } from "../events";
import { getArtifactById } from "./projection";

export interface CreateArtifactInput {
  goalId: string;
  workflowRunId: string | null;
  stepRunId: string | null;
  type: WorkflowArtifactType;
  title: string;
  body: string;
  source: WorkflowArtifact["source"];
  linkedSessionId?: string;
  linkedTaskId?: string;
  linkedContextPackageId?: string;
}

export function createArtifact(db: Database, now: () => string, input: CreateArtifactInput): WorkflowArtifact {
  if (input.body.length > 65536) throw new Error("artifact_body_too_large");
  const id = randomUUID();
  return db.transaction(() => {
    db.prepare(`INSERT INTO workflow_artifacts
      (id, goal_id, workflow_run_id, step_run_id, type, title, body, source,
       linked_session_id, linked_task_id, linked_context_package_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.goalId, input.workflowRunId, input.stepRunId,
        input.type, input.title.slice(0, 256), input.body, input.source,
        input.linkedSessionId ?? null, input.linkedTaskId ?? null,
        input.linkedContextPackageId ?? null, now());
    appendWorkflowEvent(db, "workflow.artifact.created", {
      artifactId: id, goalId: input.goalId,
      workflowRunId: input.workflowRunId, stepRunId: input.stepRunId,
      type: input.type, bodyBytes: input.body.length,
    });
    return getArtifactById(db, id)!;
  })();
}
```

Routes in `apps/daemon/src/workflows/artifacts/routes.ts`:

```
POST   /v1/goals/:goalId/workflow-artifacts           → createArtifact (body validated against contract)
GET    /v1/goals/:goalId/workflow-artifacts           → listArtifactsForGoal (?type= filter)
GET    /v1/goals/:goalId/workflow-runs/:runId/artifacts → listArtifactsForRun (404 if run.goal_id differs)
GET    /v1/goals/:goalId/workflow-artifacts/:id       → getArtifactById (404 if artifact.goal_id differs)
```

**Affected Areas.**
- `apps/daemon/src/workflows/artifacts/projection.ts` (NEW)
- `apps/daemon/src/workflows/artifacts/usecases.ts` (NEW)
- `apps/daemon/src/workflows/artifacts/routes.ts` (NEW)
- `apps/daemon/src/workflows/artifacts/usecases.test.ts` (NEW)
- `apps/daemon/src/server.ts` (mount)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/artifacts` PASS.
- Tests: create → list by goal → list by run → get; oversize body rejected; event payload contains byte count, not body.

**Acceptance Criteria.**
- Artifacts persist with full body, events stay content-free.

---

### M8-012 — Guardrail Evaluation Engine

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Deterministic engine that evaluates each guardrail before operator selection, step advancement, validation skip, and run completion. Persists evaluation rows so the decision trace can cite them.

**Scope.**
- IS: pure evaluator functions per `GuardrailKind`, `evaluateGuardrails` orchestrator helper, persistence to `workflow_guardrail_evaluations`, event emission.
- IS NOT: guardrail editor UI (M8-022), runtime mutation of guardrails mid-run.

**Requirements.**

Expose both `evaluateAllGuardrails` (transaction-owning public usecase) and `evaluateAllGuardrailsInTx` (internal helper used by M8-014/M8-016). The internal helper inserts evaluation rows and stages events in the caller's transaction.

Create `apps/daemon/src/workflows/guardrails/evaluator.ts`:

```ts
import { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { WorkflowGuardrailConfig, GuardrailKind } from "@orca/contracts";
import { appendWorkflowEvent } from "../events";

export type GuardrailContext = {
  goalId: string;
  workflowRunId: string;
  stepRunId: string | null;
  stepTemplateId?: string;
  activeExecutionCount?: number;
  riskLabels?: string[];
  candidateAction:
    | { kind: "launch_workflow_session"; operatorId: string }
    | { kind: "advance_step" }
    | { kind: "mark_run_complete" }
    | { kind: "skip_validation" }
    | { kind: "select_operator"; operatorId: string }
    | { kind: "use_raw_terminal_output" };
};

export type GuardrailResult = { guardrailId: string; kind: GuardrailKind; result: "allow" | "deny" | "require_approval"; message?: string };

export function evaluateGuardrail(g: WorkflowGuardrailConfig, ctx: GuardrailContext): GuardrailResult {
  switch (g.kind) {
    case "approval_required": {
      const cfg = g.configJson as { actions: string[] };
      const needs = cfg.actions.includes(ctx.candidateAction.kind);
      return { guardrailId: g.id, kind: g.kind, result: needs ? "require_approval" : "allow" };
    }
    case "allowed_operators": {
      const cfg = g.configJson as { allowed: string[] };
      if (ctx.candidateAction.kind === "select_operator" || ctx.candidateAction.kind === "launch_workflow_session") {
        const id = (ctx.candidateAction as any).operatorId as string;
        return { guardrailId: g.id, kind: g.kind, result: cfg.allowed.includes(id) ? "allow" : "deny",
          message: cfg.allowed.includes(id) ? undefined : `operator ${id} not allowed` };
      }
      return { guardrailId: g.id, kind: g.kind, result: "allow" };
    }
    case "validation_rule": {
      const cfg = g.configJson as { appliesToSteps: string[]; required: string[] };
      if (ctx.candidateAction.kind === "skip_validation" && ctx.stepTemplateId && cfg.appliesToSteps.includes(ctx.stepTemplateId)) {
        return { guardrailId: g.id, kind: g.kind, result: "require_approval", message: "validation skip requires explicit reason" };
      }
      return { guardrailId: g.id, kind: g.kind, result: "allow" };
    }
    case "context_rule": {
      const cfg = g.configJson as { allowRawTerminalOutput: boolean };
      if (ctx.candidateAction.kind === "use_raw_terminal_output" && !cfg.allowRawTerminalOutput) {
        return { guardrailId: g.id, kind: g.kind, result: "deny", message: "raw terminal output not allowed" };
      }
      return { guardrailId: g.id, kind: g.kind, result: "allow" };
    }
    case "concurrency_rule": {
      const cfg = g.configJson as { maxConcurrentExecution?: number };
      if (ctx.candidateAction.kind === "launch_workflow_session" &&
          cfg.maxConcurrentExecution !== undefined &&
          (ctx.activeExecutionCount ?? 0) >= cfg.maxConcurrentExecution) {
        return { guardrailId: g.id, kind: g.kind, result: "deny", message: "execution concurrency limit reached" };
      }
      return { guardrailId: g.id, kind: g.kind, result: "allow" };
    }
    case "risk_rule": {
      const cfg = g.configJson as { escalateOn?: string[] };
      const matched = (ctx.riskLabels ?? []).some(label => (cfg.escalateOn ?? []).includes(label));
      return { guardrailId: g.id, kind: g.kind, result: matched ? "require_approval" : "allow",
        message: matched ? "risk rule requires approval" : undefined };
    }
    case "cost_speed_preference":
      return { guardrailId: g.id, kind: g.kind, result: "allow", message: "cost/speed preference applies to operator ranking" };
  }
}

export function evaluateAllGuardrails(
  db: Database, now: () => string,
  guardrails: WorkflowGuardrailConfig[], ctx: GuardrailContext, decisionId: string | null,
): GuardrailResult[] {
  const results = guardrails.map(g => evaluateGuardrail(g, ctx));
  db.transaction(() => {
    for (const r of results) {
      const id = randomUUID();
      db.prepare(`INSERT INTO workflow_guardrail_evaluations
        (id, goal_id, workflow_run_id, step_run_id, guardrail_id, guardrail_kind, decision_id, result, message, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, ctx.goalId, ctx.workflowRunId, ctx.stepRunId, r.guardrailId, r.kind,
          decisionId, r.result, r.message?.slice(0, 256) ?? null, now());
      appendWorkflowEvent(db, "workflow.guardrail.evaluated", {
        guardrailEvaluationId: id, goalId: ctx.goalId, workflowRunId: ctx.workflowRunId,
        stepRunId: ctx.stepRunId, guardrailId: r.guardrailId,
        guardrailKind: r.kind, result: r.result,
      });
    }
  })();
  return results;
}
```

Concurrency, risk, and cost/speed rules ship with minimal concrete influence in M8: concurrency can deny launches over the configured active execution count, risk can require approval for matched labels, and cost/speed is passed into operator ranking/decision influence. More expressive policy details are deferred.

**Affected Areas.**
- `apps/daemon/src/workflows/guardrails/evaluator.ts` (NEW)
- `apps/daemon/src/workflows/guardrails/evaluator.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/guardrails` PASS.
- Tests: approval_required matches action set; allowed_operators denies unlisted; validation_rule requires approval on skip; context_rule denies raw terminal; concurrency_rule denies over-limit launches; risk_rule requires approval for matched risk labels; cost_speed_preference appears in decision influence; event/row written per evaluation.

**Acceptance Criteria.**
- Per-kind branches produce expected results; persistence + events atomic.

---

### M8-013 — Operator Registry: Agents + Models + Human

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Single source of truth for the LLM to pick from. Reuses M2 agent adapter registry + M4 readiness, M8-006 model provider registry, and a static `human` entry. Exposes a `listAvailableOperators(goalId)` helper returning operators tagged with capabilities, kind, and current readiness.

**Scope.**
- IS: `OperatorDescriptor`, `OperatorRegistry` aggregator, capability tagging, readiness resolution, `GET /v1/operators?goalId=` route.
- IS NOT: operator-selection LLM logic (M8-014).

**Requirements.**

Create `apps/daemon/src/workflows/operators/registry.ts`:

```ts
import { ModelProviderRegistry } from "../../llm/registry";
import { AdapterRegistry } from "../../adapters/registry";
import { ReadinessService } from "../../readiness";
import { OperatorKind } from "@orca/contracts";

export interface OperatorDescriptor {
  id: string;
  kind: OperatorKind;
  displayName: string;
  capabilities: string[];
  ready: boolean;
  notReadyReason?: string;
  supportsRepoEditing: boolean;
  supportsTerminal: boolean;
}

const AGENT_CAPABILITIES: Record<string, string[]> = {
  "claude-code": ["repo_navigation", "architecture", "refactoring", "planning", "code_editing"],
  "codex":       ["implementation", "patching", "test_fixing", "code_editing"],
  "gemini":      ["large_context_review", "alternative_analysis", "qa", "architecture_review"],
  "opencode":    ["local_coding", "implementation", "code_editing"],
};

export class OperatorRegistry {
  constructor(
    private adapters: AdapterRegistry,
    private models: ModelProviderRegistry,
    private readiness: ReadinessService,
  ) {}

  async list(goalId: string): Promise<OperatorDescriptor[]> {
    const out: OperatorDescriptor[] = [];
    // Agents
    for (const adapter of this.adapters.listAgentAdapters()) {
      const r = await this.readiness.check(adapter.id);
      out.push({
        id: `agent:${adapter.id}`,
        kind: "agent",
        displayName: adapter.displayName,
        capabilities: AGENT_CAPABILITIES[adapter.id] ?? [],
        ready: r.status === "ready",
        notReadyReason: r.status === "ready" ? undefined : r.reason,
        supportsRepoEditing: adapter.supportsRepoEditing ?? true,
        supportsTerminal: adapter.supportsTerminal ?? true,
      });
    }
    // Models
    for (const p of this.models.list()) {
      const avail = await p.isAvailable();
      const models = await p.listModels();
      for (const m of models) {
        out.push({
          id: `${p.id}:${m.id}`,
          kind: "model",
          displayName: `${p.displayName} ${m.displayName}`,
          capabilities: m.capabilities,
          ready: avail.available,
          notReadyReason: avail.reason,
          supportsRepoEditing: false,
          supportsTerminal: false,
        });
      }
    }
    // Human
    out.push({
      id: "human", kind: "human", displayName: "Human (you)",
      capabilities: ["judgment", "qa", "approval"],
      ready: true, supportsRepoEditing: true, supportsTerminal: true,
    });
    return out;
  }
}
```

Add route `GET /v1/operators?goalId=`. Add `operatorRegistry: OperatorRegistry` to `DaemonContext`.

**Affected Areas.**
- `apps/daemon/src/workflows/operators/registry.ts` (NEW)
- `apps/daemon/src/workflows/operators/registry.test.ts` (NEW)
- `apps/daemon/src/daemon-context.ts` (extend)
- `apps/daemon/src/server.ts` (mount)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/operators` PASS.
- Tests: lists agents (with readiness), expands models to provider:model pairs, includes human; ready flag flips when readiness check is `not_ready`.

**Acceptance Criteria.**
- Output stable and ordered; ids match the format `agent:<id>` / `<providerId>:<modelId>` / `human`.

---

### M8-014 — Operator Selection Service

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Chooses the best operator for a step run by calling the Goal's configured Orchestrator LLM with a structured prompt. Returns a typed `OperatorSelection`. Validates the selected operator id is in the operator registry and not denied by guardrails using pure evaluation; if invalid, retries with the bad id excluded once, else falls back to a deterministic ranker. Guardrail evaluation rows are persisted later by M8-016 inside the final decision transaction.

**Scope.**
- IS: bounded prompt builder, schema enforcement, fallback ranker, guardrail integration, persistence on `workflow_decisions.operator_selection_json`.
- IS NOT: end-to-end orchestrator decision routing (M8-016).

**Requirements.**

Create `apps/daemon/src/workflows/operators/selector.ts`:

```ts
import { z } from "zod";
import { OperatorSelection, WorkflowGuardrailConfig } from "@orca/contracts";
import { ModelProviderRegistry } from "../../llm/registry";
import { OperatorRegistry, OperatorDescriptor } from "./registry";
import { evaluateGuardrail, GuardrailContext } from "../guardrails/evaluator";
import { Database } from "better-sqlite3";

const OperatorSelectionSchema = z.object({
  operatorId: z.string().min(1).max(100),
  operatorKind: z.enum(["agent","model","human"]),
  reason: z.string().max(2048),
  requiredCapabilities: z.array(z.string().min(1).max(80)).max(20),
  alternativesConsidered: z.array(z.string().min(1).max(100)).max(8),
  confidence: z.number().min(0).max(1),
  requiresUserApproval: z.boolean(),
});

export interface SelectorInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  stepName: string;
  stepPurpose: string;
  recommendedCapabilities: string[];
  recommendedOperatorIds: string[];
  guardrails: WorkflowGuardrailConfig[];
  orchestratorProvider: import("@orca/contracts").ModelProviderId | null;
  orchestratorModel: string | null;
}

export class OperatorSelector {
  constructor(
    private providers: ModelProviderRegistry,
    private operators: OperatorRegistry,
  ) {}

  async select(db: Database, now: () => string, input: SelectorInput): Promise<{ selection: OperatorSelection; source: "llm" | "fallback"; llmCallId?: string }> {
    const allOperators = await this.operators.list(input.goalId);
    const readyOperators = allOperators.filter(o => o.ready);
    if (readyOperators.length === 0) {
      throw new Error("no_ready_operators");
    }
    // Try LLM
    const provider = input.orchestratorProvider ? this.providers.get(input.orchestratorProvider) : null;
    if (provider && input.orchestratorModel) {
      try {
        const sel = await this.callLlm(provider, input, readyOperators);
        if (this.validateAgainstRegistry(sel, readyOperators) && this.validateGuardrails(db, now, sel, input)) {
          return { selection: sel, source: "llm" };
        }
      } catch { /* fall through */ }
    }
    return { selection: this.fallbackRank(input, readyOperators), source: "fallback" };
  }

  private async callLlm(
    provider: ReturnType<ModelProviderRegistry["get"]> & object,
    input: SelectorInput, readyOperators: OperatorDescriptor[],
  ): Promise<OperatorSelection> {
    const systemPrompt = [
      "You select the best operator for a workflow step.",
      "You MUST choose an operator from the READY operators list.",
      "You MUST justify the choice with a reason field.",
      "Prefer operators whose capabilities match the recommendedCapabilities.",
      "Prefer cheaper operators when several would suffice.",
    ].join("\n");
    const userPrompt = JSON.stringify({
      stepName: input.stepName,
      stepPurpose: input.stepPurpose,
      recommendedCapabilities: input.recommendedCapabilities,
      recommendedOperatorIds: input.recommendedOperatorIds,
      readyOperators: readyOperators.map(o => ({ id: o.id, kind: o.kind, capabilities: o.capabilities })),
    });
    const res = await provider.complete<OperatorSelection>({
      model: input.orchestratorModel!,
      systemPrompt, userPrompt,
      responseSchemaName: "OperatorSelection",
      responseSchema: OperatorSelectionSchema,
      maxOutputTokens: 512,
      temperature: 0,
      callMetadata: { goalId: input.goalId, workflowRunId: input.workflowRunId, stepRunId: input.stepRunId },
    });
    return res.parsed;
  }

  private validateAgainstRegistry(sel: OperatorSelection, ready: OperatorDescriptor[]): boolean {
    return ready.some(o => o.id === sel.operatorId && o.kind === sel.operatorKind);
  }

  private validateGuardrails(db: Database, now: () => string, sel: OperatorSelection, input: SelectorInput): boolean {
    const ctx: GuardrailContext = {
      goalId: input.goalId, workflowRunId: input.workflowRunId, stepRunId: input.stepRunId,
      stepTemplateId: input.stepName,
      candidateAction: { kind: "select_operator", operatorId: sel.operatorId },
    };
    const results = input.guardrails.map(g => evaluateGuardrail(g, ctx));
    return !results.some(r => r.result === "deny");
  }

  private fallbackRank(input: SelectorInput, ready: OperatorDescriptor[]): OperatorSelection {
    // 1. recommendedOperatorIds in order
    // 2. operators whose capabilities overlap recommendedCapabilities (more overlap = better)
    // 3. human last unless step is QA/Done
    const score = (o: OperatorDescriptor): number => {
      let s = 0;
      const idxRec = input.recommendedOperatorIds.indexOf(o.id);
      if (idxRec >= 0) s += 1000 - idxRec;
      const overlap = o.capabilities.filter(c => input.recommendedCapabilities.includes(c)).length;
      s += overlap * 10;
      if (o.kind === "human") s -= 5;
      return s;
    };
    const ranked = [...ready].sort((a, b) => score(b) - score(a));
    const chosen = ranked[0];
    return {
      operatorId: chosen.id, operatorKind: chosen.kind,
      reason: "deterministic fallback: best capability match among ready operators",
      requiredCapabilities: input.recommendedCapabilities.slice(0, 20),
      alternativesConsidered: ranked.slice(1, 9).map(o => o.id),
      confidence: 0.5,
      requiresUserApproval: chosen.kind !== "human",
    };
  }
}
```

Persist a `workflow_llm_calls` row for every LLM attempt before the provider call enters `running`; update it to `succeeded` or `failed` afterward with metadata only (no prompt/response text). Wire `operatorSelector: OperatorSelector` into `DaemonContext`.

**Affected Areas.**
- `apps/daemon/src/workflows/operators/selector.ts` (NEW)
- `apps/daemon/src/workflows/operators/selector.test.ts` (NEW)
- `apps/daemon/src/daemon-context.ts` (extend)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/operators/selector` PASS.
- Tests: LLM happy path (fake provider) → returns LLM selection; LLM returns invalid id → falls back; no orchestrator model set → goes straight to fallback; no ready operators → throws.

**Acceptance Criteria.**
- Selector deterministic given identical input; LLM failures degrade gracefully; guardrail deny excludes operator.

---

### M8-015 — Decision Trace Projection + Writes

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Every orchestrator decision (start/advance/select operator/request artifact/request input/evaluate exit/mark complete/block) writes a content-bounded `workflow_decisions` row carrying influencedBy refs. UI uses these to show "why this action."

**Scope.**
- IS: `recordDecision` usecase, projection helpers (`listDecisionsForRun`, `getDecisionById`), idempotency via `(workflow_run_id, step_run_id, decision_type, input_fingerprint)` unique index, event emission.
- IS NOT: any specific decision-making policy (M8-016+).

**Requirements.**

Expose both `recordDecision` (transaction-owning public usecase) and `recordDecisionInTx` (internal helper used by M8-016). The internal helper inserts the decision row and stages `workflow.decision.recorded` in the caller's active transaction so orchestrator decisions, guardrail evaluations, and recommendation creation can commit together.

Create `apps/daemon/src/workflows/decisions/usecases.ts`:

```ts
import { Database } from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { WorkflowDecisionTrace, WorkflowDecisionType, WorkflowDecisionInfluence, OperatorSelection } from "@orca/contracts";
import { appendWorkflowEvent } from "../events";

export interface RecordDecisionInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string | null;
  decisionType: WorkflowDecisionType;
  selectedAction: string;
  reason: string;
  influencedBy: WorkflowDecisionInfluence[];
  alternativesConsidered?: string[];
  confidence?: number;
  operatorSelection?: OperatorSelection;
  inputFingerprint: string;
}

export function decisionFingerprint(parts: { runId: string; stepRunId: string | null; decisionType: string; payload: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.runId, parts.stepRunId, parts.decisionType, parts.payload]))
    .digest("hex");
}

export function recordDecision(db: Database, now: () => string, input: RecordDecisionInput): WorkflowDecisionTrace {
  const existing: any = db.prepare(`SELECT id FROM workflow_decisions
    WHERE workflow_run_id=? AND COALESCE(step_run_id,'')=? AND decision_type=? AND input_fingerprint=?`)
    .get(input.workflowRunId, input.stepRunId ?? "", input.decisionType, input.inputFingerprint);
  if (existing) return readDecision(db, existing.id);
  const id = randomUUID();
  return db.transaction(() => {
    db.prepare(`INSERT INTO workflow_decisions
      (id, goal_id, workflow_run_id, step_run_id, decision_type, selected_action, reason,
       influenced_by_json, alternatives_considered_json, confidence,
       operator_selection_json, input_fingerprint, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.goalId, input.workflowRunId, input.stepRunId, input.decisionType,
        input.selectedAction.slice(0, 200), input.reason.slice(0, 1024),
        JSON.stringify(input.influencedBy.slice(0, 32)),
        JSON.stringify((input.alternativesConsidered ?? []).slice(0, 8)),
        input.confidence ?? null,
        input.operatorSelection ? JSON.stringify(input.operatorSelection) : null,
        input.inputFingerprint, now());
    appendWorkflowEvent(db, "workflow.decision.recorded", {
      decisionId: id, goalId: input.goalId, workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId, decisionType: input.decisionType,
      influencedByCount: input.influencedBy.length,
    });
    return readDecision(db, id);
  })();
}

function readDecision(db: Database, id: string): WorkflowDecisionTrace {
  const row: any = db.prepare(`SELECT * FROM workflow_decisions WHERE id=?`).get(id);
  return {
    decisionId: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id, stepRunId: row.step_run_id,
    decisionType: row.decision_type, selectedAction: row.selected_action, reason: row.reason,
    influencedBy: JSON.parse(row.influenced_by_json),
    alternativesConsidered: JSON.parse(row.alternatives_considered_json),
    confidence: row.confidence ?? undefined,
    operatorSelectionJson: row.operator_selection_json ? JSON.parse(row.operator_selection_json) : undefined,
    createdAt: row.created_at,
  };
}

export function listDecisionsForRun(db: Database, runId: string): WorkflowDecisionTrace[] {
  return db.prepare(`SELECT id FROM workflow_decisions WHERE workflow_run_id=? ORDER BY created_at DESC`)
    .all(runId).map((r: any) => readDecision(db, r.id));
}
```

Routes:
```
GET /v1/goals/:goalId/workflow-runs/:runId/decisions → listDecisionsForRun (404 if run.goal_id differs)
GET /v1/goals/:goalId/workflow-decisions/:id    → readDecision (404 if decision.goal_id differs)
```

**Affected Areas.**
- `apps/daemon/src/workflows/decisions/usecases.ts` (NEW)
- `apps/daemon/src/workflows/decisions/usecases.test.ts` (NEW)
- `apps/daemon/src/workflows/decisions/routes.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/decisions` PASS.
- Tests: write + read; fingerprint dedup returns same row; oversize `reason` truncated to 1024; over-32 influences truncated.

**Acceptance Criteria.**
- Decisions persist with influencedBy refs; events stay content-free.

---

### M8-016 — Orchestrator Decision Service

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** The brain that translates current workflow state into the next structured decision. Returns the decision + (when actionable) creates M7 recommendations. Replaces no existing logic — this is the new path the Workflows tab and chat invoke.

**Scope.**
- IS: `OrchestratorService.requestNextDecision(workflowRunId)`, gates on guardrails, uses M8-014 selector for operator decisions, writes via M8-015, emits `workflow.decision.requested` and `workflow.decision.recorded`.
- IS NOT: per-step rule logic (M8-020), UI (M8-023).

**Requirements.**

`requestNextDecision` MUST use one outer SQLite transaction for the selected branch after any external LLM call returns. Decision rows, guardrail evaluation rows, recommendation rows, workflow state changes, and workflow events for that branch are inserted in that single transaction; staged events publish only after commit. Avoid nested independent transactions in `recordDecision`, `evaluateAllGuardrails`, and `createRecommendationForWorkflow` by exposing internal helpers that can participate in the caller's active transaction. The skeleton below shows logical ordering, not permission to split the write across commits.

Create `apps/daemon/src/workflows/orchestrator/service.ts`:

```ts
import { Database } from "better-sqlite3";
import { WorkflowDecisionTrace } from "@orca/contracts";
import { getTemplateById } from "../templates/projection";
import { recordDecision, decisionFingerprint } from "../decisions/usecases";
import { listArtifactsForRun } from "../artifacts/projection";
import { OperatorSelector } from "../operators/selector";
import { advanceToNextStep, markStepBlocked } from "../steps/usecases";
import { evaluateAllGuardrails } from "../guardrails/evaluator";
import { appendWorkflowEvent } from "../events";
import { createRecommendationForWorkflow } from "./workflow-recommendations"; // M8-017

export class OrchestratorService {
  constructor(private operatorSelector: OperatorSelector) {}

  async requestNextDecision(
    db: Database, now: () => string, workflowRunId: string,
  ): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
    const run: any = db.prepare(`SELECT * FROM workflow_runs WHERE id=?`).get(workflowRunId);
    if (!run) throw new Error("run_not_found");
    if (run.status !== "active") throw new Error("run_not_active");
    const template = getTemplateById(db, run.template_id)!;
    const stepRun: any = db.prepare(`SELECT * FROM workflow_step_runs WHERE id=?`).get(run.current_step_run_id);
    const stepTpl = template.steps.find(s => s.id === stepRun.step_template_id)!;
    const artifacts = listArtifactsForRun(db, workflowRunId);
    const goal: any = db.prepare(`SELECT * FROM goals WHERE id=?`).get(run.goal_id);

    appendWorkflowEvent(db, "workflow.decision.requested", {
      goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id, stepTemplateId: stepTpl.id,
    });

    // 1. Required inputs satisfied?
    const missingInputs = stepTpl.requiredInputs.filter(t => !artifacts.some(a => a.type === t));
    if (missingInputs.length > 0) {
      const decision = recordDecision(db, now, {
        goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
        decisionType: "request_artifact",
        selectedAction: `request:${missingInputs[0]}`,
        reason: `Step requires inputs: ${missingInputs.join(",")}`,
        influencedBy: missingInputs.map(t => ({ kind: "artifact" as const, id: t, label: t, effect: "missing" as const })),
        inputFingerprint: decisionFingerprint({ runId: workflowRunId, stepRunId: stepRun.id, decisionType: "request_artifact", payload: missingInputs }),
      });
      return { decision, recommendationIds: [] };
    }

    // 2. Outstanding exit criteria?
    const outstanding: string[] = JSON.parse(stepRun.outstanding_exit_criteria_json);
    if (outstanding.length === 0) {
      const nextStepTpl = template.steps.find(s => s.ordinal === stepRun.ordinal + 1);
      const completing = !nextStepTpl;
      const decision = recordDecision(db, now, {
        goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
        decisionType: completing ? "mark_run_complete" : "advance_step",
        selectedAction: completing ? "recommend_complete_run" : `recommend_advance:${nextStepTpl.id}`,
        reason: completing
          ? "Final step criteria satisfied; user approval required before completing the run"
          : "All exit criteria satisfied; user approval required before advancing",
        influencedBy: [{ kind: "workflow_step", id: stepTpl.id, label: stepTpl.name, effect: "satisfied" }],
        inputFingerprint: decisionFingerprint({ runId: workflowRunId, stepRunId: stepRun.id, decisionType: completing ? "mark_run_complete" : "advance_step", payload: nextStepTpl?.id ?? "complete" }),
      });
      const recId = createRecommendationForWorkflow(db, now, {
        goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
        type: completing ? "complete_workflow_run" : "advance_workflow_step",
        proposedAction: completing
          ? { kind: "complete_workflow_run", workflowRunId, workflowStepRunId: stepRun.id }
          : { kind: "advance_workflow_step", workflowRunId, workflowStepRunId: stepRun.id, toStepTemplateId: nextStepTpl.id },
        rationale: completing
          ? "Final step criteria are satisfied; approve to complete the workflow run."
          : "All exit criteria satisfied; approve to advance to the next workflow step.",
        decisionId: decision.decisionId,
      });
      return { decision, recommendationIds: [recId] };
    }

    // 3. Select operator if gate allows
    if (stepTpl.gateType === "human-input") {
      const decision = recordDecision(db, now, {
        goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
        decisionType: "request_user_input", selectedAction: `request_input:${stepTpl.id}`,
        reason: stepTpl.purpose,
        influencedBy: outstanding.map(c => ({ kind: "workflow_step" as const, id: stepTpl.id, label: c, effect: "required" as const })),
        inputFingerprint: decisionFingerprint({ runId: workflowRunId, stepRunId: stepRun.id, decisionType: "request_user_input", payload: outstanding }),
      });
      const recId = createRecommendationForWorkflow(db, now, {
        goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
        type: "request_user_input",
        proposedAction: { kind: "request_user_input", workflowStepRunId: stepRun.id, question: stepTpl.purpose },
        rationale: stepTpl.purpose, decisionId: decision.decisionId,
      });
      return { decision, recommendationIds: [recId] };
    }

    // operator selection path
    const result = await this.operatorSelector.select(db, now, {
      goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
      stepName: stepTpl.id, stepPurpose: stepTpl.purpose,
      recommendedCapabilities: stepTpl.recommendedCapabilities,
      recommendedOperatorIds: stepTpl.recommendedOperatorIds,
      guardrails: template.guardrails,
      orchestratorProvider: goal.orchestrator_provider,
      orchestratorModel: goal.orchestrator_model,
    });

    const guardCtx = {
      goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id, stepTemplateId: stepTpl.id,
      candidateAction: { kind: "launch_workflow_session" as const, operatorId: result.selection.operatorId },
    };
    const guardResults = evaluateAllGuardrails(db, now, template.guardrails, guardCtx, null);
    const requiresApproval = guardResults.some(r => r.result === "require_approval") || result.selection.requiresUserApproval;
    const denied = guardResults.find(r => r.result === "deny");
    if (denied) {
      markStepBlocked(db, now, stepRun.id, `Guardrail ${denied.guardrailId} denied selected operator`);
      const decision = recordDecision(db, now, {
        goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
        decisionType: "block_run", selectedAction: `block:${denied.guardrailId}`,
        reason: denied.message ?? "guardrail denied",
        influencedBy: [{ kind: "guardrail", id: denied.guardrailId, label: denied.kind, effect: "blocked" }],
        operatorSelection: result.selection,
        inputFingerprint: decisionFingerprint({ runId: workflowRunId, stepRunId: stepRun.id, decisionType: "block_run", payload: denied.guardrailId }),
      });
      return { decision, recommendationIds: [] };
    }

    const decision = recordDecision(db, now, {
      goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
      decisionType: "select_operator", selectedAction: `select:${result.selection.operatorId}`,
      reason: result.selection.reason,
      influencedBy: [
        { kind: "workflow_step", id: stepTpl.id, label: stepTpl.name, effect: "preferred" },
        { kind: "operator_readiness", id: result.selection.operatorId, label: result.selection.operatorId, effect: "satisfied" },
        ...guardResults.filter(r => r.result === "require_approval").map(r => ({
          kind: "guardrail" as const, id: r.guardrailId, label: r.kind, effect: "required" as const,
        })),
      ],
      alternativesConsidered: result.selection.alternativesConsidered,
      confidence: result.selection.confidence,
      operatorSelection: result.selection,
      inputFingerprint: decisionFingerprint({ runId: workflowRunId, stepRunId: stepRun.id, decisionType: "select_operator", payload: { op: result.selection.operatorId, source: result.source } }),
    });

    appendWorkflowEvent(db, "workflow.operator.selected", {
      decisionId: decision.decisionId, goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
      operatorId: result.selection.operatorId, operatorKind: result.selection.operatorKind,
      source: result.source, requiresApproval,
    });

    const recId = createRecommendationForWorkflow(db, now, {
      goalId: run.goal_id, workflowRunId, stepRunId: stepRun.id,
      type: "launch_workflow_session",
      proposedAction: {
        kind: "launch_workflow_session",
        workflowStepRunId: stepRun.id,
        operatorId: result.selection.operatorId,
        operatorKind: result.selection.operatorKind,
        objective: stepTpl.purpose,
      },
      rationale: result.selection.reason,
      decisionId: decision.decisionId,
    });

    return { decision, recommendationIds: [recId] };
  }
}
```

Add route `POST /v1/goals/:goalId/workflow-runs/:id/next-decision` returning `NextOrchestratorDecisionResponse` (404 if run.goal_id differs).

**Affected Areas.**
- `apps/daemon/src/workflows/orchestrator/service.ts` (NEW)
- `apps/daemon/src/workflows/orchestrator/service.test.ts` (NEW)
- `apps/daemon/src/workflows/orchestrator/routes.ts` (NEW)
- `apps/daemon/src/server.ts` (mount)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/orchestrator` PASS.
- Tests with fake operator selector: missing-input branch produces `request_artifact`; outstanding-criteria branch invokes selector and produces `select_operator` + recommendation; satisfied-exit branch produces an `advance_workflow_step` recommendation without mutating the run until accepted; guardrail-deny branch blocks step.

**Acceptance Criteria.**
- One call → exactly one decision row → matching events; recommendation ids returned.

---

### M8-017 — M7 Integration: Workflow Recommendation Types + Issue Breakdown → M7 Tasks

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Wire workflow runtime into existing M7 infrastructure. New recommendation types use M7's accept-flow; Issue Breakdown writes M7 tasks tagged with `workflow_step_run_id`.

**Scope.**
- IS: extend M7 `RecommendationType` + `ProposedAction` schemas with new workflow kinds, add helper `createRecommendationForWorkflow`, update M7 recommendation usecases to accept new types, extend M7 task usecase to accept `workflow_step_run_id` and expose a transaction-participating `createTaskInTx`, M8 deterministic Issue Breakdown writer that validates dependencies through the existing M7 rules.
- IS NOT: PRD → ticket *content generation* (M8-020 handles per-step rules).

**Requirements.**

Update `packages/contracts/src/index.ts` (extending existing M7 schemas):

```ts
// Append to existing RecommendationType union
export const WorkflowRecommendationType = z.enum([
  "advance_workflow_step",
  "launch_workflow_session",
  "complete_workflow_run",
  "mark_artifact_satisfied",
  "request_user_input",
]);
// And add into existing RecommendationType union: ...existing literals, ...WorkflowRecommendationType.options

// Append to existing ProposedAction discriminated union:
export const ProposedActionAdvanceWorkflowStep = z.object({
  kind: z.literal("advance_workflow_step"),
  workflowRunId: z.string(),
  workflowStepRunId: z.string(),
  toStepTemplateId: z.string(),
});
export const ProposedActionLaunchWorkflowSession = z.object({
  kind: z.literal("launch_workflow_session"),
  workflowStepRunId: z.string(),
  operatorId: z.string(),
  operatorKind: OperatorKind,
  objective: z.string().max(2048),
  workspaceId: z.string().optional(),
  contextPackageId: z.string().optional(),
});
export const ProposedActionCompleteWorkflowRun = z.object({
  kind: z.literal("complete_workflow_run"),
  workflowRunId: z.string(),
  workflowStepRunId: z.string(),
});
export const ProposedActionMarkArtifactSatisfied = z.object({
  kind: z.literal("mark_artifact_satisfied"),
  workflowStepRunId: z.string(),
  artifactType: WorkflowArtifactType,
});
export const ProposedActionRequestUserInput = z.object({
  kind: z.literal("request_user_input"),
  workflowStepRunId: z.string(),
  question: z.string().max(2048),
});
```

Create `apps/daemon/src/workflows/orchestrator/workflow-recommendations.ts`:

```ts
import { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { TaskRole } from "@orca/contracts";
import { createTaskInTx, ensureDependenciesBelongToGoal } from "../../tasks/usecases";
import { appendWorkflowEvent } from "../events";

export interface CreateWorkflowRecommendationInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  type: "advance_workflow_step" | "launch_workflow_session" | "complete_workflow_run" | "mark_artifact_satisfied" | "request_user_input";
  proposedAction: unknown;
  rationale: string;
  decisionId: string;
}

export function createRecommendationForWorkflow(
  db: Database, now: () => string, input: CreateWorkflowRecommendationInput,
): string {
  const id = randomUUID();
  const fingerprint = `${input.goalId}:${input.type}:${JSON.stringify(input.proposedAction)}`;
  db.transaction(() => {
    db.prepare(`UPDATE recommendations
      SET status='superseded', superseded_reason='duplicate', updated_at=?
      WHERE goal_id=? AND type=? AND status='proposed'`).run(now(), input.goalId, input.type);
    db.prepare(`INSERT INTO recommendations
      (id, goal_id, type, status, source, title, rationale, proposed_action_json, confidence,
       sources_json, related_task_id, related_session_id, related_context_pkg_id, related_conflict_id,
       fingerprint, superseded_by_id, superseded_reason, created_at, updated_at, resolved_at, workflow_step_run_id)
      VALUES (?,?,?,'proposed','deterministic_provider',?,?,?,?,'[]',NULL,NULL,NULL,NULL,?,NULL,NULL,?,?,NULL,?)`).run(
        id, input.goalId, input.type,
        `Workflow ${input.type}`, input.rationale.slice(0, 4096),
        JSON.stringify(input.proposedAction), 0.8,
        fingerprint.slice(0, 256), now(), now(), input.stepRunId);
    appendWorkflowEvent(db, "workflow.recommendation.created", {
      recommendationId: id, goalId: input.goalId,
      workflowRunId: input.workflowRunId, stepRunId: input.stepRunId,
      type: input.type, decisionId: input.decisionId,
    });
  })();
  return id;
}
```

Extend M7 recommendation `accept` route to detect `workflow_step_run_id` on the row and:
- For `launch_workflow_session`: return `proposedAction` so the UI prefills the existing M4 session creation flow with `workflowStepRunId` populated.
- For `request_user_input`: return the question; UI surfaces input box in the chat panel.
- For `advance_workflow_step`: call `advanceToNextStep(db, now, stepRunId)` directly (this is a benign workflow-internal action, not an external execution — explicitly allowed by suggestion-only rule).
- For `complete_workflow_run`: call `completeRun(db, now, workflowRunId)` directly after verifying the current step is the final step and its exit criteria are satisfied.
- For `mark_artifact_satisfied`: call `recordExitCriteriaSatisfaction` then re-evaluate orchestrator decision.

`createRecommendationForWorkflow` must have both a transaction-owning public wrapper and an internal helper for M8-016. When called from `requestNextDecision`, it participates in that outer transaction so the decision row, recommendation row, and workflow events commit atomically.

Create `apps/daemon/src/workflows/orchestrator/issue-breakdown.ts`:

```ts
import { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { appendWorkflowEvent } from "../events";

export interface PrdSectionToTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  validationSteps: string[];
  role: TaskRole;
  workspaceId?: string;
  dependencies: string[];
}

export function writeIssueBreakdown(
  db: Database, now: () => string,
  args: { goalId: string; workflowRunId: string; stepRunId: string; tasks: PrdSectionToTask[] },
): { taskIds: string[] } {
  const taskIds: string[] = [];
  db.transaction(() => {
    for (const t of args.tasks) {
      ensureDependenciesBelongToGoal(db, args.goalId, t.dependencies);
      const task = createTaskInTx(db, now, {
        origin: "generator", status: "proposed",
        goalId: args.goalId, role: t.role, title: t.title, description: t.description,
        workspaceId: t.workspaceId ?? null, dependencies: t.dependencies,
        workflowStepRunId: args.stepRunId,
        acceptanceCriteria: t.acceptanceCriteria.map(text => ({ id: randomUUID(), text })),
        validationSteps: t.validationSteps.map(text => ({ id: randomUUID(), text, kind: "test" })),
      });
      taskIds.push(task.id);
    }
    appendWorkflowEvent(db, "workflow.task.dag.created", {
      workflowRunId: args.workflowRunId, stepRunId: args.stepRunId,
      taskIds, count: taskIds.length,
    });
  })();
  return taskIds;
}
```

**Affected Areas.**
- `packages/contracts/src/index.ts` (extend M7 unions)
- `apps/daemon/src/workflows/orchestrator/workflow-recommendations.ts` (NEW)
- `apps/daemon/src/workflows/orchestrator/issue-breakdown.ts` (NEW)
- `apps/daemon/src/recommendations/usecases.ts` (extend accept route)
- `apps/daemon/src/recommendations/usecases.test.ts` (extend)

**Validation Steps.**
- `pnpm --filter @orca/daemon test recommendations workflows/orchestrator` PASS.
- Tests: workflow recommendation created → appears in M7 list; accepting `launch_workflow_session` returns `proposedAction`; accepting `advance_workflow_step` advances step run; Issue Breakdown writes N tasks with `workflow_step_run_id` set.

**Acceptance Criteria.**
- M7 recommendation flow handles workflow types end-to-end.

---

### M8-018 — Consolidated HTTP Surface + Test Wiring (GATE: full-suite typecheck + test)

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Consolidate every M8 route, ensure all are mounted, request bodies validated with zod at boundary, and integration tests cover the public API surface.

**Scope.**
- IS: route registration audit, request validation pass, integration test that drives full HTTP surface against an in-memory daemon.
- IS NOT: per-step rules (M8-020), UI.

**Requirements.**

Inventory routes (must all exist after this task):

```
# Workflow templates
GET    /v1/workflow-templates
GET    /v1/workflow-templates/:id
POST   /v1/workflow-templates
PATCH  /v1/workflow-templates/:id
POST   /v1/workflow-templates/:id/duplicate

# Workflow runs
POST   /v1/goals/:goalId/workflow-runs
GET    /v1/goals/:goalId/workflow-runs
GET    /v1/goals/:goalId/workflow-runs/:id
POST   /v1/goals/:goalId/workflow-runs/:id/pause
POST   /v1/goals/:goalId/workflow-runs/:id/resume
POST   /v1/goals/:goalId/workflow-runs/:id/cancel
POST   /v1/goals/:goalId/workflow-runs/:id/next-decision
GET    /v1/goals/:goalId/workflow-runs/:id/decisions
GET    /v1/goals/:goalId/workflow-runs/:runId/artifacts

# Step runs
GET    /v1/goals/:goalId/workflow-step-runs/:id
POST   /v1/goals/:goalId/workflow-step-runs/:id/submit-input

# Artifacts
POST   /v1/goals/:goalId/workflow-artifacts
GET    /v1/goals/:goalId/workflow-artifacts
GET    /v1/goals/:goalId/workflow-artifacts/:id

# Decisions
GET    /v1/goals/:goalId/workflow-decisions/:id

# Operators + providers
GET    /v1/operators?goalId=
GET    /v1/model-providers

# Goal extension
PATCH  /v1/goals/:goalId/orchestrator-model
```

Add `apps/daemon/src/workflows/__tests__/http-surface.test.ts` that boots the daemon with fakes, hits every route, asserts 200/400/404 status patterns, and validates response schemas.

**Gate.** `pnpm -r typecheck && pnpm -r test` PASS. Record green SHA in `docs/implementation-plans/notes/m8-018-gate.md`.

**Affected Areas.**
- `apps/daemon/src/server.ts` (route audit)
- `apps/daemon/src/workflows/__tests__/http-surface.test.ts` (NEW)
- `docs/implementation-plans/notes/m8-018-gate.md` (NEW)

**Validation Steps.**
- All listed routes return expected status codes.
- `pnpm -r typecheck && pnpm -r test` PASS.

**Acceptance Criteria.**
- Surface complete, integration test green.

---

### M8-019 — Workflow Event Emission Audit

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Every state transition emits the canonical event from the contracts enum. Confirm payloads stay content-free (≤4 KiB serialized, ids/counts/status only) and include `goalId` for every goal-scoped workflow event via a static test.

**Scope.**
- IS: contract audit, missing-emit fixes, byte-cap test, payload-content test.
- IS NOT: subscribers (M8-021 reconcile is in scope; ad-hoc consumers are not).

**Requirements.**

Add `apps/daemon/src/workflows/__tests__/event-payload-caps.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { M8EventType } from "@orca/contracts";

describe("M8 events stay content-free", () => {
  test("every M8 event literal exists in contracts and has a payload schema", () => {
    for (const type of M8EventType.options) {
      expect(type.startsWith("workflow.")).toBe(true);
    }
  });
  // Per-payload sample: construct min and max payloads, JSON.stringify <= 4096
});
```

Add `apps/daemon/src/workflows/__tests__/event-emit-coverage.test.ts` that runs the full Engineering happy path through fakes and asserts every event in `M8EventType.options` was emitted at least once (except optional ones like `workflow.run.failed`) and that every run/step/artifact/decision/guardrail/operator/recommendation event carries the correct `goalId`.

Audit each usecase file to ensure event emission is inside the same TX as the row mutation; fix any leaks.

**Affected Areas.**
- `apps/daemon/src/workflows/__tests__/event-payload-caps.test.ts` (NEW)
- `apps/daemon/src/workflows/__tests__/event-emit-coverage.test.ts` (NEW)
- Various usecase files (fix omissions)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/__tests__/event` PASS.

**Acceptance Criteria.**
- Every workflow state change emits the canonical event with ≤4 KiB payload.

---

### M8-020 — Per-Step Deterministic Rules (Intake → Done)

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Encode the deterministic logic the orchestrator service uses to evaluate exit criteria, generate per-step prompts for LLM operators, and translate user input into artifacts. One rule module per Engineering step; pure functions; no LLM calls (LLM calls happen via M8-014 selector or per-step prompt builders that the dispatcher invokes).

**Scope.**
- IS: eight per-step rule files, one shared `StepRule` interface, exit-criteria heuristics, artifact templates.
- IS NOT: end-to-end agent dispatch (uses M7 accept flow already wired in M8-017).

**Requirements.**

Create `apps/daemon/src/workflows/steps/rules/types.ts`:

```ts
import { WorkflowArtifact } from "@orca/contracts";

export interface StepRuleContext {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  artifacts: WorkflowArtifact[];
  satisfiedExitCriteria: string[];
  outstandingExitCriteria: string[];
}

export interface NextQuestion {
  question: string;
  optionalChoices?: string[];
}

export interface StepRule {
  stepTemplateId: string;
  evaluateUserInputAsArtifact?(input: { answerText: string; ctx: StepRuleContext }): {
    artifact?: { type: string; title: string; body: string };
    satisfiedCriteria: string[];
  };
  nextQuestion?(ctx: StepRuleContext): NextQuestion | null;
  evaluateArtifactSatisfies?(artifact: WorkflowArtifact, ctx: StepRuleContext): string[];
}
```

Create files (sketches; full implementations follow the same pattern):

`intake.ts`:
```ts
import { StepRule } from "./types";
export const intakeRule: StepRule = {
  stepTemplateId: "intake",
  nextQuestion(ctx) {
    if (!ctx.satisfiedExitCriteria.includes("problem statement exists"))
      return { question: "What problem are we solving?" };
    if (!ctx.satisfiedExitCriteria.includes("desired outcome exists"))
      return { question: "What's the desired outcome / end state?" };
    if (!ctx.satisfiedExitCriteria.includes("success criteria exist"))
      return { question: "How will we know we're done? Give 3 concrete success criteria." };
    if (!ctx.satisfiedExitCriteria.includes("known constraints captured"))
      return { question: "Any constraints (deadlines, infra, performance, compliance)?" };
    if (!ctx.satisfiedExitCriteria.includes("unresolved questions captured or resolved"))
      return { question: "Any open questions you want flagged before we plan?" };
    return null;
  },
  evaluateUserInputAsArtifact({ answerText, ctx }) {
    if (!ctx.satisfiedExitCriteria.includes("problem statement exists")) {
      return {
        artifact: { type: "goal_brief", title: "Goal Brief (draft)", body: `# Problem\n\n${answerText}` },
        satisfiedCriteria: ["problem statement exists"],
      };
    }
    // ... append sections to existing goal_brief artifact in subsequent calls
    const last = ctx.artifacts.filter(a => a.type === "goal_brief").at(-1);
    const append = (label: string, criterion: string) => ({
      artifact: { type: "goal_brief", title: "Goal Brief (draft)", body: `${last?.body ?? ""}\n\n## ${label}\n\n${answerText}` },
      satisfiedCriteria: [criterion],
    });
    if (!ctx.satisfiedExitCriteria.includes("desired outcome exists"))
      return append("Desired Outcome", "desired outcome exists");
    if (!ctx.satisfiedExitCriteria.includes("success criteria exist"))
      return append("Success Criteria", "success criteria exist");
    if (!ctx.satisfiedExitCriteria.includes("known constraints captured"))
      return append("Constraints", "known constraints captured");
    return append("Open Questions", "unresolved questions captured or resolved");
  },
};
```

`research.ts`, `prd.ts`, `qa.ts`, `review.ts`, `done.ts`: implement `evaluateArtifactSatisfies` that returns the criteria names satisfied when a matching artifact is produced (e.g., `research_summary` → satisfies all five research exit criteria when present and non-empty).

`issue_breakdown.ts`: when an `issue_breakdown` artifact is created, parses the JSON-encoded body, calls `writeIssueBreakdown` (M8-017), and emits the resulting task ids.

`execution.ts`: when the most recent associated session emits `session.completed` with summary `outcome='succeeded'`, satisfies "assigned task completed or blocked with reason" and "validation run or skipped with reason" based on summary fields.

Register all rules in `apps/daemon/src/workflows/steps/rules/index.ts`:

```ts
import { StepRule } from "./types";
import { intakeRule } from "./intake";
import { researchRule } from "./research";
import { prdRule } from "./prd";
import { issueBreakdownRule } from "./issue_breakdown";
import { executionRule } from "./execution";
import { qaRule } from "./qa";
import { reviewRule } from "./review";
import { doneRule } from "./done";

export const stepRules: Record<string, StepRule> = {
  intake: intakeRule, research: researchRule, prd: prdRule,
  issue_breakdown: issueBreakdownRule, execution: executionRule,
  qa: qaRule, review: reviewRule, done: doneRule,
};
```

Wire into orchestrator service:
- `requestNextDecision` consults `stepRules[stepTemplateId].nextQuestion` for `human-input` gate.
- `submitWorkflowUserInput` route uses `evaluateUserInputAsArtifact` to create artifact + mark criteria satisfied in one TX, then re-runs orchestrator decision.
- When any artifact is created, call `evaluateArtifactSatisfies` for the current step rule and record satisfaction.

**Affected Areas.**
- `apps/daemon/src/workflows/steps/rules/*.ts` (NEW, 9 files including types.ts + index.ts)
- `apps/daemon/src/workflows/steps/rules/*.test.ts` (NEW per rule)
- `apps/daemon/src/workflows/orchestrator/service.ts` (consult rules)
- `apps/daemon/src/workflows/orchestrator/routes.ts` (POST submit-input wiring)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/steps/rules` PASS.
- Per-rule tests: intake question progression; research artifact satisfies criteria; PRD artifact satisfies criteria; issue_breakdown artifact triggers task DAG creation; execution session-completed satisfies criteria; QA/Review/Done artifacts satisfy criteria.

**Acceptance Criteria.**
- All 8 Engineering steps progress deterministically through their exit criteria.

---

### M8-021 — Daemon Boot Reconciliation for In-Flight LLM Calls + Orphan Step Runs

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Match M7's reconciliation pattern: any `workflow_llm_calls` rows in non-terminal state at boot are marked `failed/daemon_restart`; any `workflow_step_runs` whose owning run is `active` but no `workflow_llm_calls` is currently in flight remain as-is (they're just suspended).

**Scope.**
- IS: boot reconciliation function, event emission on reconcile failure.
- IS NOT: auto-resume of runs.

**Requirements.**

Create `apps/daemon/src/workflows/reconcile.ts`:

```ts
import { Database } from "better-sqlite3";
import { appendWorkflowEvent } from "./events";

export function reconcileWorkflowsOnBoot(db: Database, now: () => string): void {
  db.transaction(() => {
    const staleCalls: any[] = db.prepare(`
      SELECT id, goal_id, workflow_run_id, step_run_id FROM workflow_llm_calls
      WHERE status IN ('pending','running')
    `).all();
    for (const c of staleCalls) {
      db.prepare(`UPDATE workflow_llm_calls
        SET status='failed', failure_code='daemon_restart', failure_message='daemon restarted during LLM call'
        WHERE id=?`).run(c.id);
      db.prepare(`UPDATE workflow_runs
        SET status='blocked', blocked_reason='daemon_restart_during_llm_call'
        WHERE id=? AND status='active'`).run(c.workflow_run_id);
      appendWorkflowEvent(db, "workflow.run.blocked", {
        goalId: c.goal_id, workflowRunId: c.workflow_run_id,
        stepRunId: c.step_run_id, failureCode: "daemon_restart",
      });
    }

    // workflow_runs with status='active' whose current_step_run_id refers to a non-existent
    //    or already-passed step are repaired to 'blocked' with reason 'daemon_restart_state_drift'.
    const drift: any[] = db.prepare(`
      SELECT wr.id AS run_id, wr.goal_id AS goal_id FROM workflow_runs wr
      LEFT JOIN workflow_step_runs ws ON ws.id = wr.current_step_run_id
      WHERE wr.status = 'active' AND (ws.id IS NULL OR ws.status IN ('passed','failed','skipped'))
    `).all();
    for (const r of drift) {
      db.prepare(`UPDATE workflow_runs SET status='blocked', blocked_reason='daemon_restart_state_drift' WHERE id=?`).run(r.run_id);
      appendWorkflowEvent(db, "workflow.run.blocked", { goalId: r.goal_id, workflowRunId: r.run_id, failureCode: "daemon_restart_state_drift" });
    }
  })();
}
```

Call `reconcileWorkflowsOnBoot(db, now)` in daemon bootstrap before HTTP listen.

**Affected Areas.**
- `apps/daemon/src/workflows/reconcile.ts` (NEW)
- `apps/daemon/src/workflows/reconcile.test.ts` (NEW)
- `apps/daemon/src/index.ts` (invoke)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/reconcile` PASS.

**Acceptance Criteria.**
- Drift between active run and step status is repaired; event emitted.

---

### M8-022 — Workflows Tab UI

**Execution Assignment.** Model: `GPT 5.4`; Effort: `high`.

**Purpose.** New top-level Desktop tab: list templates, view a template detail (steps + guardrails), duplicate built-in into editable custom, edit/delete custom.

**Scope.**
- IS: `WorkflowsPage`, `TemplateList`, `TemplateDetail`, `StepEditor`, `GuardrailEditor` components; typed API wrappers; custom-template add/remove/reorder of linear steps; editing step inputs/outputs, gate type, capabilities, validation expectations, and exit criteria.
- IS NOT: orchestrator chat (M8-023), goal-detail surface (M8-024).

**Requirements.**

Create `apps/desktop/src/workflows/` directory with:

```
WorkflowsPage.tsx       layout, list + detail split
TemplateList.tsx        groups built-in + custom; shows version, lock badge
TemplateDetail.tsx      header (name, version, description), steps table, guardrails section, action buttons
StepEditor.tsx          inline edit for custom templates (name, purpose, inputs, outputs, gate type, capabilities, validation expectations, exit criteria)
GuardrailEditor.tsx     simple form per guardrail kind
api.ts                  typed wrappers around new endpoints
WorkflowsPage.test.tsx, TemplateList.test.tsx, TemplateDetail.test.tsx
```

`WorkflowsPage.tsx` skeleton:

```tsx
import { useEffect, useState } from "react";
import { WorkflowTemplate } from "@orca/contracts";
import { listTemplates } from "./api";
import { TemplateList } from "./TemplateList";
import { TemplateDetail } from "./TemplateDetail";

export function WorkflowsPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { listTemplates().then(r => setTemplates(r.templates)); }, []);
  const selected = templates.find(t => t.id === selectedId) ?? templates[0];
  return (
    <div className="workflows-page">
      <TemplateList templates={templates} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
      {selected && <TemplateDetail template={selected} onDuplicated={() => listTemplates().then(r => setTemplates(r.templates))} />}
    </div>
  );
}
```

Add route entry in `App.tsx` and a nav item in the chrome sidebar.

Component tests assert: empty state when no templates; built-in has lock badge; duplicate button creates custom copy; editing locked template shows disabled inputs; custom templates can add/remove/reorder linear steps; custom step inputs/outputs and validation expectations persist through the typed API wrapper.

**Affected Areas.**
- `apps/desktop/src/workflows/*.tsx, *.test.tsx` (NEW)
- `apps/desktop/src/App.tsx` (add route)
- `apps/desktop/src/chrome/*` (add nav)
- `apps/desktop/src/api.ts` (wrappers for workflow-template endpoints)

**Validation Steps.**
- `pnpm --filter @orca/desktop test workflows` PASS.

**Acceptance Criteria.**
- Tab renders; lists templates; duplicate works; locked enforcement visible.

---

### M8-023 — Orchestrator Chat: Goal Creation w/ Provider Picker, Start Workflow, Advance Approval

**Execution Assignment.** Model: `GPT 5.4`; Effort: `high`.

**Purpose.** Extend existing `OrcaChat.tsx` so the chat can: (a) collect orchestrator provider+model at goal creation, (b) recommend Engineering and start a workflow run, (c) display current step + outstanding criteria + next decision, (d) surface workflow recommendations as inline accept/reject buttons.

**Scope.**
- IS: provider picker on new-goal flow, "Start Engineering workflow" CTA after Goal exists, current-run banner in chat, accept handlers for workflow recommendations.
- IS NOT: template authoring (M8-022), goal-detail layout (M8-024).

**Requirements.**

Add `apps/desktop/src/orchestrator/components/OrchestratorModelPicker.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ModelProviderInfo, OrchestratorModelChoice } from "@orca/contracts";
import { listModelProviders } from "../../api";

export function OrchestratorModelPicker(props: {
  value: OrchestratorModelChoice | null;
  onChange: (v: OrchestratorModelChoice | null) => void;
}) {
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  useEffect(() => { listModelProviders().then(setProviders); }, []);
  const available = providers.filter(p => p.available);
  if (available.length === 0) return <div>No LLM providers configured. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY.</div>;
  return (
    <div className="orchestrator-model-picker">
      <label>Orchestrator LLM</label>
      <select
        value={props.value ? `${props.value.providerId}:${props.value.modelId}` : ""}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return props.onChange(null);
          const [providerId, modelId] = v.split(":") as [any, string];
          props.onChange({ providerId, modelId });
        }}
      >
        <option value="">Choose…</option>
        {available.flatMap(p => p.models.map(m => (
          <option key={`${p.id}:${m.id}`} value={`${p.id}:${m.id}`}>{p.displayName} — {m.displayName}</option>
        )))}
      </select>
    </div>
  );
}
```

Add picker to existing new-goal flow; pass `orchestratorModel` through to `createGoal`.

Add `apps/desktop/src/orchestrator/components/WorkflowBanner.tsx` showing current run, step, satisfied/outstanding criteria, last decision, "Why this action?" expandable showing decision.influencedBy entries.

Inline workflow recommendations as `<RecommendationCard>` (reuse existing M7 component) with accept buttons that:
- `launch_workflow_session`: prefill M4 session creation dialog with `workflowStepRunId` set.
- `request_user_input`: show inline text input → POST `/v1/goals/:goalId/workflow-step-runs/:id/submit-input`.
- `advance_workflow_step`: confirm dialog → POST recommendation accept.
- `complete_workflow_run`: confirm dialog → POST recommendation accept.

**Affected Areas.**
- `apps/desktop/src/orchestrator/components/OrchestratorModelPicker.tsx` (NEW)
- `apps/desktop/src/orchestrator/components/WorkflowBanner.tsx` (NEW)
- `apps/desktop/src/orchestrator/OrcaChat.tsx` (extend)
- `apps/desktop/src/create-goal-flow/*` (extend new-goal form)
- `apps/desktop/src/api.ts` (wrappers)
- Tests for each new component

**Validation Steps.**
- `pnpm --filter @orca/desktop test orchestrator` PASS.

**Acceptance Criteria.**
- Goal creation picks provider/model; chat shows live run; recommendation accept works.

---

### M8-024 — Goal Detail Workflow Panel

**Execution Assignment.** Model: `GPT 5.4`; Effort: `high`.

**Purpose.** Goal detail view shows active workflow run, all step runs, artifacts grouped by step, current next-decision banner, decision trace timeline, linked task DAG, and linked sessions/validation results.

**Scope.**
- IS: panel components, integrate into existing `goal-detail` route, live refresh on workflow events.
- IS NOT: workflow authoring (M8-022), chat (M8-023).

**Requirements.**

Create `apps/desktop/src/goal-detail/workflow/`:

```
WorkflowRunPanel.tsx       overall run state, current step, decision trace
StepTimeline.tsx           ordered step pills, status icons
ArtifactsList.tsx          grouped by step, expandable body view
DecisionTraceTimeline.tsx  list of decisions with influencedBy chips
TaskDagPreview.tsx         flat list of tasks linked to this run
WorkflowRunPanel.test.tsx, StepTimeline.test.tsx, ArtifactsList.test.tsx
```

`WorkflowRunPanel.tsx` skeleton:

```tsx
import { useEffect, useState } from "react";
import { WorkflowRun, WorkflowStepRun, WorkflowArtifact, WorkflowDecisionTrace } from "@orca/contracts";
import { getWorkflowRun, listStepRunsForRun, listArtifactsForRun, listDecisionsForRun } from "../../api";
import { StepTimeline } from "./StepTimeline";
import { ArtifactsList } from "./ArtifactsList";
import { DecisionTraceTimeline } from "./DecisionTraceTimeline";

export function WorkflowRunPanel(props: { goalId: string; runId: string }) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [steps, setSteps] = useState<WorkflowStepRun[]>([]);
  const [artifacts, setArtifacts] = useState<WorkflowArtifact[]>([]);
  const [decisions, setDecisions] = useState<WorkflowDecisionTrace[]>([]);
  const refresh = async () => {
    const [r, s, a, d] = await Promise.all([
      getWorkflowRun(props.goalId, props.runId),
      listStepRunsForRun(props.goalId, props.runId),
      listArtifactsForRun(props.goalId, props.runId),
      listDecisionsForRun(props.goalId, props.runId),
    ]);
    setRun(r); setSteps(s); setArtifacts(a); setDecisions(d);
  };
  useEffect(() => { refresh(); }, [props.goalId, props.runId]);
  // WebSocket subscription to workflow.* events → refresh
  if (!run) return <div>Loading…</div>;
  return (
    <div className="workflow-run-panel">
      <header>
        <h2>Workflow: {run.templateId} v{run.templateVersion}</h2>
        <span className={`status status-${run.status}`}>{run.status}</span>
      </header>
      <StepTimeline steps={steps} currentStepRunId={run.currentStepRunId} />
      <ArtifactsList artifacts={artifacts} stepRuns={steps} />
      <DecisionTraceTimeline decisions={decisions} />
    </div>
  );
}
```

`DecisionTraceTimeline.tsx` renders each decision with:
- `decisionType` badge
- `selectedAction` text
- `reason` body
- chips for each `influencedBy` entry: `kind:label (effect)`
- operator selection summary when present

Wire into existing goal detail route; show when goal has `active_workflow_run_id` or any historical run.

**Affected Areas.**
- `apps/desktop/src/goal-detail/workflow/*.tsx, *.test.tsx` (NEW)
- `apps/desktop/src/goal-detail/index.tsx` or equivalent (mount)
- `apps/desktop/src/api.ts` (wrappers)
- `apps/desktop/src/events/` (subscribe to workflow.* events)

**Validation Steps.**
- `pnpm --filter @orca/desktop test goal-detail/workflow` PASS.

**Acceptance Criteria.**
- Panel renders for an active run; decision trace shows influencedBy chips.

---

### M8-025 — Final Anchor: End-to-End Engineering Workflow Proof-Loop Integration Test (GATE: full-suite typecheck + test)

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Demonstrate the M8 proof point: user creates a Goal with an Orchestrator LLM, starts Engineering, drives through all 8 steps with fake LLM provider + fake agent adapters, asserts all artifacts/recommendations/decisions/events persisted and visible.

**Scope.**
- IS: one comprehensive integration test under `apps/daemon/src/__tests__/workflow-engineering-loop.test.ts`.
- IS NOT: cross-Goal scenarios, multi-run, autonomy expansion.

**Requirements.**

Create `apps/daemon/src/__tests__/workflow-engineering-loop.test.ts`:

```ts
import { describe, test, expect, beforeAll } from "vitest";
import { bootDaemonForTest } from "./helpers/boot";

describe("M8 Engineering workflow end-to-end", () => {
  // 1. Boot daemon with fake providers (Anthropic fake returns canned OperatorSelection)
  // 2. POST /v1/goals with title + orchestratorModel: { providerId: "orca/anthropic", modelId: "claude-sonnet-4-6" }
  // 3. POST /v1/goals/:id/workflow-runs { templateId: "orca/engineering" }
  // 4. POST /v1/goals/:goalId/workflow-runs/:id/next-decision → expect request_user_input for Intake
  // 5. POST /v1/goals/:goalId/workflow-step-runs/:id/submit-input answering 5 intake questions
  //    → expect goal_brief artifact + 5 satisfied criteria + advance recommendation; accept it → research step
  // 6. POST /v1/goals/:goalId/workflow-runs/:id/next-decision → expect select_operator for Research
  //    Accept launch_workflow_session → simulate session creation, completion, summary
  //    Submit research_summary artifact → research step passes
  // 7. Repeat for PRD: artifact submission → passes
  // 8. Repeat for Issue Breakdown: artifact w/ tasks JSON → writes M7 tasks → passes
  // 9. Execution: accept launch_workflow_session → simulate session completion → implementation_result + test_report artifacts → passes
  // 10. QA: submit qa_report → passes
  // 11. Review: accept launch_workflow_session → review_report artifact → passes
  // 12. Done: submit final_summary + memory_update → run completes
  // 13. Assert: workflow_runs.status='completed'; all 8 step runs passed; artifacts present; >=10 workflow_decisions rows;
  //     workflow_llm_calls rows have no prompt/response columns; event log includes required happy-path M8EventType literals
  test("happy-path Engineering loop runs end-to-end", async () => { /* steps above */ });
});
```

Helper `bootDaemonForTest` constructs a `DaemonContext` with fake `ModelProvider` whose `complete` returns canned valid responses, fake `AdapterRegistry` returning ready agent adapters, file-backed SQLite in a temp dir.

**Restart sub-test:** kill daemon between steps 6 and 7, restart, assert workflow_runs.status stays the same (either 'active' or 'blocked' depending on whether a step transition was mid-flight) and the run can continue.

**Gate.** `pnpm -r typecheck && pnpm -r test` PASS. Record green SHA in `docs/implementation-plans/notes/m8-025-gate.md`.

**Affected Areas.**
- `apps/daemon/src/__tests__/workflow-engineering-loop.test.ts` (NEW)
- `apps/daemon/src/__tests__/helpers/boot.ts` (NEW or extend)
- `docs/implementation-plans/notes/m8-025-gate.md` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflow-engineering-loop` PASS.
- `pnpm -r typecheck && pnpm -r test` PASS.

**Acceptance Criteria.**
- End-to-end loop completes; restart survives; all assertions pass.

---

### M8-026 — Milestone Documentation Pass

**Execution Assignment.** Model: `GPT 5.4`; Effort: `medium`.

**Purpose.** Create the milestone-level doc (`docs/milestones/8.md`) mirroring M7's structure (purpose, scope review, runtime architecture, repo structure, technology decisions, runtime lifecycle, event system, database design, API surface, acceptance criteria). Update `CLAUDE.md` to mark M8 milestones table row complete.

**Scope.**
- IS: doc creation + brief CLAUDE.md and PRODUCT.md updates referencing workflows.
- IS NOT: marketing/blog content, video walkthroughs, extra examples.

**Requirements.**

Create `docs/milestones/8.md` summarizing:
- Purpose (workflow-driven supervised orchestration).
- Scope and explicit non-goals (copy from this plan's header).
- Architecture overview (templates → runs → step runs → artifacts → decisions, LLM provider seam, M7 reuse).
- Events emitted.
- Database tables added.
- API surface (all routes from M8-018).
- Acceptance criteria (from PRD, mapped to specific M8-NNN tasks).

Update `CLAUDE.md`:
- Append M8 row to milestones table when present.
- Document new `DaemonContext` fields.
- Document `orchestrator_provider` / `orchestrator_model` Goal fields.

Optionally add a short note to `docs/PRODUCT.md` referencing the Workflows tab.

**Affected Areas.**
- `docs/milestones/8.md` (NEW)
- `CLAUDE.md` (extend)
- `docs/PRODUCT.md` (optional 1-paragraph addition)

**Validation Steps.**
- Markdown lints clean (if a linter is configured).
- All referenced files/routes/events match what landed in M8-001 through M8-025.

**Acceptance Criteria.**
- Doc set complete; future engineers can navigate from PRD → milestone doc → implementation plan → code.

---

## Acceptance Mapping (PRD → Tasks)

| PRD Acceptance | Tasks |
|---|---|
| 1. Open Workflows tab and see built-in Engineering | M8-007, M8-008, M8-022 |
| 2. Create and edit a simple custom global workflow | M8-007, M8-022 |
| 3. Start Engineering from orchestrator chat for a goal | M8-006, M8-009, M8-023 |
| 4. Move through all 8 Engineering steps as tracked workflow steps | M8-010, M8-016, M8-020, M8-025 |
| 5. Store artifacts for each meaningful step | M8-011, M8-020 |
| 6. Generate vertical-slice tasks with dependencies during Issue Breakdown | M8-017, M8-020 |
| 7. See Orca recommend the best available operator with a structured reason | M8-013, M8-014, M8-016 |
| 8. Approve or reject launch/advance recommendations | M8-017, M8-023 |
| 9. Define basic workflow guardrails and see them influence decisions | M8-008, M8-012, M8-022 |
| 10. See which workflow step / artifact / guardrail / task state / readiness / user input influenced a recommendation | M8-015, M8-016, M8-024 |
| 11. See workflow events emitted for every state change | M8-001, M8-019, M8-025 |

---

## Self-Review Checklist (for the engineer executing this plan)

- After every numbered task, run that task's listed validation command. If it fails, stop and fix before continuing — never carry red into the next task.
- After M8-010, M8-018, M8-025: full-suite gates. These are the only "stop the world" moments.
- Watch for: events accidentally emitted outside the projection TX; LLM call rows carrying prompt/response text; any auto-execution path that bypasses M7 accept-flow; any cross-goal workflow lookup; any built-in template mutation through the custom routes.
- Keep changes additive on existing M1-M7 shapes. If you find yourself rewriting an M1-M7 contract, stop and ask.
