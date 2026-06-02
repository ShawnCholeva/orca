# Antigravity Adapter Design

## Summary

Add Google's Antigravity to Orca with full parity to the existing Claude Code and Codex integrations. Antigravity becomes a first-class agent adapter, selectable in onboarding and sessions, usable by workflow steps, and available as a shadow-session orchestrator runtime.

The adapter id is `antigravity`. The default executable is `agy`, with `ORCA_ANTIGRAVITY_BIN` as the binary override. The implementation follows the existing Claude Code and Codex adapter boundaries rather than introducing a new provider architecture.

## Goals

- Add Antigravity to the agent catalog and onboarding flow.
- Support manual terminal sessions through the common pty session runtime.
- Support readiness checks, persisted readiness reports, and repair actions.
- Support workflow agent preferences, operator listing, and model compatibility checks.
- Support shadow-session orchestration for automated orchestrator turns.
- Preserve current Claude Code and Codex behavior.

## Non-Goals

- Do not add a direct Google API model provider for non-agent orchestration.
- Do not change the session runtime or context assembly behavior beyond the minimum needed to recognize Antigravity.
- Do not make Antigravity the default agent or change existing seeded user selections.

## Architecture

Antigravity is added as a first-class agent adapter beside `ClaudeCodeAdapter` and `CodexAdapter`.

Primary changes:

- Extend `AdapterId` to include `antigravity`.
- Add `AntigravityAdapter` under `apps/daemon/src/adapters/`.
- Register the adapter in `bootstrapRegistries()`.
- Seed `antigravity` in `seedAgents()` with Google/CLI metadata.
- Add Antigravity execution-mode defaults.
- Add Antigravity model catalog entries and an `orca/google` provider mapping for agent/model metadata.
- Add an `AntigravityShadowProvider` under `apps/daemon/src/orchestrator-llm/providers/`.
- Extend shadow-session manager dependency plumbing for an optional `antigravityBin` override.

The common session path remains unchanged: `createSession()` validates the adapter through the registry, and `SessionRuntime` starts the adapter through `resolveSpawn()`.

## Adapter Behavior

`AntigravityAdapter` implements `AgentAdapter`.

Expected adapter shape:

- `id`: `antigravity`
- `title`: `Antigravity`
- `supportedExecutionModes`: `["shadow_session", "one_shot"]`
- `contextDelivery`: preview-only, matching Claude Code and Codex
- `resolveSpawn()`: resolve `ORCA_ANTIGRAVITY_BIN` or `agy`, then spawn with no default args in the selected workspace
- `supportsModel()`: delegate to `adapterSupportsModel()`

Readiness:

- `checkInstalled()` resolves the binary and runs `agy --version`.
- `checkAuth()` uses the least-invasive documented or observed auth-status command if one exists.
- If Antigravity has no reliable noninteractive auth-status command, auth classification is based on a quick bounded probe and known unauthenticated output patterns.
- `needs_auth` is used only when CLI output clearly indicates sign-in is needed.
- `misconfigured` is used for unexpected output, timeouts, or unclear auth state.

Repair actions:

- Missing binary: install URL for Antigravity CLI docs.
- Needs auth: run command `agy` with label `Sign in to Antigravity`, unless a better documented sign-in command exists during implementation.
- Misconfigured/failed: retry the auth probe command used by `checkAuth()`.

## Models And Providers

Antigravity needs model compatibility so workflow steps can prefer it and `supportsModel()` can filter invalid choices.

The implementation will add `MODELS_BY_AGENT_ID.antigravity` using current Antigravity/Gemini model ids verified during implementation. Initial candidates from current documentation are Gemini 3.x Antigravity-accessible models such as flash and pro variants.

Add `orca/google` to `ModelProviderId` so Antigravity has the same provider metadata shape as Claude Code and Codex:

- `PROVIDER_BY_AGENT_ID.antigravity = "orca/google"`
- `getModelProviderDisplayName("orca/google") = "Google"`

This is metadata for the Antigravity agent adapter. It does not add a direct Google API provider to `ModelProviderRegistry`.

## Execution Modes

Execution-mode defaults match the current Claude Code and Codex policy:

- `shadow_session` is enabled and preferred.
- `one_shot` may be declared technically supported if `agy -p` is reliable.
- `one_shot` is disabled by default with a reason that Orca orchestration uses interactive shadow sessions for subscription-backed agent CLIs.

This preserves parity with Claude Code and Codex: shadow sessions are the production orchestration path, even when a CLI has a one-shot command.

## Shadow Orchestration

Add `AntigravityShadowProvider` implementing `ShadowProvider`.

Expected behavior:

- `launch()` returns `ORCA_ANTIGRAVITY_BIN`, injected `antigravityBin`, or `agy`.
- `hookConfig()` writes Antigravity hook configuration under `.agents/hooks.json` in the goal shadow directory.
- `captureMode()` uses hook capture. Antigravity's Stop hook receives JSON on stdin with `transcriptPath`, `terminationReason`, `error`, and idle state. The hook command posts enough data to Orca's `/v1/shadow-hooks/stop` endpoint for the daemon to resolve the last assistant turn.
- `turnParser()` extracts the same structured `orca:action` block used by Claude Code and Codex.
- `detectError()` recognizes common Antigravity auth, quota, and provider failure output.

The shared `ShadowSessionManager` stays provider-neutral. Antigravity-specific hook schema, prompt readiness patterns, modal dismissal, or pane parsing stays in `AntigravityShadowProvider` unless a shared abstraction is clearly needed.

## UI And User Flow

No bespoke frontend flow is required.

Antigravity appears wherever adapters are listed:

- onboarding agent selection
- readiness panel
- no-ready-agents banner
- new session dialog
- workflow/operator surfaces that list agent operators

Error text follows the existing adapter error helper pattern. If session start fails with `command_not_found`, the UI points users to `ORCA_ANTIGRAVITY_BIN`.

## Error Handling

The adapter follows existing readiness and session error conventions.

- Missing binary reports `missing`.
- Version command failure reports a failed installed step with sanitized output.
- Clear unauthenticated CLI output reports `needs_auth`.
- Unclear auth output reports `misconfigured`.
- Shadow startup timeout reports that Antigravity did not reach a ready input prompt.
- Shadow turn auth/quota failures reject the turn with provider-specific messages.
- Hook schema failures are isolated to the Antigravity shadow provider.

All subprocess output persisted in readiness reports is sanitized through the existing readiness sanitizer.

## Testing

Add or update focused tests matching the Claude Code and Codex coverage style:

- Contract tests: `AdapterId` accepts `antigravity`; model-provider schema accepts `orca/google` if added.
- Agent seed tests: Antigravity is seeded and metadata sync preserves connected state.
- Adapter tests: binary resolution, version parsing, auth classification, repair actions, and model support.
- Registry tests: bootstrap registers Antigravity.
- Execution-mode tests: Antigravity defaults are seeded and valid.
- Model catalog/operator tests: Antigravity models and capabilities are exposed.
- Shadow provider tests: registry resolution, launch override, hook config path/content, parser behavior, and error detection.
- Session tests: manual session creation/start uses the common adapter path.
- Optional real smoke tests gated by an env var, matching current Claude/Codex smoke-test style.

## Success Criteria

- A user can connect Antigravity during onboarding and see readiness status.
- A user can create and start an Antigravity terminal session in a workspace.
- Workflow agent preferences can select Antigravity with a supported model.
- The orchestrator can run on Antigravity via shadow sessions.
- Claude Code and Codex tests continue to pass.
- Antigravity integration tests cover the same functional surfaces as Claude Code and Codex.
