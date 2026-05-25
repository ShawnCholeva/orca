You are implementing a bounded Milestone 9 task for the Orca orchestration platform from the generated implementation task list in `docs/implementation-plans/milestone-9.md`.

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
bounded transport behavior
preserving future ACP/A2A and Level 5 extensibility

Current task:

M9-013

Prerequisite:

Milestone 8 must be complete and green before any M9 task begins. M9-000 baseline verification must be complete and recorded before any implementation task after M9-000 begins. If the M9 baseline is not recorded in `docs/implementation-plans/notes/m9-000-baseline.md`, stop and run M9-000 first.

Important architectural constraints:

local-first
event-driven
Goal-scoped
Workspace-aware where existing M3/M7/M8 surfaces are read
daemon owns state
SQLite remains the internal storage boundary
existing M1-M8 wire shapes remain byte-identical unless the assigned M9 task explicitly extends them
M1 Goal creation and live event behavior must remain valid
M2 plugin, skill, and adapter registry behavior must remain valid
M3 refined Goal and workspace behavior must remain valid
M4 PTY sessions, adapters, lifecycle events, capped output tails, restart reconciliation, and embedded terminal behavior must remain valid
M5 Goal-scoped memory, decisions, session summaries, extraction events, and Goal detail memory/decision UI must remain valid
M6 bounded context packages, deterministic session preparation, context preview/status UI, contextPackageId session association, adapter delivery policy, and restart-safe context persistence must remain valid
M7 tasks, recommendations, conflicts, feedback, suggestion-only acceptance flows, and Goal detail orchestration UI must remain valid
M8 workflow templates, runs, step runs, artifacts, decisions, guardrails, operator selection, provider/model selection, and workflow UI must remain valid
daemon write paths that emit events must persist events and projection rows atomically
event bus broadcasts happen only after COMMIT succeeds
M9 transport attempts, workers, and human-review payloads are Goal-scoped through direct ownership or parent workflow ownership
hidden workers must not appear in ordinary session lists or user-visible PTY flows
hidden workers must not receive mutation credentials
transport processes must never mutate workflow state directly
M9 events are control-plane signals with ids/statuses/failure codes/counts only
M9 events must not include prompts, raw CLI output, raw model responses, proposal bodies, artifact bodies, decision reason text, guardrail messages, memory text, decision text, summary text, secrets, workspace file paths, or context package bodies
worker output remains outside the general event store
LLM prompts and raw responses are never persisted
transport fallback must be explicit, inspectable, and ordered

Milestone 9 proof point:

```text
User creates a Goal and selects OpenAI, Claude, or Gemini as the Orchestrator provider/model
daemon stores provider and model on the Goal as before
provider picker does not require API keys for core orchestration
workflow operator-selection request goes through OrchestrationTransportBroker
broker records a transport attempt for each policy step
OpenAI tries codex one-shot, then codex hidden interactive, then human review
Gemini tries gemini one-shot, then gemini hidden interactive, then human review
Claude skips one-shot by policy and tries claude-code hidden interactive, then human review
every failed or rejected transport attempt stores reason, status, timestamps, and capped or redacted diagnostics
valid automated proposal is parsed, schema-validated, registry-validated, guardrail-checked, and persisted as a workflow decision
invalid or rejected automated proposal steps down to the next transport
human review fallback creates a structured review payload and UI form with valid choices
submitted human proposal runs through the same daemon validation pipeline
hidden workers never appear in user sessions, never receive mutation credentials, and reconcile to failed on daemon restart
Workflow run panel shows fallback status and opens a debug trace without raw prompt or context leakage
all state survives daemon restart; in-flight worker and attempt rows reconcile to failure
```

Milestone 9 included surface:

