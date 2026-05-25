You are implementing a bounded Milestone 8 task for the Orca orchestration platform from the generated implementation task list in `docs/implementation-plans/milestone-8.md`.

Follow the assigned implementation task exactly.

Do not use the superpowers plugin.

Do not redesign architecture.

Do not expand scope.

Do not introduce future systems.

Optimize for:

correctness
simplicity
maintainability
clean implementation
fast validation
deterministic behavior
privacy-preserving orchestration
content-free events
explicit user supervision
bounded LLM-provider usage
preserving future ACP/A2A and Level 5 extensibility

Current task:

M8-015

Prerequisite:

Milestone 7 must be complete and green before any M8 task begins. M8-000 baseline verification must be complete and recorded before any implementation task after M8-000 begins. If the M8 baseline is not recorded in `docs/implementation-plans/notes/m8-000-baseline.md`, stop and run M8-000 first.

Important architectural constraints:

local-first
event-driven
Goal-scoped
Workspace-aware where existing M3/M7 surfaces are read
daemon owns state
SQLite remains the internal storage boundary
existing M1/M2/M3/M4/M5/M6/M7 wire shapes remain byte-identical unless the assigned M8 task explicitly extends them
M1 Goal creation and live event behavior must remain valid
M2 plugin, skill, and adapter registry behavior must remain valid
M3 refined Goal and workspace behavior must remain valid
M4 PTY sessions, adapters, lifecycle events, capped output tails, restart reconciliation, and embedded terminal behavior must remain valid
M5 Goal-scoped memory, decisions, session summaries, extraction events, and Goal detail memory/decision UI must remain valid
M6 bounded context packages, deterministic session preparation, context preview/status UI, contextPackageId session association, adapter delivery policy, and restart-safe context persistence must remain valid
M7 tasks, recommendations, conflicts, feedback, suggestion-only acceptance flows, and Goal detail orchestration UI must remain valid
daemon write paths that emit events must persist events and projection rows atomically
event bus broadcasts happen only after COMMIT succeeds
M8 workflow rows are Goal-scoped
workflow templates are global; Engineering built-in is locked/read-only through routes
M8 source attribution and influenced-by data are compact JSON on owning rows
M8 must use bounded projection reads, not workspace scans, transcripts, or raw M4 output tails
M8 events are control-plane signals with ids/counts/statuses/changed-field keys/byte sizes/failure codes only
M8 events must not include workflow artifact bodies, decision reason text, operator-selection rationale, guardrail evaluation messages, recommendation rationale text, proposedAction bodies, rendered context, raw source text, memory content, decision text, summary text, raw terminal output, prompts, raw provider input/output, raw model responses, model reasoning, tokens beyond allowed metadata, secrets, workspace file contents, or adapter context-file paths
workflow decision rows may store bounded, redacted reason text because decision transparency is an explicit M8 product requirement
terminal output remains outside the general event store
terminal input and resize remain outside domain events
LLM prompts and raw responses are never persisted

Milestone 8 proof point:

User creates a Goal and selects an Orchestrator LLM provider/model
daemon stores provider and model on the Goal
user starts an Engineering workflow run from Orchestrator chat
daemon creates workflow_run and first workflow_step_run atomically
orchestrator emits intake question via OperatorSelector using the Goal's Orchestrator LLM
user answers; goal_brief artifact persists; exit criteria satisfy; advance recommendation is produced
user accepts advance recommendations; daemon advances run through Research, PRD, and Issue Breakdown
Issue Breakdown writes M7 tasks with origin='generator' linked to the workflow step run
Execution recommends launch through M7 recommendation lifecycle
user accepts launch; existing M4/M6 prefill flow runs
session completion writes M5 summary
QA and Review steps consume implementation_result and qa_report artifacts
Done step writes final_summary and memory_update artifacts
every orchestrator decision writes a bounded/redacted workflow_decisions row with influenced-by source refs
Workflows tab shows locked Engineering template and custom templates
Orchestrator chat shows current run state, current step, artifacts, next action, and why-this-action decision trace
all state survives daemon restart; in-flight LLM calls reconcile to failure

Milestone 8 included surface:

