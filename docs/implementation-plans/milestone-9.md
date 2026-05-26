# Orca — Milestone 9 Implementation Plan

**Source design spec:** `docs/superpowers/specs/2026-05-25-orchestrator-transport-fallback-design.md`
**Builds on:** `docs/implementation-plans/milestone-8.md` (M8 must be complete and green).
**Status:** Not started.

**Scope guard.** Tasks below MUST NOT introduce: local-model orchestration, mandatory local model downloads, user-facing transport selection, hidden workers that appear in normal session lists, hidden workers with mutation credentials, broad Orca API access from workers, global CLI hook installation without explicit user opt-in, direct workflow mutation by transport processes, raw prompt/response persistence, raw context-package persistence in transport traces, raw worker transcript persistence beyond capped/redacted output chunks, autonomous workflow advancement without M7 recommendation acceptance, ACP/A2A protocol routes, provider billing/account management, model-provider ID renames that require migration churn, new top-level packages, or any removal of SDK-backed `ModelProvider` support. Any task requiring such code is out of scope for M9 and belongs in a follow-up milestone.

### Inherited constraints from M1 / M2 / M3 / M4 / M5 / M6 / M7 / M8

**DaemonContext seam.** All new M9 use cases MUST be wired through the explicit `DaemonContext`. M9 adds: `orchestrationTransportBroker: OrchestrationTransportBroker` and `orchestrationWorkerRuntime: OrchestrationWorkerRuntime`. No DI framework, no container, no decorators.

**Registry immutability (M2, M8).** Adapter, skill, model-provider, operator, workflow-template, and orchestration-transport registrations happen before the HTTP listener accepts connections. M9 transport policy is fixed in Orca code for v1 and is not user-editable.

**Native-import isolation (M4).** Only `apps/daemon/src/pty/manager.ts` may `import` `node-pty`. Hidden interactive workers reuse `PtyManager` through `OrchestrationWorkerRuntime`; no other M9 file may import `node-pty`.

**Output isolation rule (M4/M5/M8, extended).** Terminal output remains persisted only in M4's session output store. Hidden worker output is persisted only in M9's worker output store. Workflow orchestration MUST NOT read raw user-session tails or transcripts. Transport traces may store IDs, status, reason codes, byte counts, capped/redacted output snippets, and lifecycle summaries only.

**Content-free events rule (M5/M6/M7/M8, extended).** All M9 domain events carry ids, status, counts, byte sizes, changed-field keys, and failure codes. They MUST NOT carry transport prompts, worker prompts, raw CLI output, raw model responses, proposal bodies, artifact bodies, decision-trace `reason` text, guardrail evaluation messages, memory/decision/summary text, secrets, or workspace file paths. Existing workflow event payload cap remains 4 KiB and is enforced in tests.

**Atomicity rule (carried forward).** Every M9 daemon write that emits domain events MUST insert events and projection rows inside the same SQLite transaction and broadcast on the event bus only after `COMMIT` returns. Transport attempt writes, worker state transitions, human-review request writes, workflow decision writes, recommendations, guardrail evaluations, and fallback events that occur as one logical transition MUST commit in a single transaction.

**Goal-scoped boundary (carried forward).** Every M9 transport attempt, worker current-assignment field, human-review payload, debug read, and final decision carries `goal_id` or is filtered by a goal-scoped parent. List/read endpoints under `/v1/goals/:goalId/...` must verify the requested rows belong to that goal.

**Supervision-only rule (M7/M8, extended).** A transport returns an inert structured proposal. Only daemon code parses, validates, persists, emits events, creates recommendations, and advances workflow state. Human review is also a transport proposal path; it is not a validation bypass.

**Existing wire shapes frozen.** All existing M1-M8 endpoint responses, event names, event payloads, and WebSocket frames remain byte-identical unless this milestone explicitly adds optional response fields or new endpoints. `GET /v1/model-providers` keeps the provider-picker contract but changes semantics from "SDK key available" to "orchestrator provider catalog with readiness metadata." Existing `workflow_llm_calls` remains supported.

The single proof point for M9 is:

```text
User creates a Goal and selects OpenAI, Claude, or Gemini as the Orchestrator provider/model
  -> daemon stores provider+model on Goal as before
  -> provider picker does not require API keys for core orchestration
  -> workflow operator-selection request goes through OrchestrationTransportBroker
  -> broker records a transport attempt for each policy step
  -> OpenAI tries codex one-shot, then codex hidden interactive, then human review
  -> Gemini tries gemini one-shot, then gemini hidden interactive, then human review
  -> Claude skips one-shot by policy and tries claude-code hidden interactive, then human review
  -> every failed/rejected transport attempt stores reason, status, timestamps, and capped/redacted diagnostics
  -> valid automated proposal is parsed, schema-validated, registry-validated, guardrail-checked, and persisted as a workflow decision
  -> invalid/rejected automated proposal steps down to the next transport
  -> human review fallback creates a structured review payload and UI form with valid choices
  -> submitted human proposal runs through the same daemon validation pipeline
  -> hidden workers never appear in user sessions, never receive mutation credentials, and are reconciled to failed on daemon restart
  -> Workflow run panel shows fallback status and opens a debug trace without raw prompt/context leakage
  -> all state survives daemon restart; in-flight worker/attempt rows reconcile to failure
```

---

## Conventions