transport, worker, attempt, human-review, and transport-event contracts in `@orca/contracts`
provider display-name helpers for OpenAI, Claude, and Gemini
`orchestration_workers`
`orchestration_worker_output_chunks`
`orchestration_transport_attempts`
`orchestration_worker_hook_traces`
`orchestration_human_reviews`
orchestrator provider catalog semantics decoupled from daemon API-key availability
`OrchestrationTransportBroker`
transport policy resolver for OpenAI, Gemini, and Claude
proposal-envelope parser and validation pipeline
SDK compatibility trace path for existing `ModelProvider.complete()` use
one-shot transport allowlist
Codex one-shot transport for OpenAI
Gemini one-shot transport
hidden interactive worker persistence and output store
`OrchestrationWorkerRuntime` over the existing PTY manager
worker hook capability detection and worker-scoped hook config
provider hidden-worker drivers for Claude, Codex, and Gemini
worker reconciliation and health checks
human-review payload creation and submission route
operator-selector integration with broker-backed transport proposals
diagnostics endpoints for attempts and workers
transport privacy and event-emission audits
desktop provider-picker copy/readiness updates
workflow run panel transport status and debug drawer
desktop human-review flow
end-to-end transport fallback integration tests
milestone documentation pass

Milestone 9 excluded surface:

local-model orchestration
mandatory local model downloads
1B or other local-model fallback
user-facing transport selection
direct workflow mutation by transport processes
hidden workers in normal session lists
hidden workers with mutation credentials
global CLI hook installation without explicit user opt-in
silent fallback between transports
automatic workflow advancement outside existing approved M7 or M8 acceptance rules
automatic session launch outside accepted recommendation flows
automatic context preparation outside existing approved or prefill flows
automatic validation execution
ACP or A2A routes as Orca internal workflow APIs
provider billing or account management
model-provider ID renames that require migration churn
raw prompt or response persistence
raw context-package persistence in transport traces
raw worker transcript persistence beyond capped or redacted output chunks
new top-level packages

Implementation instructions:

Analyze the current repository structure first.
Read the specific M9 task before editing.
Check task dependencies and do not skip prerequisite validation.
Honor the mandatory full-suite gates before continuing past gated tasks.
Implement incrementally.
Keep files small and readable.
Use TypeScript strict typing.
Use zod validation where wire contracts, transport output, human-review payloads, or request/response parsing require it.
Avoid unnecessary abstractions.
Prefer deterministic and simple logic.
Preserve existing M1-M8 behavior unless the M9 task explicitly changes it.
Keep public API changes limited to the task's declared endpoints and contracts.
Keep M9 use cases wired through the explicit `DaemonContext` seam.
Do not introduce a DI framework, container, decorators, module-global runtime dependencies, or hidden singleton services.
Register adapters, providers, operators, transport policy, and built-in workflow dependencies before the HTTP listener accepts connections.
Do not invent unverified CLI flags for Claude Code, codex, gemini, opencode, or any other adapter.
Do not log prompt text, raw worker output, raw proposal bodies, decision rationale text, guardrail messages, memory text, decision text, summary text, secrets, workspace file contents, or adapter context-file paths.
Use content-free event payloads and REST projection reads for detailed state.
Ensure the assigned task validation steps pass.

M9 event set:

workflow.transport.attempt_started
workflow.transport.attempt_finished
workflow.transport.fallback
workflow.worker.state_changed
workflow.human_review.requested

These M9 events are additive to the existing M1-M8 event sets. No other M9 transport or Goal-extension events are allowed unless the assigned task explicitly amends the milestone plan.

M9 table set:

orchestration_workers
orchestration_worker_output_chunks
orchestration_transport_attempts
orchestration_worker_hook_traces
orchestration_human_reviews

No other M9 persistence tables or columns are allowed unless the assigned task explicitly amends the milestone plan.

Transport policy rules:

OpenAI uses `one_shot -> hidden_interactive -> human_review`.
Gemini uses `one_shot -> hidden_interactive -> human_review`.
Claude uses `hidden_interactive -> human_review`.
Claude skips one-shot by policy in v1.
Every transport level creates an `orchestration_transport_attempts` row before execution or policy-recorded fallback.
V1 attempts each transport level at most once per request.
Human review is the final fallback.
Local-model fallback is not part of M9.

Worker and authority rules:

Only daemon code may validate, persist, emit events, create recommendations, or advance workflow state.
Hidden workers may receive bounded request input and return a structured proposal only.
Hidden workers must not write to the SQLite database.
Hidden workers must not call Orca mutation endpoints.
Hidden workers must not receive desktop API tokens.
Hidden workers may be reused only when provider and model match, state is `ready` or `awaiting_input`, and health is current.
On daemon boot, stale `starting`, `ready`, `awaiting_input`, and `producing_decision` workers become failed with `daemon_restart`.
On daemon boot, stale `pending` and `running` attempts become failed with `daemon_restart`.
Do not try to reattach to old PTYs in v1.

