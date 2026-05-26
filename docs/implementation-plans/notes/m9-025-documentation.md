# M9-025 Documentation Pass - Transport Fallback

Date: 2026-05-25
Reviewer: Codex
Baseline note: `docs/implementation-plans/notes/m9-000-baseline.md`
Final full-suite gate: `docs/implementation-plans/notes/m9-024-gate.md`

## Final Policy Behavior

- Core orchestrator setup does not require daemon SDK API keys. `GET /v1/model-providers`
  remains the Goal provider/model picker surface and lists OpenAI, Claude, and
  Gemini as orchestrator choices.
- Internal provider IDs remain stable: `orca/openai`, `orca/anthropic`, and
  `orca/google-gemini`. Product-facing copy maps `orca/anthropic` to `Claude`;
  compatibility references may still use the internal `orca/anthropic` ID.
- OpenAI policy is ordered as `one_shot -> hidden_interactive -> human_review`.
- Gemini policy is ordered as `one_shot -> hidden_interactive -> human_review`.
- Claude policy is ordered as `hidden_interactive -> human_review`; Claude
  one-shot is intentionally excluded in M9.
- Every policy level creates an `orchestration_transport_attempts` row before
  execution or fallback. Human review remains the final structured proposal path,
  not a validation bypass.
- Signed-in local CLIs or explicit SDK configuration can provide automated
  orchestration. Signed-in CLIs may still consume provider quota even though
  daemon API keys are not a core setup requirement.

## Known CLI Protocol Limitations

- M9 does not invent or depend on unverified CLI flags for Claude Code, Codex, or
  Gemini. Drivers use existing adapter spawn/readiness surfaces and bounded PTY
  behavior.
- Automated CI uses fake runners/workers for transport fallback proof. Real CLI
  behavior is an opt-in smoke path because installed CLI versions, auth state,
  and provider quota are user-local.
- Codex hook support for `StopFailure` and `SessionEnd` is marked `verify` until
  confirmed for the installed CLI version.
- Gemini `BeforeAgent` request-envelope blocking is marked `verify` until
  confirmed for the installed CLI version.
- Gemini readiness can be configuration-detected rather than smoke-tested. A
  detected API key, Vertex configuration, ADC file, or OAuth cache does not prove
  a future model call will succeed.
- Daemon restart does not reattach to old hidden-worker PTYs in M9. Stale
  workers and pending/running attempts reconcile to `failed` with
  `daemon_restart`.

## Manual Smoke Instructions

Run these only on a machine where the target CLI is installed and intentionally
signed in. Do not add API keys or secrets to test logs.

- Codex adapter/auth smoke:
  - `ORCA_RUN_REAL_SMOKE=1 pnpm --filter @orca/daemon test adapters/codex.auth-smoke`
  - `ORCA_REAL_ADAPTER_SMOKE_CODEX=1 pnpm --filter @orca/daemon test adapters/codex.smoke`
- Claude Code adapter/auth smoke:
  - `ORCA_RUN_REAL_SMOKE=1 pnpm --filter @orca/daemon test adapters/claude-code.auth-smoke`
  - `ORCA_REAL_ADAPTER_SMOKE_CLAUDE_CODE=1 pnpm --filter @orca/daemon test adapters/claude-code.smoke`
- Gemini worker smoke:
  - Confirm `gemini` is installed and signed in or configured with local
    credentials.
  - Create a Goal selecting Gemini as the orchestrator provider/model.
  - Start an Engineering workflow and inspect the workflow run transport panel.
  - Expected order is Gemini `one_shot`, then Gemini hidden interactive only if
    one-shot fails or is rejected, then human review if no valid automated
    proposal is accepted.

For all providers, verify these observations during the manual workflow smoke:

- OpenAI attempts Codex `one_shot` before Codex hidden interactive.
- Claude starts at Claude Code hidden interactive and has no one-shot attempt.
- The workflow run panel shows ordered attempts and a debug trace without raw
  prompt, raw context, raw proposal body, or raw worker transcript.
- `GET /v1/goals/:goalId/orchestration-attempts?workflowRunId=:workflowRunId`
  returns only Goal-owned attempts.
- `GET /v1/orchestration-workers` and `GET /v1/orchestration-workers/:id`
  expose worker diagnostics only as capped/redacted control-plane state.
- Ordinary Goal session lists do not include hidden workers.
- If automated transport cannot produce a valid proposal, the human review form
  appears and the submitted proposal runs through the same daemon validation path.

## Privacy Guarantees

- M9 events are content-free control-plane signals only:
  `workflow.transport.attempt_started`, `workflow.transport.attempt_finished`,
  `workflow.transport.fallback`, `workflow.worker.state_changed`, and
  `workflow.human_review.requested`.
- Event payloads carry IDs, statuses, failure codes, counts, and timestamps only;
  payload cap tests enforce the serialized size ceiling.
- Debug reads return projection state and capped/redacted diagnostics. They do
  not return raw prompts, raw context packages, raw model responses, full
  proposal bodies, secrets, workspace file paths, guardrail messages, memory
  text, decision text, summaries, or full worker transcripts.
- Worker output is stored outside the general event store and retained as capped
  chunks. Hook traces store summaries only.
- Only daemon code validates, persists, emits events, creates recommendations,
  and advances workflow state. Hidden workers receive bounded request input and
  do not receive desktop mutation credentials.

## Final Documentation Check

- M9 acceptance mapping remains in `docs/implementation-plans/milestone-9.md`.
- M9 non-goals remain documented in the milestone scope guard and excluded
  surface lists.
- No new user-facing transport selector, local-model fallback, ACP/A2A route,
  provider billing flow, or model-provider ID migration was added.
- `rg "API keys are required|API key required|Anthropic" docs apps/desktop/src`
  was reviewed. Remaining hits are historical plan/spec text, redaction coverage,
  adapter-readiness fixtures, or the provider-picker test proving `Anthropic`
  display names render as `Claude`; no M9-stale user-facing claim was found.
- `pnpm --filter @orca/desktop test OrchestratorModelPicker` exits 0:
  `Test Files 1 passed`; `Tests 3 passed`.
- No markdown lint command is configured beyond the root no-op `lint` script.
