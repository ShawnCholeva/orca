# Orchestrator Transport Fallback - Design Spec

**Date:** 2026-05-25
**Status:** Draft
**Owner:** Shawn Choleva

## Problem

Orca is orchestration-first. The workflow orchestrator is core product infrastructure, not an optional enhancement that can disappear when model API keys are missing.

The current workflow path persists a provider/model choice on each Goal and uses daemon-side `ModelProvider.complete()` calls when the orchestrator needs LLM-backed operator selection. The existing `ModelProvider` interface is intentionally SDK-shaped: it checks API-key availability, lists models, sends a structured prompt, parses JSON, and records `workflow_llm_calls`. That is useful for daemon-owned SDK calls, but it makes core orchestrator setup look API-key-dependent.

The product direction is different: a user should be able to use orchestration with signed-in local AI CLIs and no daemon API-key setup. The Goal UX should remain provider-based because users think in providers and models, but the daemon should choose the execution transport. For a selected provider/model, Orca should first try a verified one-shot transport when allowed, then fall back to a hidden interactive worker for the same provider, and finally fall back to human-reviewed orchestration.

## Goals

- Keep Goal/provider UX provider-based: users choose `OpenAI`, `Claude`, or `Gemini`, not "one-shot" or "interactive worker".
- Remove API keys as a core setup requirement for orchestrator use.
- Add an Orca-controlled orchestration transport policy with ordered fallback:
  1. `one_shot`
  2. `hidden_interactive`
  3. `human_review`
- Exclude `Claude` from one-shot in v1 to avoid the separate additional-charge / credit / payment model associated with the Agent SDK / `claude -p` path.
- Treat hidden interactive sessions as daemon-managed orchestration workers, not ordinary user sessions and not normal `ModelProvider` calls.
- Preserve the daemon authority boundary: transports return structured proposals; only the daemon validates, persists, emits events, and advances workflow state.
- Leave inspectable traces for every transport attempt, rejection, fallback, and final proposal.

## Non-goals

- Do not redesign Orca around "orchestrator optional."
- Do not require local model downloads in v1.
- Do not use a 1B local model as the orchestrator.
- Do not make local-model fallback a v1 requirement.
- Do not expose transport selection as user configuration.
- Do not let hidden workers mutate workflow state directly.
- Do not silently fail over between transports.
- Do not replace existing user-visible PTY sessions or workflow session launch behavior.
- Do not remove SDK-backed `ModelProvider` support; it remains useful for explicit API-key setups and tests.

## Current Codebase Fit

### Existing pieces that stay

- `packages/contracts/src/workflows/index.ts`
  - `ModelProviderId`, `ModelProviderInfo`, `OrchestratorModelChoice`, `WorkflowDecisionTrace`, `WorkflowLlmCall`, `OperatorSelection`, and workflow response schemas already define the Goal/provider and decision surfaces.
- `apps/daemon/src/llm/types.ts`
  - `ModelProvider.complete()` remains the SDK/API-key one-shot interface. It should not be stretched to represent CLI workers.
- `apps/daemon/src/llm/registry.ts`
  - `ModelProviderRegistry` can remain the registry for SDK providers, but the provider picker should not depend only on SDK availability.
- `apps/daemon/src/workflows/orchestrator/service.ts`
  - `OrchestratorService.requestNextDecision()` remains the daemon-owned workflow decision entry point.
  - Deterministic workflow checks for missing inputs, satisfied exit criteria, and human-input gates stay as-is.
  - The operator-selection branch is where v1 transport-backed orchestration plugs in.
- `apps/daemon/src/workflows/operators/selector.ts`
  - `OperatorSelector` already has the right post-LLM pattern: structured output, schema validation, registry validation, guardrail checks, persisted call trace, and deterministic fallback.
  - Its current `tryLlm()` path is too tightly coupled to `ModelProvider.complete()` and should become a consumer of a new orchestration transport layer.
- `apps/daemon/src/pty/types.ts` and `apps/daemon/src/pty/manager.ts`
  - `NodePtyManager` is already isolated as the only `node-pty` import and is the right primitive for hidden interactive workers.
- `apps/daemon/src/adapters/{claude-code,codex,gemini}.ts`
  - Agent adapters already know how to find local CLIs, run readiness/auth checks, and resolve spawn commands.
  - Hidden workers should reuse this adapter knowledge rather than duplicating binary/auth logic.
- `apps/daemon/src/sessions/reconciliation.ts`
  - Boot reconciliation already marks stale running user sessions failed. Hidden workers need the same supervised reconciliation pattern, but in a worker-specific table/lifecycle.
- `apps/desktop/src/orchestrator/components/OrchestratorModelPicker.tsx`
  - The picker is the right UX location for provider/model choice, but its labels and empty state need to stop presenting API keys as the only path.

### Existing pieces that need extension

- User-facing provider naming:
  - `OpenAI` remains `OpenAI`.
  - `orca/anthropic` may remain an internal compatibility ID, but product-facing labels must render as `Claude`.
  - `orca/google-gemini` should render as `Gemini`.
- Provider listing:
  - `GET /v1/model-providers` currently reports SDK provider availability from API keys.
  - It should evolve into an orchestrator provider catalog that can report provider/model choices independent of SDK API-key availability, plus non-user-facing transport health/debug metadata through separate debug endpoints.
  - The desktop picker should not filter out a provider solely because its SDK API key is missing. Human review is always a valid final transport, and automated health should be surfaced separately from "can select this provider for a Goal."
- Orchestrator call trace:
  - `workflow_llm_calls` records SDK call attempts.
  - Transport fallback needs a transport attempt trace that covers one-shot CLI, hidden interactive worker, and human review.

### New layer to introduce