contract schemas for workflow templates, steps, guardrails, runs, step runs, artifacts, decisions, influenced-by refs, operators, provider info, model choices, request/response payloads, M8 event literals, and optional extensions on existing M1-M7 contracts
optional CreateGoalRequest/Goal orchestratorProvider and orchestratorModel fields
optional workflowRunId, workflowStepRunId, workflowArtifactId fields on existing M7 task/recommendation, M4 session, and M6 context-package writes where explicitly assigned
workflow_templates table
workflow_runs table
workflow_step_runs table
workflow_artifacts table
workflow_decisions table
workflow_guardrail_evaluations table
workflow_llm_calls table
goals.orchestrator_provider column
goals.orchestrator_model column
goals.active_workflow_run_id column
sessions.workflow_step_run_id column
context_packages.workflow_step_run_id column
tasks.workflow_step_run_id column
recommendations.workflow_step_run_id column
minimal indexes for Goal/run/status reads, active run uniqueness, step-run idempotency, artifact reads, decision reads/idempotency, guardrail evaluation reads, and LLM call metadata reads
ModelProvider interface and provider error taxonomy
Anthropic, OpenAI, and Google Gemini provider implementations behind the same interface
ModelProviderRegistry wired through DaemonContext
GET /v1/model-providers
PATCH /v1/goals/:goalId/orchestrator-model
provider/model validation at Goal create and update boundaries
workflow template projection, create/update/duplicate/list/detail use cases and routes
locked Engineering built-in template seed with eight linear steps and built-in guardrails
workflow run lifecycle use cases and routes: start, pause, resume, cancel, complete, block, list, detail
workflow step-run lifecycle and exit-criteria bookkeeping
workflow artifact projection, create/list/detail use cases and routes
guardrail evaluation engine with deterministic allow/deny/require_approval results
operator registry combining M2/M4 agent readiness, M8 model providers, and human operator
GET /v1/operators?goalId=
operator selection service with bounded structured prompt, zod response parsing, guardrail filtering, and deterministic fallback
workflow_llm_calls metadata rows for provider/model/status/latency/token metadata/failure code only
decision trace projection and writes with bounded/redacted reason text and influenced-by refs
orchestrator decision service for request input, request artifact, select operator, advance step, block run, and complete run decisions
M7 recommendation type extensions for advance_workflow_step, launch_workflow_session, complete_workflow_run, mark_artifact_satisfied, and request_user_input
M7 accept-flow reuse for workflow recommendations; no generic execute endpoint
Issue Breakdown writer that creates M7 tasks linked to workflow_step_run_id and validates dependencies through existing M7 rules
consolidated HTTP route registration and zod boundary validation
content-free M8 event emission audit
per-step deterministic Engineering rules from Intake through Done
daemon boot reconciliation for in-flight LLM calls and orphan workflow step runs
Workflows desktop tab for templates, template detail, duplication, and custom-template editing
Orchestrator chat provider picker, start-workflow CTA, current-run banner, and workflow recommendation controls
Goal detail workflow panel with run state, current step, artifacts, decisions, and workflow events refetch behavior
end-to-end Engineering workflow proof-loop integration test
milestone documentation pass

Milestone 8 excluded surface:

Level 5 autonomy
auto-launching agents without explicit user approval
automatic session launch outside accepted M7 recommendation flow
automatic context preparation outside existing approved/prefill flow
automatic validation command execution
workflow step mutation through WebSocket commands
per-goal workflow template overrides
workflow templates editable per goal
visual DAG workflow builders
branching or parallel workflow steps in the MVP
cross-Goal workflows
external GitHub/Jira/PM sync
advanced policy languages
metrics dashboards
self-adapting workflows
agent performance optimization
embedding/vector ranking
semantic search
cross-Goal knowledge systems
raw model prompt/response logging
raw transcript/output-tail reads during workflow orchestration
persistence of provider prompts or responses in domain events
prompt template editors as a product surface
prompt-management platform
generic skill invocation endpoints
generic reasoning-job endpoints
generic action execution endpoints
multi-agent scheduling
distributed queues
background schedulers
continuous autonomous reasoning loops
new top-level packages
ACP/A2A routes as Orca internal workflow API
token-accurate accounting
provider cost dashboards
recommendation analytics dashboards
global workflow dashboards
full transcript capture/replay/export/analytics
source reverse-index join tables
workspace indexing/scanning/file watching
git library additions such as simple-git, isomorphic-git, nodegit, or dugite
file watcher additions such as chokidar or fs.watch

Implementation instructions:

Analyze the current repository structure first.
Read the specific M8 task before editing.
Check task dependencies and do not skip prerequisite validation.
Honor the mandatory full-suite gates before continuing past gated tasks.
Implement incrementally.
Keep files small and readable.
Use TypeScript strict typing.
Use zod validation where wire contracts, provider output, model output, or request/response parsing require it.
Avoid unnecessary abstractions.
Prefer deterministic/simple logic.
Preserve existing M1/M2/M3/M4/M5/M6/M7 behavior unless the M8 task explicitly changes it.
Keep public API changes limited to the task's declared endpoints/contracts.
Keep M8 use cases wired through the explicit DaemonContext seam.
Do not introduce a DI framework, container, decorators, module-global runtime dependencies, or hidden singleton services.
Register adapters, skills, providers, and built-in workflow templates before the HTTP listener accepts connections.
Do not add unassigned provider SDKs or model configuration surfaces.
Do not invent unverified CLI flags for Claude Code, opencode, codex, or any other adapter.
Do not log artifact bodies, decision rationale, operator-selection reason, guardrail evaluation messages, recommendation rationale, proposedAction bodies, rendered context, raw source text, memory content, decision text, summary text, prompts, raw responses, secrets, workspace file contents, or adapter context-file paths.
Use content-free event payloads and REST projection reads for detailed state.
Ensure the assigned task validation steps pass.