- **Task ID:** `M9-NNN` (zero-padded, sequenced for default execution order).
- **Affected Areas:** paths relative to repo root.
- **Validation Steps:** every task lists at least one deterministic command or scenario.
- **No task may exceed its declared scope** even if adjacent work seems easy; additive scope belongs in a follow-up task.
- **Full-suite gates:** `pnpm -r typecheck` and `pnpm -r test` run at **M9-006** (contracts + migration + policy/broker skeleton complete), **M9-015** (one-shot + hidden worker runtime complete), and **M9-024** (final).
- **Transport policy:** v1 policy is fixed: OpenAI `one_shot -> hidden_interactive -> human_review`; Gemini `one_shot -> hidden_interactive -> human_review`; Claude `hidden_interactive -> human_review`.
- **Claude one-shot exclusion:** Claude skips one-shot by policy in v1 to avoid making the separate Agent SDK / `claude -p` charge/credit path part of core orchestration.
- **Attempt rows are mandatory:** every policy step creates an `orchestration_transport_attempts` row before execution or policy skip is recorded. No silent fallback.
- **Proposal envelope:** every automated transport returns exactly one `orcaProposalVersion: 1` envelope. The daemon extracts `payload` and validates it against the requested schema.
- **Human review is final fallback:** local model orchestration is not part of M9.
- **Execution assignment format:** each task declares `Model` and `Effort`. Use `GPT Codex 5.3` for code-heavy implementation, tests, and repo edits; `GPT 5.5` for high-risk architecture/contract/orchestration reasoning; `GPT 5.4` for bounded UI/docs/content tasks. Effort is `medium` or `high` only.

---

## Tasks

---

### M9-000 — Baseline Verification

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Lock in a known-good M8 baseline before transport fallback work lands.

**Scope.**
- IS: install, typecheck, tests, record commit SHA/test summary/dirty paths.
- IS NOT: code change, dependency upgrade, migration, or doc rewrite beyond the notes file.

**Requirements.**
- From the repo root, run:
  - `pnpm install --frozen-lockfile`
  - `pnpm -r typecheck`
  - `pnpm -r test`
- Confirm M8 workflow anchors still pass, including workflow contract tests, workflow HTTP surface tests, operator-selection tests, orchestrator service tests, and goal-detail workflow UI tests.
- Record in `docs/implementation-plans/notes/m9-000-baseline.md`:
  - `git rev-parse HEAD`
  - final typecheck/test summary line counts
  - pre-existing dirty paths from `git status --short`

**Affected Areas.**
- New: `docs/implementation-plans/notes/m9-000-baseline.md`

**Validation Steps.**
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` exits 0.
- Notes file contains SHA, summary, and dirty-path list.

**Acceptance Criteria.**
- Baseline SHA and green suite evidence are captured before M9 changes.

---

### M9-001 — Shared Contracts: Transport, Worker, Attempt, Human Review, Events

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Add cross-process schemas for transport fallback without changing runtime behavior.

**Scope.**
- IS: zod enums/types, request/response shapes, debug endpoint response contracts, event payload schemas, provider display naming helpers.
- IS NOT: persistence, broker execution, routes, UI.

**Requirements.**
- Extend `packages/contracts/src/workflows/index.ts` with:

```ts
export const OrchestrationTransport = z.enum(["one_shot", "hidden_interactive", "human_review"]);
export type OrchestrationTransport = z.infer<typeof OrchestrationTransport>;

export const OrchestrationDecisionKind = z.enum([
  "select_operator",
  "score_transition",
  "evaluate_exit_criteria",
  "repair_artifact",
  "run_audit",
]);
export type OrchestrationDecisionKind = z.infer<typeof OrchestrationDecisionKind>;

export const OrchestrationWorkerState = z.enum([
  "starting",
  "ready",
  "awaiting_input",
  "producing_decision",
  "hung",
  "auth_required",
  "failed",
  "stopped",
]);
export type OrchestrationWorkerState = z.infer<typeof OrchestrationWorkerState>;

export const OrchestrationTransportFailureReason = z.enum([
  "one_shot_unavailable",
  "one_shot_parse_failed",
  "one_shot_rate_limited",
  "interactive_spawn_failed",
  "interactive_hung",
  "interactive_auth_lost",
  "interactive_output_invalid",
  "daemon_restart",
  "proposal_rejected",
]);
export type OrchestrationTransportFailureReason = z.infer<typeof OrchestrationTransportFailureReason>;

export const OrchestrationTransportAttemptStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "rejected",
  "failed",
  "fallback",
]);
export type OrchestrationTransportAttemptStatus = z.infer<typeof OrchestrationTransportAttemptStatus>;
```

- Add `OrchestrationRequest`, `OrchestrationProposalEnvelope`, `OrchestrationTransportAttempt`, `OrchestrationWorkerSummary`, `OrchestrationWorkerDetail`, `WorkerHookCapabilities`, `WorkerHookTrace`, `HumanReviewPayload`, `SubmitHumanReviewDecisionRequest`, `ListOrchestrationAttemptsResponse`, `ListOrchestrationWorkersResponse`, and `GetOrchestrationWorkerResponse`.
- `OrchestrationRequest.kind` accepts the future-ready `OrchestrationDecisionKind` enum, but M9 implements only `select_operator`.
- Proposal envelope shape:

```ts
export const OrchestrationProposalEnvelope = z.object({
  orcaProposalVersion: z.literal(1),
  kind: OrchestrationDecisionKind,
  payload: z.unknown(),
});
```

- Add transport event literals and payload schemas:
  - `workflow.transport.attempt_started`
  - `workflow.transport.attempt_finished`
  - `workflow.transport.fallback`
  - `workflow.worker.state_changed`
  - `workflow.human_review.requested`
- Event payloads include only: `goalId`, `workflowRunId`, `stepRunId`, `attemptId`, `workerId`, `providerId`, `transport`, `status`, `failureReason`.
- Add a display-name helper that maps `orca/anthropic` to `Claude`, `orca/openai` to `OpenAI`, and `orca/google-gemini` to `Gemini`.

**Affected Areas.**
- `packages/contracts/src/workflows/index.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/__tests__/workflow-contracts.test.ts`

**Validation Steps.**
- `pnpm --filter @orca/contracts typecheck` exits 0.
- `pnpm --filter @orca/contracts test` exits 0.
- Tests verify enum values, proposal-envelope parsing, human-review request parsing, provider display names, and event payload byte caps.

**Acceptance Criteria.**
- Contracts export every M9 type needed by daemon and desktop.
- No runtime behavior changes.

---

### M9-002 — SQLite Migrations: Worker, Output, Attempt, Hook Trace, Human Review Tables

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Add durable transport trace and worker state storage.

**Scope.**
- IS: forward-only migration, migration tests, indices, boot compatibility.
- IS NOT: usecases, broker, routes, UI.

**Requirements.**
- Create the next migration under `apps/daemon/src/migrations/` and register it in `apps/daemon/src/migrations.ts`.
- Add tables:

```sql
CREATE TABLE orchestration_workers (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'starting','ready','awaiting_input','producing_decision',
    'hung','auth_required','failed','stopped'
  )),
  pid INTEGER,
  command TEXT,
  args_json TEXT,
  cwd TEXT,
  current_goal_id TEXT REFERENCES goals(id),
  current_workflow_run_id TEXT REFERENCES workflow_runs(id),
  current_step_run_id TEXT REFERENCES workflow_step_runs(id),
  last_health_at TEXT,
  last_output_at TEXT,
  failure_reason TEXT,
  failure_detail TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  stopped_at TEXT
);