Introduce an `OrchestrationTransportRegistry` and `OrchestrationTransportBroker` in the daemon workflow/orchestrator boundary.

The broker receives a provider/model selection and a typed orchestration request. It resolves transport attempts in policy order, records each attempt, and returns either a valid structured proposal or a human-review request.

It should not live in `llm/` because `llm/` is SDK provider code. It should live under workflow orchestration, for example:

```txt
apps/daemon/src/workflows/orchestration-transport/
  types.ts
  broker.ts
  policy.ts
  one-shot/
  hidden-worker/
  human-review.ts
```

The broker becomes the only workflow code that knows about `one_shot`, `hidden_interactive`, and `human_review`.

## Terminology

**Provider**
: Product-facing model family selected on a Goal. User-facing values are `OpenAI`, `Claude`, and `Gemini`.

**Model**
: Provider-specific model choice persisted on the Goal. The selected model influences prompts and CLI invocation, but does not expose transport policy to the user.

**Transport**
: Execution mechanism used by the daemon to obtain an orchestration proposal. V1 transports are `one_shot`, `hidden_interactive`, and `human_review`.

**One-shot**
: A non-interactive CLI or SDK invocation that receives bounded orchestration input and returns one structured response.

**Hidden interactive worker**
: A daemon-supervised interactive CLI process used only for orchestration decisions. It is not shown as an ordinary user session and cannot directly mutate workflow state.

**Human review**
: A structured daemon workflow where Orca assembles the same bounded orchestration input and asks the user to confirm, edit, or supply the final proposal.

**Proposal**
: Structured output from a transport. A proposal is inert until the daemon validates it and commits workflow state.

## Transport Model

### Request shape

The transport layer should use a typed request instead of passing arbitrary prompts around:

```ts
type OrchestrationRequest = {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  kind: "select_operator"; // v1 starts here; future kinds use the same broker
  providerId: ModelProviderId;
  modelId: string;
  input: {
    stepName: string;
    stepPurpose: string;
    recommendedCapabilities: string[];
    recommendedOperatorIds: string[];
    readyOperators: OperatorDescriptor[];
    excludedOperatorIds: string[];
    guardrails: WorkflowGuardrailConfig[];
  };
  schemaName: "OperatorSelection";
  schema: unknown;
};
```

V1 should first replace the LLM-backed part of `OperatorSelector.select()` because that is the current provider-backed orchestration path. The deterministic branches in `OrchestratorService` remain deterministic.

### Response shape

All automated transports return structured proposals:

```ts
type OrchestrationProposal =
  | {
      status: "proposed";
      transport: "one_shot" | "hidden_interactive";
      attemptId: string;
      providerId: ModelProviderId;
      modelId: string;
      parsed: unknown;
      rawTextLength: number | null;
      latencyMs: number;
    }
  | {
      status: "needs_human_review";
      transport: "human_review";
      attemptId: string;
      providerId: ModelProviderId;
      modelId: string;
      reviewPayloadId: string;
    };
```

The caller parses and validates the proposal against the expected schema. For operator selection, that means the existing `OperatorSelection` zod validation, registry validation, guardrail evaluation, and fallback retry behavior remain in daemon code.

### Transport policy

The policy is fixed in Orca code for v1:

| Provider | Attempt 1 | Attempt 2 | Attempt 3 |
|---|---|---|---|
| `OpenAI` | verified `one_shot` via `codex` | hidden interactive worker via `codex` | human review |
| `Gemini` | verified `one_shot` via `gemini` | hidden interactive worker via `gemini-cli` | human review |
| `Claude` | skipped for v1 | hidden interactive worker via `claude-code` | human review |

`Claude` skips one-shot by policy, not because the CLI cannot theoretically be scripted. This avoids making the separate additional-charge / credit / payment model part of core orchestration. Hidden interactive `Claude` sessions are acceptable in v1.

### One-shot allowlist

Initial one-shot allowlist:

```txt
OpenAI -> codex
Gemini -> gemini
```

`Claude` is not in the allowlist.

The allowlist should be explicit, versioned, and test-covered. A provider being present in the model picker does not imply one-shot support.

### One-shot verification

"Verified" means all of the following are true at attempt time:

- The provider is in the one-shot allowlist.
- The mapped CLI is installed.
- The mapped CLI readiness/auth check is `ready`.
- The one-shot runner knows a supported command strategy for the installed CLI family.
- The runner can execute within the daemon's timeout budget and produce parseable output for the requested schema.

A one-shot transport succeeds only if:
- process exits successfully
- output contains exactly one proposal envelope
- proposal version is supported
- kind matches request kind
- payload validates against schema
- selected operator/action survives daemon registry validation
- guardrails pass

If capability or auth cannot be verified before execution, the attempt is rejected as `one_shot_unavailable` and the broker steps down to `hidden_interactive`.

If execution starts but returns invalid JSON/schema output, record `one_shot_parse_failed` and step down.

If execution is rate limited, record `one_shot_rate_limited` and step down.

## Provider Policy

### OpenAI

- Product-facing name: `OpenAI`.
- Preferred one-shot transport: local `codex` CLI.
- Fallback worker: hidden interactive `codex` worker.
- Final fallback: human review.
- API keys are optional for core setup. If a daemon SDK `OpenAI` provider is configured, it may remain available for explicit SDK-backed use, but orchestration availability should not depend on `OPENAI_API_KEY`.

### Gemini

- Product-facing name: `Gemini`.
- Preferred one-shot transport: local `gemini` CLI.
- Fallback worker: hidden interactive `gemini-cli` worker.
- Final fallback: human review.
- API keys are optional for core setup. Gemini CLI readiness may be satisfied by OAuth or configured local credentials, not only `GOOGLE_API_KEY`.

### Claude