M8 event set:

goal.orchestrator_model_changed
workflow.template.created
workflow.template.updated
workflow.template.duplicated
workflow.run.started
workflow.run.paused
workflow.run.blocked
workflow.run.completed
workflow.run.failed
workflow.run.cancelled
workflow.step.started
workflow.step.completed
workflow.step.blocked
workflow.step.skipped
workflow.step.failed
workflow.artifact.created
workflow.guardrail.evaluated
workflow.operator.selected
workflow.decision.requested
workflow.decision.recorded
workflow.user.input.requested
workflow.user.input.submitted
workflow.recommendation.created
workflow.recommendation.accepted
workflow.recommendation.rejected
workflow.task.dag.created
workflow.task.dag.updated
workflow.validation.run
workflow.validation.passed
workflow.validation.failed
workflow.validation.skipped

No other M8 workflow or Goal-extension events are allowed unless the assigned task explicitly amends the milestone plan.

M8 table/column set:

workflow_templates
workflow_runs
workflow_step_runs
workflow_artifacts
workflow_decisions
workflow_guardrail_evaluations
workflow_llm_calls
goals.orchestrator_provider
goals.orchestrator_model
goals.active_workflow_run_id
sessions.workflow_step_run_id
context_packages.workflow_step_run_id
tasks.workflow_step_run_id
recommendations.workflow_step_run_id

No other M8 persistence tables or columns are allowed unless the assigned task explicitly amends the milestone plan.

Workflow lifecycle rules:

Only one active/paused/blocked workflow run per Goal is allowed.
Starting a run creates workflow_run and initial workflow_step_run in one transaction.
Runs store template_version_at_start so historical runs read the captured template version.
Built-in Engineering template uses id `orca/engineering` and is locked through route-level checks.
Editing a custom template increments version on save.
workflow_step_run fingerprint is sha256(workflow_run_id + ':' + step_template_id + ':' + attempt).
Decision idempotency uses workflow_run_id, optional step_run_id, decision_type, and input_fingerprint.
Paused, blocked, completed, failed, and cancelled run transitions emit content-free workflow.run events.
Step start/pass/block/fail/skip transitions emit content-free workflow.step events.
Artifacts are persisted with capped body text but events carry ids, types, counts, and byte sizes only.

LLM and provider rules:

Every LLM call goes through ModelProvider.complete(request).
The request carries structured prompt data only in memory.
Provider responses are parsed against zod schemas before any decision persists.
Failed parse maps to failure_code `invalid_output`.
Network/provider failures map to failure_code `provider_error`.
workflow_llm_calls rows contain metadata only: provider_id, provider_version, model, status, usage token counts if available, latency_ms, failure_code, and redacted failure_message.
workflow_llm_calls rows must not contain prompt, response, chain-of-thought, raw request, raw response, rendered context, artifact bodies, or source text columns.
In-flight workflow_llm_calls reconcile to failed with daemon_restart at boot.
If the selected provider/model is unavailable or returns invalid output, operator selection falls back deterministically where the task plan allows it.

Suggestion-only and acceptance rules:

The orchestrator may produce WorkflowDecision rows and M7 recommendation rows.
No downstream M3/M4/M5/M6/M7 flow may run before the user accepts the corresponding M7 recommendation, except workflow-internal transitions explicitly allowed by the M8 plan.
Accepting launch_workflow_session returns proposedAction for desktop prefill and must not auto-start a session by itself.
Accepting advance_workflow_step may execute only the approved workflow-internal step transition.
Accepting complete_workflow_run may execute only the approved workflow-internal run completion after final-step criteria are satisfied.
There is no generic execute-action endpoint.
There are no WebSocket commands for workflow mutation.
Desktop reacts to workflow.* events by refetching REST projections, not by patching detailed state from event payloads.

HTTP/API rules:

GET /v1/workflow-templates
GET /v1/workflow-templates/:id
POST /v1/workflow-templates
PATCH /v1/workflow-templates/:id
POST /v1/workflow-templates/:id/duplicate
POST /v1/goals/:goalId/workflow-runs
GET /v1/goals/:goalId/workflow-runs
GET /v1/goals/:goalId/workflow-runs/:id
POST /v1/goals/:goalId/workflow-runs/:id/pause
POST /v1/goals/:goalId/workflow-runs/:id/resume
POST /v1/goals/:goalId/workflow-runs/:id/cancel
POST /v1/goals/:goalId/workflow-runs/:id/next-decision
GET /v1/goals/:goalId/workflow-runs/:id/decisions
GET /v1/goals/:goalId/workflow-runs/:runId/artifacts
GET /v1/goals/:goalId/workflow-step-runs/:id
POST /v1/goals/:goalId/workflow-step-runs/:id/submit-input
POST /v1/goals/:goalId/workflow-artifacts
GET /v1/goals/:goalId/workflow-artifacts
GET /v1/goals/:goalId/workflow-artifacts/:id
GET /v1/goals/:goalId/workflow-decisions/:id
GET /v1/operators?goalId=
GET /v1/model-providers
PATCH /v1/goals/:goalId/orchestrator-model

All M8 reads under `/v1/goals/:goalId/...` must verify the row belongs to that Goal and return 404 on mismatch.
All M8 request bodies must be validated with zod at the HTTP boundary.
Existing M1-M7 endpoints must not change response shape except for optional M8 fields explicitly assigned by the current task.

Content caps and privacy defaults:

workflow template name <= 100 chars
workflow template description <= 2 KiB
step purpose <= 1 KiB
guardrail label <= 100 chars
guardrail config JSON <= 2 KiB
artifact title <= 256 chars
artifact body <= 64 KiB
decision reason <= 1 KiB
operator-selection rationale <= 2 KiB
influenced-by entries <= 32 per decision
operator-selection alternatives considered <= 8
event payload <= 4 KiB serialized
failure message <= 256 chars after redaction

Apply best-effort redaction before persistence for user/provider accepted free text at API boundaries and provider failure messages.

Review gates:

Gate 1: M8-000 records the M1-M7 baseline in `docs/implementation-plans/notes/m8-000-baseline.md`.
Gate 2: After M8-010, run full-suite `pnpm -r typecheck` and `pnpm -r test`; record green SHA in `docs/implementation-plans/notes/m8-010-gate.md`.
Gate 3: After M8-018, run full-suite `pnpm -r typecheck` and `pnpm -r test`; record green SHA in `docs/implementation-plans/notes/m8-018-gate.md`.
Gate 4: After M8-025, verify the end-to-end Engineering workflow proof loop, restart sub-test, and full-suite `pnpm -r typecheck` and `pnpm -r test` are green; record green SHA in `docs/implementation-plans/notes/m8-025-gate.md`.
Gate 5: After M8-026, verify final documentation, M8 acceptance mapping, non-goals, and any configured markdown lint are green.

Full-suite gates:

After M8-010: pnpm -r typecheck and pnpm -r test must be green.
After M8-018: pnpm -r typecheck and pnpm -r test must be green.
After M8-025: pnpm -r typecheck and pnpm -r test must be green.

Baseline validation for M8-000:

Run pnpm install --frozen-lockfile.
Run pnpm -r typecheck.
Run pnpm -r test.
Record git rev-parse HEAD.
Record final test summary line counts.
Record pre-existing dirty paths from git status without attributing them to M8.
Confirm named M1-M7 regression anchors pass:
M1 Goal CRUD plus live events.
M2 plugin/skill registry.
M3 Goal-with-workspaces integration.
M4 session lifecycle integration.
M5 daemon proof-loop integration.
M6 daemon proof-loop integration.
M7 orchestration-loop integration.

Before finishing:

verify all acceptance criteria
verify validation steps
verify task dependencies and review gates
verify M1/M2/M3/M4/M5/M6/M7 baseline behavior still works where relevant
verify no excluded M8 surface was introduced
verify events are content-free and <= 4 KiB serialized
verify projection rows and events commit atomically
verify broadcasts happen only after commit
verify workflow rows and direct-id reads are Goal-scoped
verify LLM prompts/raw responses are not persisted, emitted, or logged
verify workflow_llm_calls contains metadata only
verify M8 workflow orchestration does not read raw M4 output tails or transcript modules
verify recommendation acceptance never auto-launches external work or bypasses user approval
verify built-in Engineering template cannot be mutated through custom-template routes
verify ACP/A2A compatibility remains protocol-neutral and internal only
explain what was implemented
explain any deviations
explain any technical concerns

After finishing:

update 4-do-implementation-plan.md to prepare for the next step
Commit changes
Run `/code-review`, then commit again if any changes made
Output changes from a product perspective

Do not implement unrelated future milestone functionality.