Proposal and validation rules:

Every automated transport returns exactly one `orcaProposalVersion: 1` envelope.
The daemon extracts `payload` and validates it against the requested schema.
Operator-selection proposals must also pass registry validation and guardrail checks.
Rejected proposals are distinct from process failures and must record `status = rejected`.
Malformed one-shot output maps to `one_shot_parse_failed`.
Malformed interactive output maps to `interactive_output_invalid`.
Provider or CLI quota failures map to `one_shot_rate_limited` where applicable.
Spawn failures map to `interactive_spawn_failed`.
Timeouts or hangs map to `interactive_hung`.
Auth-loss or login-required states map to `interactive_auth_lost`.

HTTP and API rules:

`GET /v1/model-providers`
`GET /v1/goals/:goalId/orchestration-attempts?workflowRunId=:workflowRunId`
`GET /v1/orchestration-workers`
`GET /v1/orchestration-workers/:id`
`POST /v1/goals/:goalId/workflow-runs/:runId/human-review/:attemptId`

All M9 reads under `/v1/goals/:goalId/...` must verify row ownership and return 404 on mismatch.
All M9 request bodies must be validated with zod at the HTTP boundary.
Existing M1-M8 endpoints must not change response shape except for optional M9 fields explicitly assigned by the current task.

Privacy caps and defaults:

event payload <= 4 KiB serialized
readiness or failure message <= 256 chars after redaction
debug output tails must be capped and redacted
hook traces must store summaries only
raw prompts, raw context packages, raw model responses, and full proposal bodies must not be returned by diagnostics endpoints

Review gates:

Gate 1: M9-000 records the M8 baseline in `docs/implementation-plans/notes/m9-000-baseline.md`.
Gate 2: After M9-006, run full-suite `pnpm -r typecheck` and `pnpm -r test`; record green SHA in `docs/implementation-plans/notes/m9-006-gate.md`.
Gate 3: After M9-015, run full-suite `pnpm -r typecheck` and `pnpm -r test`; record green SHA in `docs/implementation-plans/notes/m9-015-gate.md`.
Gate 4: After M9-024, verify the transport fallback proof loop, restart reconciliation sub-tests, and full-suite `pnpm -r typecheck` and `pnpm -r test` are green; record green SHA in `docs/implementation-plans/notes/m9-024-gate.md`.
Gate 5: After M9-025, verify final documentation, M9 acceptance mapping, non-goals, and any configured markdown lint are green.

Full-suite gates:

After M9-006: `pnpm -r typecheck` and `pnpm -r test` must be green.
After M9-015: `pnpm -r typecheck` and `pnpm -r test` must be green.
After M9-024: `pnpm -r typecheck` and `pnpm -r test` must be green.

Baseline validation for M9-000:

Run `pnpm install --frozen-lockfile`.
Run `pnpm -r typecheck`.
Run `pnpm -r test`.
Record `git rev-parse HEAD`.
Record final test summary line counts.
Record pre-existing dirty paths from `git status --short`.
Confirm key M8 regression anchors pass:
workflow contracts
workflow HTTP surface
operator selection
orchestrator service
goal-detail workflow UI

Before finishing:

verify all acceptance criteria
verify validation steps
verify task dependencies and review gates
verify M1-M8 baseline behavior still works where relevant
verify no excluded M9 surface was introduced
verify events are content-free and <= 4 KiB serialized
verify projection rows and events commit atomically
verify broadcasts happen only after commit
verify Goal-scoped reads reject ownership mismatches
verify prompts and raw responses are not persisted, emitted, or logged
verify hidden workers do not appear in user session flows
verify hidden workers cannot mutate workflow state
verify fallback attempts are explicit and ordered
verify human review remains a structured proposal path and not a validation bypass
explain what was implemented
explain any deviations
explain any technical concerns

After finishing:

update `4-do-implementation-plan.md` to prepare for the next step
Commit changes
Output changes from a product perspective

Do not implement unrelated future milestone functionality.