- Product-facing name: `Claude`.
- V1 starts at `hidden_interactive`; one-shot is skipped.
- Fallback worker: hidden interactive `claude-code` worker.
- Final fallback: human review.
- The internal provider ID may stay `orca/anthropic` for compatibility, but UI, provider picker copy, logs intended for support, and workflow-facing labels should say `Claude`.

## Daemon Authority Boundary

The daemon remains the only authority allowed to mutate workflow state.

Transport processes may:

- Receive bounded orchestration input.
- Produce structured decision or artifact proposals.
- Emit stdout/stderr captured for debug with redaction and truncation.
- Report lifecycle/health state.

Transport processes may not:

- Insert or update workflow rows directly.
- Mark steps passed, blocked, failed, or skipped.
- Create workflow recommendations directly.
- Create workflow artifacts directly.
- Advance, pause, complete, or cancel workflow runs.
- Write to the Orca SQLite database.
- Call Orca mutation endpoints.

For automated transports, the daemon should pass an environment that identifies the run and worker for tracing but does not provide mutation credentials. Hidden workers should not receive the desktop API token. If future workers need read-only context, use daemon-assembled bounded input files or stdin payloads, not broad API access.

The validation pipeline stays daemon-side:

```txt
transport output
  -> parse structured JSON
  -> zod schema validation
  -> redaction/truncation
  -> registry validation
  -> guardrail evaluation
  -> idempotency fingerprint
  -> workflow_decisions / recommendations / events
```

## Hidden Worker Design

### Recommendation

For v1, hidden workers should reuse the existing PTY and adapter infrastructure but be wrapped by a separate orchestration-worker abstraction.

They should not be ordinary rows in `sessions` because user sessions have different semantics: visible terminal output, user input/resize, workspace/task association, session summaries, memory extraction, and terminal panels. Reusing `sessions` would either leak hidden workers into user UI or force many special cases.

They also should not parallel the whole PTY stack. `NodePtyManager` already isolates `node-pty`; adapters already know binary/auth details. Hidden workers should reuse those primitives through a new runtime:

```txt
OrchestrationWorkerRuntime
  -> AgentAdapter.resolveSpawn(workerSpawnInput)
  -> PtyManager.start(workerPtyOptions)
  -> worker output parser
  -> WorkerHealthMonitor
  -> OrchestrationTransportBroker
```

### Hook-assisted worker drivers

Hidden interactive workers should use provider-native lifecycle hooks when the backing CLI supports them.

Hooks are not the orchestration architecture and are not the workflow authority. They are provider-specific guardrails and observability points used by the hidden worker driver to make interactive CLI behavior more deterministic.

The daemon remains responsible for:

- creating transport attempts,
- supervising worker lifecycle,
- parsing final proposal output,
- validating proposal schema,
- evaluating registry and guardrail constraints,
- persisting workflow decisions,
- emitting workflow events,
- advancing or blocking workflow state,
- falling back to the next transport.

Hooks may help a provider-specific worker driver:

- validate that an incoming prompt is a bounded Orca worker request,
- inject worker-only instructions or context,
- block unsafe or mutating tool use,
- detect permission prompts before the worker appears hung,
- capture sanitized lifecycle/tool/debug signals,
- validate that the final response contains an Orca proposal envelope,
- request a bounded retry when the final response is malformed,
- map provider-specific failures into Orca transport failure reasons.

Hooks must not:

- mutate workflow state,
- create workflow artifacts directly,
- create workflow recommendations directly,
- call Orca mutation endpoints,
- write to the Orca SQLite database,
- receive desktop API tokens,
- bypass daemon proposal validation,
- become the only way Orca detects worker completion.

Hook support should live inside provider-specific worker drivers, not in the generic broker.

```txt
OrchestrationTransportBroker
  -> OrchestrationWorkerRuntime
    -> ClaudeWorkerDriver
      -> Claude Code hooks
    -> CodexWorkerDriver
      -> Codex hooks
    -> GeminiWorkerDriver
      -> Gemini CLI hooks
```

The generic `OrchestrationWorkerRuntime` owns:

- worker lifecycle state,
- PTY process supervision,
- output chunk persistence,
- attempt persistence,
- timeout handling,
- reconciliation,
- health state,
- fallback signaling.

The provider-specific driver owns:

- CLI spawn details,
- hook installation/configuration,
- prompt-ready detection,
- provider-specific auth/rate-limit detection,
- provider-specific proposal-boundary detection,
- provider-specific hook payload parsing,
- provider-specific sanitized debug mapping.

#### Normalized hook capabilities

Provider-specific worker drivers should expose hook capabilities to the shared worker runtime. The runtime must not assume every CLI supports the same hook events.

```ts
type WorkerHookCapability = boolean | "verify";

type WorkerHookCapabilities = {
  sessionStart: WorkerHookCapability;
  promptSubmit: WorkerHookCapability;
  beforeModel: WorkerHookCapability;
  afterModel: WorkerHookCapability;
  beforeToolSelection: WorkerHookCapability;
  beforeToolUse: WorkerHookCapability;
  permissionRequest: WorkerHookCapability;
  afterToolUse: WorkerHookCapability;
  stop: WorkerHookCapability;
  stopFailure: WorkerHookCapability;
  sessionEnd: WorkerHookCapability;
};
```

Initial provider mapping:

```ts
const workerHookCapabilities = {
  claude: {
    sessionStart: true,
    promptSubmit: true,
    beforeModel: false,
    afterModel: false,
    beforeToolSelection: false,
    beforeToolUse: true,
    permissionRequest: true,
    afterToolUse: true,
    stop: true,
    stopFailure: true,
    sessionEnd: true
  },

  codex: {
    sessionStart: true,
    promptSubmit: true,
    beforeModel: false,
    afterModel: false,
    beforeToolSelection: false,
    beforeToolUse: true,
    permissionRequest: true,
    afterToolUse: true,
    stop: true,
    stopFailure: "verify",
    sessionEnd: "verify"
  },

  gemini: {
    sessionStart: true,
    promptSubmit: "verify",
    beforeModel: true,
    afterModel: true,
    beforeToolSelection: true,
    beforeToolUse: true,
    permissionRequest: "verify",
    afterToolUse: true,
    stop: true,
    stopFailure: "verify",
    sessionEnd: true
  }
} satisfies Record<string, WorkerHookCapabilities>;
```

`"verify"` means the implementation must confirm the exact hook name, payload shape, decision behavior, and reliability for the installed CLI version before enabling hook-assisted behavior for that capability.

#### Claude hidden worker hooks

`ClaudeWorkerDriver` should use Claude Code hooks when available.

Recommended hook usage:

- `SessionStart`
  - register or verify the worker session,
  - inject the Orca hidden-worker contract,
  - record model/session metadata.
- `UserPromptSubmit`
  - reject prompts that are not valid `ORCA_WORKER_REQUEST_V1` envelopes,
  - ensure required identifiers are present: `goalId`, `workflowRunId`, `stepRunId`, `kind`, and `schemaName`.
- `PreToolUse`
  - deny mutation-capable tools by default,
  - block shell commands, edits, writes, commits, pushes, and broad filesystem access unless explicitly allowed for the request kind.
- `PermissionRequest`
  - prevent hidden workers from waiting indefinitely on permission prompts,
  - map unexpected permission prompts to a blocked or failed worker state.
- `PostToolUse` / `PostToolUseFailure`
  - record sanitized tool-use summaries for diagnostics,
  - map repeated tool failures into worker health degradation.
- `Stop`
  - inspect the final assistant response,
  - require exactly one valid Orca proposal envelope,
  - request one bounded retry if the envelope is missing or malformed.
- `StopFailure`
  - map provider/model failures into Orca failure reasons.
- `SessionEnd`
  - mark the worker stopped,
  - close or fail any still-running attempt.

#### Codex hidden worker hooks

`CodexWorkerDriver` should use Codex hooks when available, but OpenAI/Codex should still prefer verified `one_shot` in v1.

Recommended hook usage:

- `SessionStart`
  - register the hidden worker and record model/session metadata.
- `UserPromptSubmit`
  - validate the Orca request envelope before Codex processes it.
- `PreToolUse`
  - deny unsafe shell, patch, MCP, or mutating tool use unless explicitly allowed by the request kind.
- `PermissionRequest`
  - convert unexpected permission prompts into a traceable worker-blocked state.
- `PostToolUse`
  - record sanitized tool-use summaries.
- `Stop`
  - enforce the Orca proposal envelope and reject malformed output.

Codex hook behavior should be treated as a guardrail, not a complete security boundary. The daemon-side proposal validation and worker environment restrictions remain required.

#### Gemini hidden worker hooks

`GeminiWorkerDriver` should use Gemini CLI hooks when available.

Recommended hook usage:

- `SessionStart`
  - register the worker and initialize worker-only context.
- `BeforeAgent`
  - validate the Orca request envelope before the agent loop starts.
- `BeforeModel`
  - ensure the prompt sent to the model is bounded to the current request.
- `AfterModel`
  - redact or inspect model output for policy/protocol issues before the agent continues.
- `BeforeToolSelection`
  - restrict available tools for orchestration-only decisions.
- `BeforeTool`
  - block unsafe or mutating tool calls.
- `AfterTool`
  - capture sanitized tool results and failures.
- `AfterAgent`
  - validate the final response and require an Orca proposal envelope.
- `SessionEnd`
  - mark the worker stopped and release leases.

#### Proposal envelope enforcement

Hook-assisted workers should enforce the same proposal envelope as non-hook workers:

```json
{
  "orcaProposalVersion": 1,
  "kind": "select_operator",
  "payload": {
    "operatorId": "agent:codex",
    "operatorKind": "agent",
    "reason": "Best match for code editing and validation.",
    "requiredCapabilities": ["code_editing"],
    "alternativesConsidered": ["human"],
    "confidence": 0.72,
    "requiresUserApproval": true
  }
}
```

A hook may detect malformed output and request a bounded retry, but the daemon still performs final validation.

Retry policy:

- One hook-requested retry is allowed for malformed proposal envelope output.
- If the second output is still invalid, record `interactive_output_invalid`.
- Do not allow infinite hook-driven correction loops.
- The attempt must finish as `rejected` or `failed` before fallback continues.

#### Hook event tracing

Hook outputs should be converted into compact worker/transport trace records.

Suggested trace shape:

```ts
type WorkerHookTrace = {
  attemptId: string;
  workerId: string;
  providerId: ModelProviderId;
  hookEventName: string;
  hookStatus: "started" | "succeeded" | "blocked" | "failed" | "skipped";
  summary: string;
  failureReason?: OrchestrationTransportFailureReason;
  createdAt: string;
};
```

Do not persist full hook stdin payloads by default. Hook traces should store summaries, IDs, failure reasons, and capped/redacted diagnostic output only.

#### Hook configuration and isolation

Hook packs must be scoped to hidden orchestration workers.

They must not affect normal user-visible Claude Code, Codex, or Gemini sessions unless the user explicitly opts into that elsewhere.

V1 should prefer generated per-worker configuration under an Orca-controlled runtime directory rather than modifying a user’s global CLI hook configuration.

Example runtime layout:

```txt
$ORCA_RUNTIME_DIR/orchestration-workers/
  claude/
    hooks/
    settings.json
  codex/
    hooks/
    hooks.json
  gemini/
    hooks/
    settings.json
```