CREATE TABLE orchestration_worker_output_chunks (
  worker_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  written_at TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (worker_id, seq),
  FOREIGN KEY (worker_id) REFERENCES orchestration_workers(id) ON DELETE CASCADE
);

CREATE TABLE orchestration_transport_attempts (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id TEXT REFERENCES workflow_runs(id),
  step_run_id TEXT REFERENCES workflow_step_runs(id),
  decision_id TEXT REFERENCES workflow_decisions(id),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('one_shot','hidden_interactive','human_review')),
  worker_id TEXT REFERENCES orchestration_workers(id),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','rejected','failed','fallback')),
  failure_reason TEXT,
  failure_message TEXT,
  raw_text_length INTEGER,
  latency_ms INTEGER,
  input_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE orchestration_worker_hook_traces (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES orchestration_transport_attempts(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL REFERENCES orchestration_workers(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  hook_event_name TEXT NOT NULL,
  hook_status TEXT NOT NULL CHECK (hook_status IN ('started','succeeded','blocked','failed','skipped')),
  summary TEXT NOT NULL,
  failure_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE orchestration_human_reviews (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_run_id TEXT REFERENCES workflow_step_runs(id),
  attempt_id TEXT NOT NULL REFERENCES orchestration_transport_attempts(id),
  decision_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','submitted','accepted','rejected')),
  submitted_proposal_json TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT
);
```

- Add indices for goal/run/step timeline reads, worker state reads, and active attempt reconciliation.
- Add tests for fresh DB and upgraded M8 DB.

**Affected Areas.**
- New migration file under `apps/daemon/src/migrations/`
- `apps/daemon/src/migrations.ts`
- `apps/daemon/src/migrations.test.ts`

**Validation Steps.**
- `pnpm --filter @orca/daemon test migrations` exits 0.
- Tests assert table existence, check constraints, indices, foreign keys, and idempotent migration registration.

**Acceptance Criteria.**
- Migration supports fresh install and M8 upgrade.
- No hidden worker data is stored in user `sessions`.

---

### M9-003 — Provider Catalog Semantics and Product-Facing Names

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Keep provider/model UX provider-based while decoupling core orchestration availability from daemon API keys.

**Scope.**
- IS: provider catalog service, `GET /v1/model-providers` semantics, names/copy source data, tests.
- IS NOT: broker execution, transport diagnostics endpoints, UI rendering.

**Requirements.**
- Keep `ModelProviderRegistry` for SDK/API-key providers.
- Add an orchestrator provider catalog under `apps/daemon/src/workflows/orchestration-transport/provider-catalog.ts`.
- Catalog returns OpenAI, Claude, and Gemini even when SDK API keys are absent.
- Product labels:
  - `orca/openai` -> `OpenAI`
  - `orca/anthropic` -> `Claude`
  - `orca/google-gemini` -> `Gemini`
- Availability semantics:
  - `selectable: true` for all three providers because human review is always a valid final transport.
  - `automatedAvailable: boolean` based on CLI readiness or SDK one-shot availability.
  - `readinessReason?: string` capped at 256 chars.
- Update the model-providers route to include the new fields only if contracts already allow them as optional fields; otherwise preserve the old shape and add a new internal projection consumed by later tasks.

**Affected Areas.**
- `apps/daemon/src/llm/registry.ts`
- `apps/daemon/src/workflows/orchestration-transport/provider-catalog.ts` (NEW)
- Existing model-provider route file
- Relevant daemon route tests

**Validation Steps.**
- `pnpm --filter @orca/daemon test model-providers` exits 0, or the closest existing route test command exits 0.
- Tests prove missing `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY` do not remove providers from the catalog.

**Acceptance Criteria.**
- Provider picker can list all three providers without daemon API keys.
- Internal ID `orca/anthropic` remains compatible while product-facing strings say `Claude`.

---

### M9-004 — Transport Policy and Attempt Projection

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Create the deterministic policy and persistence helpers used by every transport path.

**Scope.**
- IS: policy resolver, attempt projection/usecases, content-free events, failure taxonomy mapping.
- IS NOT: one-shot CLI execution, hidden worker runtime, human review UI.

**Requirements.**
- Create `apps/daemon/src/workflows/orchestration-transport/policy.ts` with:

```ts
export function resolveTransportPlan(providerId: ModelProviderId): OrchestrationTransport[] {
  switch (providerId) {
    case "orca/openai":
      return ["one_shot", "hidden_interactive", "human_review"];
    case "orca/google-gemini":
      return ["one_shot", "hidden_interactive", "human_review"];
    case "orca/anthropic":
      return ["hidden_interactive", "human_review"];
  }
}
```

- Create attempt projection/usecases that can:
  - create a `pending` attempt
  - mark `running`
  - mark `succeeded`
  - mark `rejected`
  - mark `failed`
  - mark `fallback`
- Map `ProviderError` values to transport failure reasons:
  - `invalid_output` -> `one_shot_parse_failed`
  - `rate_limited` -> `one_shot_rate_limited`
  - `missing_api_key`, `provider_error`, `timeout`, `internal_error` -> `one_shot_unavailable`
- Emit only the new compact transport events through `apps/daemon/src/workflows/events.ts`.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/types.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/policy.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/attempts.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/events.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/policy.test.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/attempts.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test orchestration-transport` exits 0.
- Tests prove Claude has no `one_shot`, OpenAI/Gemini do, every attempt transition writes an event, and event payloads stay under 4 KiB.

**Acceptance Criteria.**
- Every later transport task can create a trace row through one shared helper.

---

### M9-005 — Proposal Envelope Parser and Daemon Validation Pipeline

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Centralize untrusted transport-output parsing before broker integration.

**Scope.**
- IS: envelope extraction, schema validation, redaction/truncation, operator-selection semantic validation hook.
- IS NOT: CLI execution, workflow decision persistence, broker fallback.

**Requirements.**
- Create `apps/daemon/src/workflows/orchestration-transport/proposals.ts`.
- Parser accepts raw text and returns:
  - `parsed` payload
  - `rawTextLength`
  - `failureReason: one_shot_parse_failed | interactive_output_invalid` on malformed output
- It must reject:
  - no JSON envelope
  - more than one envelope
  - unsupported `orcaProposalVersion`
  - `kind` mismatch
  - payload schema mismatch
- It must validate `select_operator` payload with existing `OperatorSelection` zod schema.
- It must not persist raw text.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/proposals.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/proposals.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test orchestration-transport/proposals` exits 0.
- Tests cover invalid JSON, multiple envelopes, wrong kind, schema mismatch, valid operator selection, and raw length reporting.

**Acceptance Criteria.**
- Automated and human-review proposal paths can reuse the same parser/validator.

---

### M9-006 — Broker Skeleton with SDK Compatibility Trace (GATE)

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Introduce `OrchestrationTransportBroker` without changing final orchestration behavior.

**Scope.**
- IS: broker interface, DaemonContext wiring, SDK compatibility one-shot path, attempt traces around current `ModelProvider.complete()`.
- IS NOT: local CLI one-shot, hidden workers, human review UI.

**Requirements.**
- Create `apps/daemon/src/workflows/orchestration-transport/broker.ts`.
- Broker input is typed `OrchestrationRequest`.
- Broker output is:

```ts
type BrokerResult =
  | { status: "proposed"; attemptId: string; transport: "one_shot" | "hidden_interactive"; parsed: unknown; rawTextLength: number | null; latencyMs: number }
  | { status: "needs_human_review"; attemptId: string; reviewPayloadId: string };
```

- Initially, broker may use SDK `ModelProvider.complete()` only as compatibility trace when an SDK provider is available; SDK availability must not be required for provider catalog selectability.
- Add `orchestrationTransportBroker` to `DaemonContext` and tests/build helpers.
- Preserve existing operator-selection results.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/broker.ts` (NEW)
- `apps/daemon/src/context` or existing daemon context module
- `apps/daemon/src/workflows/operators/selector.ts`
- `apps/daemon/src/workflows/operators/selector.test.ts`
- Daemon test factories that construct `DaemonContext`

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/operators/selector` exits 0.
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` exits 0.

**Acceptance Criteria.**
- Existing operator selection still passes.
- Every SDK-backed selection creates an attempt trace.

---

### M9-007 — One-Shot Runner Abstraction and Allowlist

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Add the daemon-side seam for non-interactive CLI proposals.

**Scope.**
- IS: runner interface, allowlist, command-strategy lookup, fake runner tests.
- IS NOT: Codex/Gemini real command details, hidden worker fallback.

**Requirements.**
- Create `apps/daemon/src/workflows/orchestration-transport/one-shot/types.ts`.
- Create `apps/daemon/src/workflows/orchestration-transport/one-shot/registry.ts`.
- Allowlist:
  - `orca/openai` -> adapter `codex`
  - `orca/google-gemini` -> adapter `gemini`
  - no entry for `orca/anthropic`
- Verification checks:
  - allowlist entry exists
  - adapter exists
  - adapter readiness is `ready`
  - command strategy supports the adapter
- Unsupported or unavailable maps to `one_shot_unavailable`.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/one-shot/types.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/one-shot/registry.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/one-shot/registry.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test orchestration-transport/one-shot` exits 0.
- Tests prove Claude is excluded by policy and by allowlist.

**Acceptance Criteria.**
- Broker can ask whether one-shot is available without knowing provider-specific CLI details.

---

### M9-008 — Codex One-Shot Transport for OpenAI

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Implement OpenAI's preferred one-shot path through the local `codex` CLI.

**Scope.**
- IS: Codex one-shot runner, bounded stdin/prompt envelope, timeout, stdout parser, failure mapping, tests with fake process adapter.
- IS NOT: hidden interactive Codex worker, real smoke test by default.

**Requirements.**
- Add `apps/daemon/src/workflows/orchestration-transport/one-shot/codex.ts`.
- Runner uses existing Codex adapter readiness/spawn resolution instead of duplicating binary/auth logic.
- Request sent to CLI contains only bounded `OrchestrationRequest` JSON and instructions to return one proposal envelope.
- Success requires:
  - process exits 0
  - exactly one proposal envelope
  - `kind` matches request
  - payload validates
- Map failures:
  - missing binary/auth/strategy -> `one_shot_unavailable`
  - invalid output/schema -> `one_shot_parse_failed`
  - rate/quota text -> `one_shot_rate_limited`
- Do not persist full stdout/stderr.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/one-shot/codex.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/one-shot/codex.test.ts` (NEW)
- `apps/daemon/src/adapters/codex.ts` if a small spawn-resolution hook is missing

**Validation Steps.**
- `pnpm --filter @orca/daemon test orchestration-transport/one-shot/codex` exits 0.

**Acceptance Criteria.**
- OpenAI one-shot succeeds with fake Codex output and records parse/rate/unavailable failures deterministically.

---

### M9-009 — Gemini One-Shot Transport

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Implement Gemini's preferred one-shot path through the local `gemini` CLI.

**Scope.**
- IS: Gemini one-shot runner, bounded request, timeout, stdout parser, failure mapping, fake process tests.
- IS NOT: hidden interactive Gemini worker, real smoke test by default.

**Requirements.**
- Add `apps/daemon/src/workflows/orchestration-transport/one-shot/gemini.ts`.
- Reuse existing Gemini adapter readiness/spawn resolution.
- Gemini CLI readiness may be satisfied by OAuth/local credentials and must not require `GOOGLE_API_KEY`.
- Use the same proposal envelope and parser as Codex.
- Map unavailable/parse/rate failures to the required taxonomy.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/one-shot/gemini.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/one-shot/gemini.test.ts` (NEW)
- `apps/daemon/src/adapters/gemini.ts` if a small spawn-resolution hook is missing

**Validation Steps.**
- `pnpm --filter @orca/daemon test orchestration-transport/one-shot/gemini` exits 0.

**Acceptance Criteria.**
- Gemini one-shot succeeds with fake CLI output and never treats missing API key as catalog unselectability.

---

### M9-010 — Worker Runtime Persistence and Output Store

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Build the worker-specific runtime store without launching real hidden workers yet.

**Scope.**
- IS: worker projection/usecases, output chunk store, capped output retention, state transitions, tests.
- IS NOT: provider drivers, PTY spawn, broker fallback.

**Requirements.**
- Create `apps/daemon/src/workflows/orchestration-transport/hidden-worker/store.ts`.
- Support worker creation, state transition, assignment to current goal/run/step, output append, output tail read, and terminal stop/fail.
- Capped output:
  - redact secrets using existing sanitizer
  - cap per output tail response
  - track `byte_offset` and `byte_length`
- Worker states must match contract enum exactly.
- Hidden worker output must not join to `sessions` or trigger session summaries/memory extraction.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/hidden-worker/store.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/hidden-worker/store.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test hidden-worker/store` exits 0.

**Acceptance Criteria.**
- Worker state/output persistence works independently from user sessions.

---

### M9-011 — Worker Runtime over PtyManager

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Supervise hidden interactive CLI processes through the existing PTY seam.

**Scope.**
- IS: `OrchestrationWorkerRuntime`, fake PTY tests, startup/decision/heartbeat timeout handling, auth-loss detection hooks.
- IS NOT: provider-specific hook packs, UI, real smoke tests.

**Requirements.**
- Create `apps/daemon/src/workflows/orchestration-transport/hidden-worker/runtime.ts`.
- Runtime flow:
  - resolve adapter spawn command
  - create `starting` worker row
  - start process via `PtyManager`
  - move to `ready`/`awaiting_input`
  - submit bounded request
  - move to `producing_decision`
  - parse proposal envelope
  - finish attempt as success/rejected/failed
- Timeout mapping:
  - spawn/init timeout -> `interactive_spawn_failed` or `interactive_hung`
  - heartbeat/decision timeout -> `interactive_hung`
  - auth/login prompt -> `interactive_auth_lost`
  - invalid final output -> `interactive_output_invalid`
- Do not pass desktop API tokens or mutation credentials in the worker environment.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/hidden-worker/runtime.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/hidden-worker/runtime.test.ts` (NEW)
- `apps/daemon/src/pty/types.ts` only if a test seam is missing

**Validation Steps.**
- `pnpm --filter @orca/daemon test hidden-worker/runtime` exits 0.

**Acceptance Criteria.**
- Fake PTY tests drive every required worker lifecycle state.

---

### M9-012 — Hook Capability Detection and Worker-Scoped Config

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Add provider hook capabilities as optional guardrails without making hooks the authority boundary.

**Scope.**
- IS: capability maps, scoped config generation, hook trace rows, tests.
- IS NOT: global user hook modification, real CLI hook execution.

**Requirements.**
- Create `apps/daemon/src/workflows/orchestration-transport/hidden-worker/hooks.ts`.
- Initial capability map:
  - Claude: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `StopFailure`, `SessionEnd` supported where adapters confirm availability.
  - Codex: same broad categories, with `stopFailure` and `sessionEnd` marked `"verify"` until confirmed.
  - Gemini: `BeforeAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `AfterAgent`, `SessionEnd`, with uncertain items marked `"verify"`.
- Generate hook config under `$ORCA_RUNTIME_DIR/orchestration-workers/<provider>/...`.
- If a CLI only supports global hook configuration, do not install hooks silently; mark capability skipped and rely on PTY supervision/fallback.
- Persist only capped/redacted hook summaries in `orchestration_worker_hook_traces`.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/hidden-worker/hooks.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/hidden-worker/hooks.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test hidden-worker/hooks` exits 0.
- Tests prove generated config stays under the Orca runtime directory and no global path is modified.

**Acceptance Criteria.**
- Hook support is isolated, optional, traceable, and cannot mutate workflow state.

---

### M9-013 — Provider Hidden Worker Drivers: Claude, Codex, Gemini

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Encapsulate provider-specific interactive prompt protocol and output-boundary detection.

**Scope.**
- IS: three worker drivers, driver registry, fixture transcript tests.
- IS NOT: broker fallback integration, real interactive smoke tests by default.

**Requirements.**
- Create:
  - `apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/claude.ts`
  - `apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/codex.ts`
  - `apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/gemini.ts`
  - `apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/registry.ts`
- Drivers own:
  - CLI spawn details via existing adapters
  - worker-scoped hook config inputs
  - prompt-ready detection
  - auth/rate-limit output detection
  - proposal-boundary detection
  - sanitized provider debug summaries
- Claude driver starts at hidden interactive; it is never registered as one-shot in M9.

**Affected Areas.**
- New files under `apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/`
- Fixture tests under the same tree

**Validation Steps.**
- `pnpm --filter @orca/daemon test hidden-worker/drivers` exits 0.
- Tests use fixture transcripts for success, auth required, permission prompt, malformed proposal, and hung/no-boundary output.

**Acceptance Criteria.**
- Runtime can select the correct driver by provider without special-casing provider logic in the broker.

---

### M9-014 — Worker Reconciliation and Health Checks

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Ensure hidden workers and in-flight attempts do not survive daemon restarts as trusted work.

**Scope.**
- IS: boot reconciliation, health projection, worker replacement policy, tests.
- IS NOT: UI diagnostics, real process reattachment.

**Requirements.**
- Create `apps/daemon/src/workflows/orchestration-transport/hidden-worker/reconcile.ts`.
- On daemon boot before accepting orchestration requests:
  - `starting`, `ready`, `awaiting_input`, and `producing_decision` workers become `failed` with `failure_reason='daemon_restart'`
  - `pending` and `running` attempts become `failed` with `failure_reason='daemon_restart'`
  - events publish only after commit
- Do not try to reattach old PTYs in v1.
- Runtime may reuse a worker only when provider/model match, state is `ready` or `awaiting_input`, and health is current.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/hidden-worker/reconcile.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/hidden-worker/reconcile.test.ts` (NEW)
- Daemon boot wiring

**Validation Steps.**
- `pnpm --filter @orca/daemon test hidden-worker/reconcile` exits 0.

**Acceptance Criteria.**
- Restarted daemon never trusts stale hidden worker or attempt rows.

---

### M9-015 — Broker Fallback: One-Shot to Hidden Interactive to Human Review (GATE)

**Execution Assignment.** Model: `GPT 5.5`; Effort: `high`.

**Purpose.** Make the broker execute the full ordered fallback policy.

**Scope.**
- IS: broker orchestration across policy steps, attempt status transitions, fallback events, rejected proposal handling.
- IS NOT: desktop human-review UI, debug endpoints.

**Requirements.**
- Broker executes policy one transport at a time.
- For each step:
  - create attempt row
  - mark running when execution begins
  - validate proposal through daemon parser
  - mark succeeded/rejected/failed
  - emit fallback event before trying the next transport
- Rejected proposals are distinct from process failures.
- V1 attempts each transport level at most once per request.
- Existing operator-selection "exclude invalid selected operator and retry" may call the broker again with a new fingerprint.
- If all automated transports fail/reject, create a `human_review` attempt and return `needs_human_review`.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/broker.ts`
- `apps/daemon/src/workflows/orchestration-transport/broker.test.ts`
- `apps/daemon/src/workflows/operators/selector.ts`
- `apps/daemon/src/workflows/operators/selector.test.ts`

**Validation Steps.**
- `pnpm --filter @orca/daemon test orchestration-transport/broker` exits 0.
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` exits 0.

**Acceptance Criteria.**
- Tests prove OpenAI/Gemini step through all three levels and Claude skips one-shot.
- No fallback happens without a prior attempt row.

---

### M9-016 — Human Review Usecases and Submission Route

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Preserve orchestration flow when automated transports are unavailable or unhealthy.

**Scope.**
- IS: human-review payload creation, route, submission validation, final decision handoff.
- IS NOT: desktop UI.

**Requirements.**
- Create `apps/daemon/src/workflows/orchestration-transport/human-review.ts`.
- Add route:
  - `POST /v1/goals/:goalId/workflow-runs/:runId/human-review/:attemptId`
- Human review payload includes:
  - requested decision kind
  - current step purpose
  - valid operator/action choices
  - guardrail summaries
  - failed transport trace
  - editable structured proposal defaults
- Submission validates:
  - goal/run/attempt ownership
  - review status is `pending`
  - proposal envelope kind matches request
  - payload schema, registry, and guardrail checks pass
- Submission persists workflow decision/recommendations/events through existing M8 services.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/human-review.ts` (NEW)
- `apps/daemon/src/workflows/orchestration-transport/routes.ts` (NEW or existing route module)
- Route registration
- `apps/daemon/src/workflows/orchestration-transport/human-review.test.ts` (NEW)

**Validation Steps.**
- `pnpm --filter @orca/daemon test orchestration-transport/human-review` exits 0.

**Acceptance Criteria.**
- Human review is a structured proposal path and not a free-form bypass.

---

### M9-017 — OperatorSelector Integration and Decision Trace Cross-Links

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Replace the old LLM-only operator-selection branch with broker-backed transport proposals.

**Scope.**
- IS: `OperatorSelector` broker call, attempt-to-decision cross-linking, preserved deterministic fallbacks.
- IS NOT: other workflow decision kinds.

**Requirements.**
- `apps/daemon/src/workflows/operators/selector.ts` uses `OrchestrationTransportBroker` for model-backed selection.
- Deterministic branches remain deterministic:
  - no ready operators
  - human-only guardrail
  - missing input
  - known exact operator match
- After daemon validation, successful attempt gets `decision_id` populated.
- Decision traces include transport summary metadata by ID only, not raw proposal text.
- Existing M8 decision trace UI can still read old decisions.

**Affected Areas.**
- `apps/daemon/src/workflows/operators/selector.ts`
- `apps/daemon/src/workflows/operators/selector.test.ts`
- `apps/daemon/src/workflows/decisions/usecases.ts` if cross-link helper is needed

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/operators/selector` exits 0.
- Tests prove rejected operator proposals fall back and do not persist an invalid decision.

**Acceptance Criteria.**
- Operator selection is transport-backed while daemon validation remains authoritative.

---

### M9-018 — Diagnostics HTTP Surface

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Expose inspectable traces for support and UI without exposing transport selection controls.

**Scope.**
- IS: read-only diagnostics endpoints, goal scoping, capped output tail, tests.
- IS NOT: mutation endpoints for transport choice.

**Requirements.**
- Add endpoints:
  - `GET /v1/goals/:goalId/orchestration-attempts?workflowRunId=:workflowRunId`
  - `GET /v1/orchestration-workers`
  - `GET /v1/orchestration-workers/:id`
- Attempt list returns timeline rows with provider/model, transport, status, reason, timestamps, linked worker/review IDs.
- Worker detail returns lifecycle state, last readiness/auth summary, restart count if available, hook traces, and capped/redacted output tail.
- Endpoints must not return raw prompts, raw context packages, raw model responses, full proposal bodies, or secrets.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestration-transport/routes.ts`
- `apps/daemon/src/workflows/__tests__/http-surface.test.ts`

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/__tests__/http-surface` exits 0.
- Tests assert unauthorized cross-goal attempt reads return 404 or equivalent not-found behavior.

**Acceptance Criteria.**
- Debug trace is inspectable and read-only.

---

### M9-019 — Transport Event Emission and Privacy Audit

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Enforce content-free observability across the new transport surfaces.

**Scope.**
- IS: event coverage tests, payload cap tests, sanitizer assertions, logging audit.
- IS NOT: new product features.

**Requirements.**
- Extend event cap tests for all M9 event payloads.
- Add negative tests that attempt to include:
  - prompt text
  - proposal payload
  - raw worker output
  - raw context package body
  - `authorization: bearer`
  - `api_key=`
  - `token=`
- Audit logs in new transport modules and remove or sanitize any raw prompt/output logging.

**Affected Areas.**
- `apps/daemon/src/workflows/__tests__/event-payload-caps.test.ts`
- `apps/daemon/src/workflows/__tests__/event-emit-coverage.test.ts`
- New M9 transport modules as needed

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/__tests__/event-payload-caps` exits 0.
- `pnpm --filter @orca/daemon test workflows/__tests__/event-emit-coverage` exits 0.

**Acceptance Criteria.**
- No M9 event or log path leaks raw prompt/output/proposal content.

---

### M9-020 — Desktop Provider Picker Copy and Readiness

**Execution Assignment.** Model: `GPT 5.4`; Effort: `medium`.

**Purpose.** Stop presenting API keys as the only path for orchestrator setup.

**Scope.**
- IS: provider display names, empty state, readiness badges/copy, tests.
- IS NOT: transport selection controls, debug panel.

**Requirements.**
- Update `apps/desktop/src/orchestrator/components/OrchestratorModelPicker.tsx`.
- Required visible names:
  - `OpenAI`
  - `Claude`
  - `Gemini`
- Empty state must communicate:
  - signed-in local CLIs or explicit SDK configuration can provide automated orchestration
  - if no automated transport is healthy, the Goal can still proceed with human-reviewed orchestration
- Do not expose `one_shot`, `hidden_interactive`, or transport policy as selectable Goal fields.

**Affected Areas.**
- `apps/desktop/src/orchestrator/components/OrchestratorModelPicker.tsx`
- `apps/desktop/src/orchestrator/components/OrchestratorModelPicker.test.tsx`
- Relevant CSS if needed

**Validation Steps.**
- `pnpm --filter @orca/desktop test OrchestratorModelPicker` exits 0.

**Acceptance Criteria.**
- Picker lists provider/model choices without implying API keys are mandatory.

---

### M9-021 — Workflow Run Panel Transport Status and Debug Drawer

**Execution Assignment.** Model: `GPT 5.4`; Effort: `high`.

**Purpose.** Show compact transport status and inspectable fallback trace.

**Scope.**
- IS: attempt timeline fetch, status labels, debug drawer, tests.
- IS NOT: human-review form.

**Requirements.**
- Update `apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.tsx` and related components.
- Compact status labels:
  - `Automated by OpenAI`
  - `Fell back to interactive worker`
  - `Needs human review`
  - `Worker auth required`
  - `Transport output invalid`
- Add a debug drawer opened from a decision or workflow run.
- Drawer shows provider/model, attempt timeline, worker state, failure reason, sanitized/capped output tail, last readiness/auth result, and whether fallback occurred.
- Drawer does not show raw prompt, raw context package, raw model response, or full proposal body.

**Affected Areas.**
- `apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.tsx`
- `apps/desktop/src/goal-detail/workflow/DecisionTraceTimeline.tsx`
- New debug component under `apps/desktop/src/goal-detail/workflow/`
- `apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.test.tsx`

**Validation Steps.**
- `pnpm --filter @orca/desktop test WorkflowRunPanel` exits 0.

**Acceptance Criteria.**
- Users can inspect fallback reason without seeing sensitive transport internals.

---

### M9-022 — Human Review Desktop Flow

**Execution Assignment.** Model: `GPT 5.4`; Effort: `high`.

**Purpose.** Let users confirm, edit, or supply a structured proposal when automated transports fail.

**Scope.**
- IS: human-review panel/form, valid operator choices, submission errors, tests.
- IS NOT: free-form-only fallback, transport policy selection.

**Requirements.**
- Add a human-review component under `apps/desktop/src/goal-detail/workflow/`.
- Form displays:
  - decision kind
  - current step purpose
  - valid operator/action choices
  - failed transport trace summary
  - editable proposal fields for operator selection
- For `select_operator`, user must submit:
  - `operatorId`
  - `operatorKind`
  - `reason`
  - `requiredCapabilities`
  - `alternativesConsidered`
  - `confidence`
  - `requiresUserApproval`
- Submission calls `POST /v1/goals/:goalId/workflow-runs/:runId/human-review/:attemptId`.
- Daemon validation errors are displayed near the form field or summary area.

**Affected Areas.**
- New human review component under `apps/desktop/src/goal-detail/workflow/`
- `apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.tsx`
- New/updated desktop API client functions
- New tests under `apps/desktop/src/goal-detail/workflow/`

**Validation Steps.**
- `pnpm --filter @orca/desktop test human-review` exits 0, or the matching component test command exits 0.

**Acceptance Criteria.**
- Human review submits the same structured schema automated transports use.

---

### M9-023 — End-to-End Transport Fallback Integration Tests

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `high`.

**Purpose.** Prove the milestone behavior across daemon services and HTTP routes.

**Scope.**
- IS: integration tests with fake runners/workers/human review; no real CLI/network dependency.
- IS NOT: manual smoke tests as required CI gates.

**Requirements.**
- Add integration coverage for:
  - one-shot succeeds and `workflow.operator.selected` emits only after persistence
  - one-shot fails and hidden interactive succeeds
  - one-shot and hidden interactive fail, human review is requested
  - Claude skips one-shot and attempts hidden interactive first
  - rejected proposal from any automated transport records `rejected` and falls back
  - deterministic workflow branches bypass broker when no model-backed proposal is needed
  - hidden workers do not appear in user session lists
  - debug endpoints return capped/redacted traces
- Use fake providers/runners/runtime; no real API keys or local CLI installation required.

**Affected Areas.**
- `apps/daemon/src/workflows/orchestrator/service.test.ts`
- `apps/daemon/src/workflows/operators/selector.test.ts`
- New integration test under `apps/daemon/src/workflows/orchestration-transport/`
- Existing session route tests if needed

**Validation Steps.**
- `pnpm --filter @orca/daemon test workflows/orchestrator/service` exits 0.
- `pnpm --filter @orca/daemon test orchestration-transport` exits 0.

**Acceptance Criteria.**
- The daemon proof path works for automated success, automated fallback, and human-review fallback.

---

### M9-024 — Final Full-Suite Gate

**Execution Assignment.** Model: `GPT Codex 5.3`; Effort: `medium`.

**Purpose.** Verify the complete M9 change set across packages.

**Scope.**
- IS: full typecheck/test, fix regressions caused by M9.
- IS NOT: unrelated refactors or new scope.

**Requirements.**
- Run:
  - `pnpm -r typecheck`
  - `pnpm -r test`
- If a failure is caused by M9, fix it in the smallest relevant task area and rerun the failing command.
- If a failure is pre-existing and documented in M9-000, cite it in final notes instead of masking it.

**Affected Areas.**
- Any M9-touched file needed to fix regressions.

**Validation Steps.**
- `pnpm -r typecheck` exits 0.
- `pnpm -r test` exits 0.

**Acceptance Criteria.**
- Full suite is green or every non-green item is documented as pre-existing with evidence from M9-000.

---

### M9-025 — Milestone Documentation Pass

**Execution Assignment.** Model: `GPT 5.4`; Effort: `medium`.

**Purpose.** Leave implementation notes and operator-facing documentation current.

**Scope.**
- IS: milestone notes, API docs/readme updates if the repo has those surfaces, cleanup of stale API-key-only copy.
- IS NOT: broad documentation rewrite.

**Requirements.**
- Update implementation notes under `docs/implementation-plans/notes/` with:
  - final policy behavior
  - known CLI protocol limitations
  - manual smoke-test instructions for Codex/Gemini/Claude workers
  - privacy guarantees for trace/debug data
- Search docs and desktop copy for API-key-only orchestration claims and update only the M9-relevant references.
- Preserve internal `orca/anthropic` compatibility notes.

**Affected Areas.**
- `docs/implementation-plans/notes/`
- M9-relevant docs/copy files discovered by `rg "API key|api key|Anthropic|Claude|Gemini|OpenAI"`

**Validation Steps.**
- `rg "API keys are required|API key required|Anthropic" docs apps/desktop/src` shows no M9-stale user-facing claims.
- `pnpm --filter @orca/desktop test OrchestratorModelPicker` exits 0 if copy tests changed.

**Acceptance Criteria.**
- Docs explain no daemon API key is required for core orchestrator setup and that signed-in CLIs may still consume provider quota.

---

## Acceptance Mapping (Design Spec → Tasks)

- Provider UX stays provider/model-based: M9-001, M9-003, M9-020.
- API keys are not core setup requirement: M9-003, M9-020, M9-023.
- Ordered fallback policy: M9-004, M9-006, M9-007, M9-015, M9-023.
- Claude one-shot exclusion: M9-004, M9-007, M9-015, M9-023.
- Hidden workers are daemon-managed, not user sessions: M9-002, M9-010, M9-011, M9-023.
- Daemon authority boundary: M9-005, M9-015, M9-016, M9-017.
- Inspectable traces: M9-002, M9-004, M9-018, M9-021.
- Hook-assisted worker drivers: M9-012, M9-013.
- Worker lifecycle and reconciliation: M9-010, M9-011, M9-014.
- Human review fallback: M9-016, M9-022, M9-023.
- Privacy/content-free events: M9-001, M9-019, M9-021, M9-025.

---

## Self-Review Checklist (for the engineer executing this plan)

- Confirm every M9 task preserves existing M8 workflow contracts unless the task explicitly adds optional fields or new endpoints.
- Confirm every transport attempt creates a trace row before execution or fallback.
- Confirm every automated proposal is validated by daemon code before any workflow mutation.
- Confirm hidden workers are absent from user session lists and session-summary/memory flows.
- Confirm debug UI and endpoints never expose raw prompt, raw context package, raw model response, full proposal body, secrets, or workspace file paths.
- Confirm `pnpm -r typecheck` and `pnpm -r test` pass at M9-006, M9-015, and M9-024.