The worker spawn command should point the CLI at the worker-scoped hook configuration when the CLI supports scoped configuration. If a CLI only supports global hook configuration, the driver must not install global hooks silently.

#### Hook failure behavior

Hook failure must never corrupt workflow state.

If a hook fails:

- Record a hook trace.
- Mark the worker degraded if the hook is advisory.
- Mark the worker failed if the hook is required for safe operation.
- Finish the active attempt with a specific failure reason when appropriate.
- Continue fallback through the broker.

Required mappings:

| Hook failure | Worker/attempt result |
|---|---|
| Request envelope validation failed | `interactive_output_invalid` or provider-specific request rejection |
| Unsafe tool use blocked | attempt `rejected`, fallback continues |
| Permission prompt detected | worker `auth_required` or `hung` depending on cause |
| Final proposal envelope missing | one bounded retry, then `interactive_output_invalid` |
| Hook process crashed | worker degraded or failed based on whether hook is required |
| Hook capability missing | disable hook-assisted mode for that capability and rely on PTY supervision or fallback |

#### Security requirements

Hook packs must follow the same authority boundary as workers.

Hooks must not receive:

- desktop API tokens,
- broad Orca mutation credentials,
- raw unbounded workflow context,
- raw secrets,
- unrestricted database access.

Hooks may receive:

- worker ID,
- attempt ID,
- provider/model,
- request kind,
- goal/workflow/step IDs,
- bounded request metadata,
- sanitized output snippets.

All mutation-capable behavior remains daemon-side.

#### Testing requirements for hook-assisted workers

Add provider-specific hook fixture tests.

Required tests:

- Hook capability detection per provider driver.
- Worker-scoped hook config is generated without modifying global user config.
- Invalid request envelope is rejected before model processing when the provider supports prompt-submit/before-agent hooks.
- Unsafe tool use is blocked by provider hooks when supported.
- Permission prompts become traceable worker states.
- Malformed final proposal triggers one retry and then `interactive_output_invalid`.
- Hook crash does not mutate workflow state.
- Hook traces are capped/redacted and do not contain full prompts, full context packages, or secrets.

### Worker lifecycle states

Required persisted states:

| State | Meaning |
|---|---|
| `starting` | Daemon has created a worker row and is resolving/spawning the CLI. |
| `ready` | Worker is alive, authenticated enough to accept orchestration input, and idle. |
| `awaiting_input` | Worker is alive and waiting for the daemon to submit the next bounded request. |
| `producing_decision` | Worker has received a request and is expected to emit a structured proposal. |
| `hung` | Worker exceeded heartbeat/output/decision timeout and is no longer trusted. |
| `auth_required` | Worker output or readiness check indicates auth was lost or login is required. |
| `failed` | Worker hit a terminal spawn/protocol/output failure. |
| `stopped` | Worker was intentionally stopped by the daemon. |

`ready` and `awaiting_input` may collapse operationally for some CLIs, but both states should exist in the model so the debug UI can distinguish "spawned and initialized" from "idle and prompt-ready" when possible.

### Worker table

Add a worker-specific table rather than overloading `sessions`:

```sql
CREATE TABLE orchestration_workers (
  id                    TEXT PRIMARY KEY,
  provider_id            TEXT NOT NULL,
  model                  TEXT NOT NULL,
  adapter_id             TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN (
    'starting','ready','awaiting_input','producing_decision',
    'hung','auth_required','failed','stopped'
  )),
  pid                    INTEGER,
  command                TEXT,
  args_json              TEXT,
  cwd                    TEXT,
  current_goal_id        TEXT REFERENCES goals(id),
  current_workflow_run_id TEXT REFERENCES workflow_runs(id),
  current_step_run_id    TEXT REFERENCES workflow_step_runs(id),
  last_health_at         TEXT,
  last_output_at         TEXT,
  failure_reason         TEXT,
  failure_detail         TEXT,
  created_at             TEXT NOT NULL,
  started_at             TEXT,
  stopped_at             TEXT
);
```

Worker output should use a separate capped output table or blob store, mirroring `session_output_chunks` without joining to user sessions:

```sql
CREATE TABLE orchestration_worker_output_chunks (
  worker_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  byte_offset   INTEGER NOT NULL,
  byte_length   INTEGER NOT NULL,
  written_at    TEXT NOT NULL,
  data          BLOB NOT NULL,
  PRIMARY KEY (worker_id, seq),
  FOREIGN KEY (worker_id) REFERENCES orchestration_workers(id) ON DELETE CASCADE
);
```

Output retention should be capped like session tails. Do not persist full prompts, full context packages, raw model reasoning, or unlimited terminal transcripts.

### Worker attempts

Each orchestration request should create attempt rows independent of worker lifecycle rows:

```sql
CREATE TABLE orchestration_transport_attempts (
  id                    TEXT PRIMARY KEY,
  goal_id               TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id        TEXT REFERENCES workflow_runs(id),
  step_run_id            TEXT REFERENCES workflow_step_runs(id),
  decision_id            TEXT REFERENCES workflow_decisions(id),
  provider_id            TEXT NOT NULL,
  model                  TEXT NOT NULL,
  transport              TEXT NOT NULL CHECK (transport IN (
    'one_shot','hidden_interactive','human_review'
  )),
  worker_id              TEXT REFERENCES orchestration_workers(id),
  status                 TEXT NOT NULL CHECK (status IN (
    'pending','running','succeeded','rejected','failed','fallback'
  )),
  failure_reason         TEXT,
  failure_message        TEXT,
  raw_text_length        INTEGER,
  latency_ms             INTEGER,
  input_fingerprint      TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  finished_at            TEXT
);
CREATE INDEX idx_orch_attempts_goal_created
  ON orchestration_transport_attempts(goal_id, created_at DESC);
CREATE INDEX idx_orch_attempts_workflow_step
  ON orchestration_transport_attempts(workflow_run_id, step_run_id, created_at DESC);
```

This is the inspectable trace. It should show each stepped-down level and why the previous level failed or was rejected.

### Worker health checks

Worker health should combine readiness checks, process state, protocol state, and timeouts:

- Spawn health: binary resolved, PTY spawned, pid recorded.
- Auth health: adapter readiness remains `ready`; auth-loss output patterns mark `auth_required`.
- Prompt health: worker reaches `awaiting_input` or equivalent within startup timeout.
- Decision health: worker emits a bounded proposal before decision timeout.
- Output health: output parser can detect a structured proposal boundary.
- Liveness health: heartbeat or recent output activity stays within configured budget while `producing_decision`.

Health checks should not depend on API keys. They should reuse existing adapter readiness where possible.

### Failure taxonomy

Required transport failure reasons:

| Reason | Applies to | Meaning |
|---|---|---|
| `one_shot_unavailable` | `one_shot` | Provider not allowlisted, CLI missing, unsupported one-shot command, auth not ready, or verification failed before execution. |
| `one_shot_parse_failed` | `one_shot` | Process returned output, but daemon could not parse/validate the requested schema. |
| `one_shot_rate_limited` | `one_shot` | CLI/provider reported quota or rate limiting. |
| `interactive_spawn_failed` | `hidden_interactive` | Worker process could not spawn or initialize. |
| `interactive_hung` | `hidden_interactive` | Worker exceeded startup, heartbeat, or decision timeout. |
| `interactive_auth_lost` | `hidden_interactive` | Worker lost auth or requested login during orchestration. |
| `interactive_output_invalid` | `hidden_interactive` | Worker output was present but could not be parsed/validated. |

Map existing `ProviderError` codes into this taxonomy when SDK-backed one-shot remains in use for explicit API-key paths. For example, SDK `invalid_output` maps to `one_shot_parse_failed`, and SDK `rate_limited` maps to `one_shot_rate_limited`.

### Restart and reconciliation

On daemon boot, reconcile hidden workers before accepting orchestration requests:

- `starting`, `ready`, `awaiting_input`, and `producing_decision` workers from a prior daemon process become terminal `failed` with `failure_reason = 'daemon_restart'`.
- Any `orchestration_transport_attempts` left `pending` or `running` become `failed` with `failure_reason = 'daemon_restart'`.
- Publish compact workflow/worker events after the transaction commits.
- Do not try to reattach to old PTYs in v1.

For runtime restarts:

- A failed or hung worker can be replaced for the next request.
- In-flight request fallback steps down to human review only after recording the worker failure.
- Reuse long-lived workers only when their state is `ready` or `awaiting_input`, provider/model match, and health is current.

### Input/output protocol

Hidden workers receive a bounded request that includes:

- Provider/model.
- Workflow run and step identifiers.
- The specific decision requested.
- A compact list of ready operators.
- Guardrail summaries, not arbitrary policy internals.
- Explicit instruction to return only a structured proposal matching the named schema.

The worker output parser should look for a structured response envelope, not free-form prose. A practical v1 envelope:

```json
{
  "orcaProposalVersion": 1,
  "kind": "select_operator",
  "payload": {
    "operatorId": "agent:codex",
    "operatorKind": "agent",
    "reason": "Best match for code editing and validation.",
    "requiredCapabilities": ["code_editing"],
    "alternativesConsidered": ["human"],
    "confidence": 0.72,
    "requiresUserApproval": true
  }
}
```

The daemon extracts `payload`, validates it against the expected schema, and discards untrusted free-form text except for redacted/capped debug output.

## Fallback Behavior

Fallback must step down one level at a time:

```txt
provider/model selected on Goal
  -> policy resolves next transport
  -> create attempt row
  -> execute attempt
  -> validate proposal
  -> if valid, return proposal to daemon caller
  -> if invalid/unhealthy, finish attempt with reason
  -> step down to next transport
  -> final fallback is human_review
```

Rules:

- Never skip directly from `one_shot` to success without an attempt row.
- Never skip directly from `one_shot` to `human_review` unless hidden interactive is policy-excluded for that provider in a future version. In v1, hidden interactive is attempted for all three providers.
- Never silently fail over. The debug trace must show prior transport, status, reason, message, and timestamps.
- Do not retry the same transport indefinitely. V1 should attempt each transport level at most once per request, except for the existing operator-selection "exclude invalid selected operator and retry" pattern, which can call the broker again with a new input fingerprint.
- Human review is the final fallback. Local model orchestration is not part of v1 fallback.

### Rejected proposals

A transport can return parseable structured output that is rejected by daemon validation. Examples:

- Selected operator is not in `readyOperators`.
- Selected operator kind does not match registry descriptor.
- Guardrail denies the selected action.
- Output schema is valid JSON but semantically unsafe after redaction/truncation.

Rejections must be recorded separately from process failures. The attempt should store `status = 'rejected'` and a failure reason that maps to the transport taxonomy where possible. Then fallback continues.

## Human Review Fallback

Human review should preserve orchestration flow instead of stopping the workflow.

When automated transports are unavailable or unhealthy:

1. Orca assembles the same bounded `OrchestrationRequest`.
2. Orca creates a `human_review` attempt row.
3. Orca creates or returns a structured review payload:
   - requested decision kind,
   - current step purpose,
   - valid operator/action choices,
   - guardrail context,
   - failed transport trace,
   - editable structured proposal form.
4. Desktop shows the review in the workflow run panel or decision trace panel.
5. The human confirms, edits, or supplies the final decision.
6. The daemon validates the submitted proposal with the same schema/registry/guardrail pipeline.
7. The daemon persists the final `workflow_decisions`, recommendations, guardrail evaluations, and events.

Human review is not a bypass. It is a supervised transport where the human supplies the proposal.

## UX Implications

### Provider picker

The picker should continue to ask for the Goal's orchestrator provider/model. It should not ask for transport.

Required product-facing provider names:

- `OpenAI`
- `Claude`
- `Gemini`

The empty state must stop saying API keys are required for orchestration. Instead, it should explain the actionable readiness surface:

- Provider is available when Orca can use a signed-in local CLI or explicit SDK configuration.
- If no automated transport is healthy, the Goal can still proceed with human-reviewed orchestration.

The picker can show provider readiness, but transport details belong in diagnostics/debug UI, not the primary Goal form.

### Workflow run panel

Workflow decisions should surface transport state compactly:

- `Automated by OpenAI`
- `Fell back to interactive worker`
- `Needs human review`
- `Worker auth required`
- `Transport output invalid`

The user should be able to open a trace/debug panel from a decision or workflow run.

### Debug panel

V1 should include a worker/debug panel for support:

- Provider/model.
- Transport attempt timeline.
- Worker lifecycle state.
- Failure reason.
- Sanitized/capped output tail.
- Last readiness/auth result.
- Restart count.
- Whether fallback occurred and why.

This panel should not display full prompts, raw context packages, or raw model responses beyond capped/redacted debug output.

## Observability and Events

Add compact domain events for transport traceability:

```txt
workflow.transport.attempt_started
workflow.transport.attempt_finished
workflow.transport.fallback
workflow.worker.state_changed
workflow.human_review.requested
```

Events should carry IDs and summary fields only:

- `goalId`
- `workflowRunId`
- `stepRunId`
- `attemptId`
- `workerId` when applicable
- `providerId`
- `transport`
- `status`
- `failureReason`

Do not put raw prompts, raw outputs, rendered context, or proposal bodies in event payloads. The repo already caps workflow event payloads in `apps/daemon/src/workflows/events.ts`; the new events should follow the same pattern.

The attempt rows are the durable trace. Events are for live refresh.

## Data Model Impact

Add a migration after the current workflow migrations for:

- `orchestration_workers`
- `orchestration_worker_output_chunks`
- `orchestration_transport_attempts`

Extend provider/model metadata only if needed to represent provider catalog independently from SDK availability.

Do not remove `workflow_llm_calls` in v1. It remains useful for SDK-backed `ModelProvider.complete()` attempts and for compatibility with existing tests. Over time, SDK calls can either be represented as `one_shot` transport attempts or cross-linked from `orchestration_transport_attempts` to `workflow_llm_calls`.

Recommended v1 relationship:

- `orchestration_transport_attempts` is the primary orchestration trace.
- `workflow_llm_calls` remains a lower-level SDK call trace.
- If a compatibility or explicit SDK-backed path is used, the attempt row can store a future nullable `llm_call_id`; otherwise it stays null.
- SDK-backed calls are not part of the default core availability policy and must not make API keys required for orchestrator setup.

## API and Contract Impact

### Contracts

Add workflow contract enums/types:

- `OrchestrationTransport = 'one_shot' | 'hidden_interactive' | 'human_review'`
- `OrchestrationWorkerState`
- `OrchestrationTransportFailureReason`
- `OrchestrationTransportAttempt`
- `OrchestrationWorkerSummary`
- `HumanReviewPayload`
- `SubmitHumanReviewDecisionRequest`

Add required failure reasons:

```txt
one_shot_unavailable
one_shot_parse_failed
one_shot_rate_limited
interactive_spawn_failed
interactive_hung
interactive_auth_lost
interactive_output_invalid
```

### HTTP

Keep existing provider UX endpoints:

- `GET /v1/model-providers`
- `PATCH /v1/goals/:id/orchestrator-model`

Extend or add diagnostics endpoints:

- `GET /v1/goals/:goalId/orchestration-attempts?workflowRunId=:workflowRunId`
- `GET /v1/orchestration-workers`
- `GET /v1/orchestration-workers/:id`
- `POST /v1/goals/:goalId/workflow-runs/:runId/human-review/:attemptId`

Do not expose transport selection endpoints in v1.

### Daemon context

Extend `DaemonContext` with explicit transport dependencies:

```ts
interface DaemonContext {
  // Current DaemonContext fields remain.
  orchestrationTransportBroker: OrchestrationTransportBroker;
  orchestrationWorkerRuntime: OrchestrationWorkerRuntime;
}
```

The broker should receive:

- adapter registry,
- readiness service,
- model provider registry for optional SDK one-shot,
- PTY manager / worker runtime,
- DB/event bus,
- clock/id factory.

## Migration and Rollout Strategy

### Phase 1: Trace model and provider naming

- Add transport/worker contracts and migration.
- Keep current orchestration behavior.
- Change user-facing provider display names to `OpenAI`, `Claude`, and `Gemini`.
- Change picker empty copy so API keys are not presented as the only setup path.

### Phase 2: Broker with current SDK path

- Introduce `OrchestrationTransportBroker`.
- Route existing SDK `ModelProvider.complete()` operator selection through the broker only as a compatibility trace path while CLI transports are being added.
- Do not treat SDK availability as required core setup, and do not add SDK providers to the default one-shot allowlist.
- Preserve current tests and `workflow_llm_calls`.
- Add attempt rows for every SDK call/failure.

### Phase 3: CLI one-shot allowlist

- Add `OpenAI -> codex` and `Gemini -> gemini` one-shot runners.
- Keep `Claude` excluded from one-shot by policy.
- Add parse/rate-limit/unavailable failure mapping.

### Phase 4: Hidden interactive workers

- Add `OrchestrationWorkerRuntime` over `PtyManager` and existing agent adapters.
- Add worker health checks, output parser, reconciliation, and debug endpoints.
- Wire broker fallback from one-shot to hidden interactive worker.

### Phase 5: Human review fallback

- Add structured human-review payloads and submission endpoint.
- Wire desktop review UI into the workflow run panel.
- Ensure daemon validation is identical for automated and human-supplied proposals.

Rollout should be guarded by configuration flags until each phase has tests. The final v1 behavior should default on only when the trace/debug surface is present.

## Testing Strategy

### Unit tests

- Transport policy:
  - OpenAI resolves `one_shot -> hidden_interactive -> human_review`.
  - Gemini resolves `one_shot -> hidden_interactive -> human_review`.
  - Claude resolves `hidden_interactive -> human_review`.
  - Unknown or unsupported providers fail validation before policy execution.
- Failure taxonomy mapping:
  - Required failure reasons are emitted exactly.
  - SDK `ProviderError` values map to transport failure reasons.
- Broker fallback:
  - Steps down one level at a time.
  - Records prior failure before trying next transport.
  - Does not silently skip attempts.
- Proposal validation:
  - Invalid JSON fails parse.
  - Valid JSON with invalid schema is rejected.
  - Valid schema but unknown operator is rejected.
  - Guardrail-denied proposal is rejected or blocked by daemon, not by worker.

### Worker runtime tests

- Fake `PtyManager` drives lifecycle states:
  - `starting`
  - `ready`
  - `awaiting_input`
  - `producing_decision`
  - `hung`
  - `auth_required`
  - `failed`
  - `stopped`
- Spawn failure records `interactive_spawn_failed`.
- Timeout records `interactive_hung`.
- Auth-loss output records `interactive_auth_lost`.
- Invalid output records `interactive_output_invalid`.
- Stopping a worker produces `stopped` and does not retry automatically.
- Boot reconciliation marks stale active workers and attempts failed with `daemon_restart`.

### Integration tests

- `POST /v1/goals/:goalId/workflow-runs/:id/next-decision` still returns a valid decision when:
  - one-shot succeeds,
  - one-shot fails and hidden interactive succeeds,
  - both automated transports fail and human review is requested.
- Existing deterministic workflow branches still bypass the transport broker when no model-backed proposal is needed.
- `workflow.operator.selected` still only emits after daemon validation and persistence.
- Debug endpoints return attempt timelines without raw prompt/context leakage.

### Desktop tests

- Provider picker renders `OpenAI`, `Claude`, `Gemini`.
- Picker does not claim API keys are required for core orchestration.
- Workflow run panel shows fallback/human-review status.
- Debug panel opens from a decision trace and displays failure reason and capped output.
- Human-review form submits structured data and surfaces daemon validation errors.

### Regression constraints

- Hidden workers do not appear in user session lists.
- Hidden worker output is not used by session summary or memory extraction flows.
- Workers do not receive mutation credentials.
- No required local model download path appears in onboarding or provider setup.

## V1 Recommendation

Do:

- Hidden interactive worker sessions.
- Structured decision schema.
- Decision validator.
- Worker health checks.
- Worker debug panel.
- Supervised / human-review workflow fallback.
- No API-key requirement for core orchestrator setup.
- No required local model download.

Do not:

- Require local model fallback.
- Use a 1B model as orchestrator.
- Hide worker failures.
- Let worker sessions mutate workflow state directly.
- Depend on API keys for core setup.
- Add transport selection to user-facing Goal configuration.
- Implement hidden interactive workers until the broker, attempt tracing, proposal validation, and human review fallback are already working.

## Open Questions and Risks

### CLI protocol stability

`codex`, `gemini`, and `claude` interactive behavior can change. The worker abstraction should isolate CLI-specific prompt protocol and output parsing behind provider-specific worker drivers. Driver tests should use fixture transcripts.

### Model identity in CLI transports

Some CLIs may not expose model selection the same way SDK providers do. If a selected model cannot be enforced by CLI transport, the attempt should record that mismatch and either use the provider default with a trace field or reject the transport as unavailable. It should not pretend the selected model was used.

### Cost and quota visibility

Even without daemon API keys, signed-in CLIs may consume user subscription quota. The product copy should avoid promising "free" orchestration. The concrete requirement is no core API-key setup, not no provider-side cost.

### Long-lived worker resource use

Long-lived hidden workers improve latency but add process supervision complexity. V1 should prefer a small pool keyed by provider/model with idle timeout and explicit stop-on-failure. Do not run unbounded workers per Goal.

### Human review ergonomics

Human review must be structured enough to preserve the workflow loop. If the fallback is only a free-form text box, users will lose the benefits of orchestration. The review UI should present valid choices and submit the same schema automated transports use.

### Compatibility with current `orca/anthropic` ID

Renaming internal IDs can cause unnecessary migration churn. V1 should keep existing IDs unless a separate compatibility plan is approved, while making all product-facing strings say `Claude`.

### Scope control

This spec covers orchestration transport and fallback architecture only. It does not define local-model orchestration, autonomous execution, new workflow templates, or broad provider billing/account management.

### Future proofing

Add decision_kind beyond select_operator if this does not already exist

Right now v1 starts with:

kind: "select_operator"

That is fine for implementation, but I’d make the type future-ready now:

type OrchestrationDecisionKind =
  | "select_operator"
  | "score_transition"
  | "evaluate_exit_criteria"
  | "repair_artifact"
  | "run_audit";

You do not need to implement them yet. But naming the future decision kinds now will keep the broker from feeling like it only exists for operator selection.

Especially because the next thing you want is transition scoring.