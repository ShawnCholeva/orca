# Agent Readiness — Design Spec

**Date:** 2026-05-22
**Status:** Draft (pending implementation)
**Owner:** Shawn Choleva

## Problem

Onboarding's "Connect your agents" step currently treats selection as the end-state: toggling an agent flips a `connected` boolean in SQLite. Step 2 of onboarding ("Preparing your workspace") is a fake 800 ms delay. The user is dropped into the main app without any proof the selected agents are actually installed, authenticated, or usable. The first session attempt is where breakage shows up — long after onboarding, with no repair affordance in context.

We need an explicit readiness pipeline that runs *during* onboarding so the user leaves with agents that are **installed and authenticated/configured** — or with clear, actionable repair steps for the ones that need attention. "Ready" in this milestone means "we have local evidence the agent is installed and its credentials look usable." It does **not** mean we have proven the agent can complete a model call; smoke prompts are deferred to a follow-up.

## Goals

- After onboarding, every selected agent has a persisted readiness status backed by real checks (install + auth/config).
- Failure surfaces with a copyable command or install link; the user can resolve and retry without leaving onboarding.
- The app does not load behind the user with zero ready agents unless the user has explicitly opted into that state ("Continue anyway").
- Implementation is small enough to ship in a single milestone and does not couple to future capability/routing work.

## Non-goals

- Smoke prompts that call the model ("Reply with: ORCA_READY"). Skipped to avoid API spend and complexity for MVP.
- Recheck-on-startup, drift detection, time-based revalidation. Out of scope; checks run during onboarding and on user-triggered Retry only.
- Capability registry (chat / codeEditing / terminalControl / etc.). Deferred until orchestrator routing needs it.
- Running CLI auth flows inside Orca's PTY or launching the user's terminal. Repair is "copy this command, run it yourself, click Retry."
- Network probes, quota checks, model-specific verification.

## Scope summary

| Decision | Value |
|---|---|
| When checks run | Onboarding step 2 + user-triggered Retry only |
| Check depth | `--version` (install) + provider-specific typed auth probe (no model call) |
| `ready` means | "installed and authenticated/configured" — never "smoke-tested model call" |
| Failure UX | Inline copyable repair command + Retry; block app entry until ≥1 agent ready OR user clicks "Continue anyway" |
| Repair execution | User runs commands in their own terminal; Orca never executes them |
| Persistence | Extend existing `agents` table with `readiness_*` columns (CHECK constraint on status) |
| Capabilities | Out of scope |
| Gemini adapter | In scope — mode-specific (API key / Vertex API key / Vertex ADC / OAuth); configuration-detected only |

## Architecture

```
OnboardingView (step 2)
  └─ POST /v1/agents/readiness:check
       └─ ReadinessService (daemon)
            └─ for each selected agentId
                 ├─ AgentAdapter.checkInstalled() → CheckStep
                 └─ AgentAdapter.checkAuth()      → CheckStep
            └─ classify → AgentReadinessReport { status, steps, repair }
            └─ persist on agents row
       └─ HTTP { reports: AgentReadinessReport[] }
  └─ OnboardingView renders ReadinessRow per agent
       └─ per-row Retry → POST /v1/agents/:id/readiness:check
       └─ Continue (requires ≥1 ready) | Continue anyway (zero ready)
```

### New / modified files

**Daemon:**
- `apps/daemon/src/adapters/gemini.ts` — new `GeminiAdapter`.
- `apps/daemon/src/readiness/types.ts` — `CheckStep`, `RepairAction`, `AgentReadinessReport`, status enum.
- `apps/daemon/src/readiness/service.ts` — `ReadinessService` class.
- `apps/daemon/src/readiness/exec.ts` — `runCheckCommand()` wrapper around `execFile` (fixed exec policy; see below).
- `apps/daemon/src/readiness/sanitize.ts` — output sanitizer (redaction set + ANSI strip + truncate).
- `apps/daemon/src/readiness/sanitize.test.ts` — per-pattern positive/negative tests for every redaction rule.
- `apps/daemon/src/readiness/repair-links.ts` — centralized install URLs.
- `apps/daemon/src/readiness/service.test.ts` — service unit tests.
- `apps/daemon/src/adapters/{claude-code,codex,opencode,gemini}.ts` — implement `checkInstalled`, `checkAuth`, `repairFor`; add `*.readiness.test.ts` next to each.
- `apps/daemon/src/adapters/types.ts` — extend `AgentAdapter` interface.
- `apps/daemon/src/agents.ts` — add columns to row mapping; add `persistReadiness()` helper.
- `apps/daemon/src/server.ts` — two new routes; extend `GET /v1/agents` payload.
- `apps/daemon/migrations/0009_agent_readiness.sql` — new columns.

**Contracts:**
- `packages/contracts/src/index.ts` — `AgentReadinessStatus` enum, `CheckStep`, `RepairAction`, `AgentReadinessReport`, request/response schemas; extend `Agent` schema with optional `readiness` field.

**Desktop:**
- `apps/desktop/src/onboarding/OnboardingView.tsx` — step 2 calls real check.
- `apps/desktop/src/onboarding/ReadinessPanel.tsx` — new; owns check lifecycle.
- `apps/desktop/src/onboarding/ReadinessRow.tsx` — new; per-agent row.
- `apps/desktop/src/onboarding/RepairBlock.tsx` — new; renders copyable command or install link.
- `apps/desktop/src/api.ts` — `runReadinessCheck()`, `runReadinessCheckForAgent(id)`.
- `apps/desktop/src/shell/NoReadyAgentsBanner.tsx` — new; persistent banner shown in main app when 0 connected agents are `ready` (driven by `GET /v1/agents` payload).
- `apps/desktop/src/shell/AppShell.tsx` (or equivalent main-shell container) — mounts the banner.
- `apps/desktop/src/shell/NoReadyAgentsBanner.test.tsx` — banner visibility + dismissal tests.

## Data model

### Status enum

```ts
export type AgentReadinessStatus =
  | "unchecked"      // never checked (default)
  | "checking"       // in-flight; not persisted, only used in UI state
  | "ready"          // install ok + auth ok
  | "missing"        // binary not found on PATH and not at override
  | "needs_auth"     // installed but not logged in
  | "misconfigured"  // installed; auth command failed for non-auth reasons
  | "failed";        // unexpected error or budget exceeded
```

### Check step + repair + report

```ts
// Adapter-level typed result of an auth probe. This is the contract between
// adapters and the service. `detail` is display-only and never used for
// classification.
export type AuthStatus = "ready" | "needs_auth" | "misconfigured";

export interface CheckStep {
  name: "installed" | "authenticated";
  ok: boolean;
  authStatus?: AuthStatus;  // present on `authenticated` steps only
  command: string;          // argv joined for display, e.g. "claude auth status --json"
  exitCode?: number;
  detail?: string;          // short, human-readable summary (display-only)
  errorOutput?: string;     // sanitized stderr summary, truncated to 4 KB; never raw stdout from a successful auth check
}

export interface RepairAction {
  kind: "run_command" | "install_url";
  command?: string;         // copyable shell command (run_command)
  url?: string;             // install link (install_url)
  label: string;            // button text, e.g. "Sign in to Claude Code"
  requiresAppRestart?: boolean; // true for env-var-only auth fixes (see Risks)
}

export interface AgentReadinessReport {
  agentId: string;
  status: AgentReadinessStatus;
  steps: CheckStep[];
  repair?: RepairAction;
  checkedAt: string;        // ISO timestamp
  version?: string;
}
```

### Migration `0009_agent_readiness.sql`

```sql
ALTER TABLE agents ADD COLUMN readiness_status     TEXT
  CHECK (readiness_status IS NULL OR readiness_status IN (
    'unchecked','ready','missing','needs_auth','misconfigured','failed'
  ));
ALTER TABLE agents ADD COLUMN readiness_checked_at TEXT;
ALTER TABLE agents ADD COLUMN readiness_detail     TEXT;  -- JSON: CheckStep[]
ALTER TABLE agents ADD COLUMN readiness_repair     TEXT;  -- JSON: RepairAction | null
ALTER TABLE agents ADD COLUMN readiness_version    TEXT;
```

`checking` is intentionally **not** in the CHECK list — it is a UI-only transient and is never persisted. All columns are nullable; existing rows survive the migration with `readiness_status = NULL`. The contract surfaces this as `readiness: null`, which the UI treats as `unchecked`.

## Adapter contract

```ts
export interface AgentAdapter {
  // existing
  id: AdapterId;
  title: string;
  contextDelivery: AdapterContextDelivery;
  resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult>;
  probeAvailability(): Promise<AdapterAvailability>;

  // new
  checkInstalled(): Promise<CheckStep & { version?: string }>;
  checkAuth(): Promise<CheckStep>;       // CheckStep.authStatus is the contract
  repairFor(status: AgentReadinessStatus): RepairAction | undefined;
}
```

Each adapter encapsulates its own argv **and** its own classification logic. The service only reads `CheckStep.ok` and `CheckStep.authStatus` (a typed enum). `CheckStep.detail` is display-only and is **never** parsed by the service.

### Per-agent commands

| Agent | install | auth probe | repair (needs_auth) | repair (missing) |
|---|---|---|---|---|
| claude-code | `claude --version` | `claude auth status --json`; parse JSON; `loggedIn === true` → `ready` | `claude auth login` | install URL |
| codex | `codex --version` | `codex login status`; exit 0 → `ready` | `codex login` | install URL |
| gemini-cli | `gemini --version` | **mode-specific** (see below) | `gemini` (launches login) | install URL |
| opencode | `opencode --version` | `opencode auth list`; ANSI-stripped parse for explicit credential count | `opencode auth login` | install URL |

Install URLs live in `repair-links.ts` so updates are auditable and tested.

### Gemini classification (replaces prior heuristic)

Gemini CLI supports three auth modes; the adapter probes them in priority order and emits the first match:

1. **Gemini API key** — `process.env.GEMINI_API_KEY` non-empty → `ready` (auth method: `gemini_api_key`).
2. **Vertex AI API key** — `process.env.GOOGLE_API_KEY` non-empty AND Gemini config explicitly selects Vertex (read `~/.gemini/settings.json` `selectedAuthType === "vertex-ai"`) → `ready` (auth method: `vertex_api_key`).
3. **Vertex AI ADC / service account** — `process.env.GOOGLE_CLOUD_PROJECT || GOOGLE_CLOUD_PROJECT_ID` AND `GOOGLE_CLOUD_LOCATION` AND (`GOOGLE_APPLICATION_CREDENTIALS` file exists OR `~/.config/gcloud/application_default_credentials.json` exists) → `ready` (auth method: `vertex_adc`).
4. **OAuth (Google login)** — `~/.gemini/settings.json` exists, `selectedAuthType === "oauth-personal"`, AND the OAuth credential cache file referenced by the CLI is present → `ready` (auth method: `oauth`).
5. Otherwise → `needs_auth`.

`detail` notes which mode was matched. When `ready`, Gemini's row body explicitly reads "**configuration detected; not smoke-tested**" so the user is not misled about the depth of verification.

### Classification rules (per adapter `checkAuth`)

Each adapter returns `CheckStep.authStatus` directly. The service does not pattern-match strings.

| Adapter | `authStatus: ready` | `authStatus: needs_auth` | `authStatus: misconfigured` |
|---|---|---|---|
| claude-code | `--json` parsed, `loggedIn === true` | exit 1 + parsed JSON or stderr indicating "not logged in" | any other exit code, JSON parse failure, timeout, missing field |
| codex | exit 0 | exit non-zero AND (stdout/stderr matches `/not (logged in\|authenticated)/i` OR documented login-required pattern) | exit non-zero without that pattern (keychain, parse error, backend error) |
| gemini-cli | any of the 5 modes above resolves cleanly | none of the 5 modes match | any mode partially matches but a referenced credential file fails to stat / parse |
| opencode | ANSI-stripped stdout parses to ≥1 explicit `provider:` line | parser succeeds and count is 0 | exit non-zero, parser fails, or output unrecognized |

OpenCode env-only credentials (`ANTHROPIC_API_KEY` etc. set in the user's shell or project `.env` but not stored via `opencode auth login`) are **not** counted as `ready` in this milestone. Rationale: the Orca daemon may not inherit those env vars, so "ready" would be a lie at session-spawn time. This is called out in Risks as a known limitation.

## ReadinessService

```ts
export class ReadinessService {
  constructor(
    private readonly db: Database.Database,
    private readonly registry: AdapterRegistry,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async checkAgent(agentId: string): Promise<AgentReadinessReport> {
    // 1. Dedup in-flight calls via Map<agentId, Promise<Report>>.
    // 2. Run checkInstalled; if !ok → status = missing, skip auth.
    // 3. Otherwise run checkAuth; map auth.authStatus → status
    //    ("ready" | "needs_auth" | "misconfigured").
    // 4. Call adapter.repairFor(status) for the repair action.
    // 5. persistReadiness() is called for EVERY terminal status, including
    //    "failed" reports (see Error handling).
    // 6. Return report.
  }

  async checkSelected(): Promise<AgentReadinessReport[]> {
    // listAgents(db).filter(connected)
    // Promise.allSettled(map checkAgent)
    // Rejected promises → failedReport(id, reason); these are also persisted
    // via persistReadiness() before being returned, so GET /v1/agents never
    // shows a stale report after a check completes.
  }
}
```

### Concurrency rules

- `checkSelected` runs agent checks in parallel via `Promise.allSettled`.
- Within a single agent, `checkInstalled` runs before `checkAuth`. If install fails, auth is skipped.
- `ReadinessService` keeps `Map<agentId, Promise<AgentReadinessReport>>` for in-flight dedup. Cleared on settle.

### Timeouts and budgets

- Per-command timeout: 5 s (hard, via `execFile` `timeout` option).
- Per-agent total budget: 12 s. If exceeded, the agent's report becomes `status: failed` with a generic Retry action and is persisted.
- Whole-pipeline timeout: none. The UI can be cancelled by navigating away.

### `runCheckCommand` (`readiness/exec.ts`) execution policy

All adapter probes go through one helper. Policy is fixed, not adapter-tunable:

| Setting | Value |
|---|---|
| Invocation | `child_process.execFile` (never `spawn` with `shell: true`) |
| `stdio` | stdin closed (`'ignore'`); stdout/stderr piped |
| `cwd` | OS temp dir (`os.tmpdir()`); never the user's project or HOME |
| `env` | `PATH` only by default; explicit allowlist for Gemini/Vertex env vars when classifying Gemini auth (read directly from `process.env`, not forwarded into the subprocess) |
| `timeout` | 5000 ms |
| `maxBuffer` | 256 KB per stream; on overflow the child is killed and step is `failed` |
| `killSignal` | `SIGTERM`; if the process is still alive 1 s later we send `SIGKILL` |
| `windowsHide` | `true` |
| `shell` | `false` (always) |

**OpenCode special-case:** `runCheckCommand` for opencode passes `OPENCODE_DISABLE_PLUGINS=1` (or equivalent — adapter constant) and uses `--pure` if/when that flag exists, to avoid loading user plugins or running default startup hooks during a readiness probe.

### Persistence helper

```ts
function persistReadiness(db, report) {
  db.prepare(`
    UPDATE agents
       SET readiness_status     = ?,
           readiness_checked_at = ?,
           readiness_detail     = ?,
           readiness_repair     = ?,
           readiness_version    = ?,
           updated_at           = ?
     WHERE id = ?
  `).run(
    report.status,
    report.checkedAt,
    JSON.stringify(report.steps),
    report.repair ? JSON.stringify(report.repair) : null,
    report.version ?? null,
    report.checkedAt,
    report.agentId,
  );
}
```

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/agents/readiness:check` | Run checks for every `connected` agent; returns `{ reports }` |
| POST | `/v1/agents/:id/readiness:check` | Run checks for one agent (Retry); returns `{ report }` |
| GET | `/v1/agents` | Existing; extended to include `readiness: AgentReadinessReport \| null` per agent |

Validation rules:
- `POST /v1/agents/:id/readiness:check` returns 404 for unknown ids and 400 if the agent exists but is not `connected`.
- Request bodies for both POSTs are optional. Zod accepts `undefined` or `{}` (empty object); a non-empty body is rejected with 400. This avoids Fastify/Zod plumbing tripping on no-body POSTs from `fetch(url, { method: "POST" })`.

## Onboarding UX

Step 2 ("Setting up") replaces the fake delay with a live `ReadinessPanel`.

```
Setting up agents

🟠 Claude Code
   ✓ Installed (1.2.3)
   ✓ Authenticated
   Ready

🟢 Codex CLI
   ✓ Installed (0.9.0)
   ⚠ Not signed in
   Run: codex login   [Copy]  [Retry]

🔵 Gemini CLI
   ✗ Not installed
   Install Gemini CLI →   [Install] [Retry]

🟣 OpenCode
   ✓ Installed (0.4.1)
   ✓ Authenticated (anthropic, openai)
   Ready
```

### Row states

| Status | Icon | Body |
|---|---|---|
| checking | spinner | "Checking…" |
| ready | ✓ green | version + "Ready" |
| missing | ✗ red | "Not installed" + Install link |
| needs_auth | ⚠ amber | "Not signed in" + copyable login command |
| misconfigured | ⚠ amber | detail from check step + Retry |
| failed | ✗ red | "Check failed: <truncated reason>" + Retry |

### Continue rules

- ≥1 agent `ready` → `Continue` enabled.
- All checks settled and zero `ready` → `Continue` hidden, `Continue anyway` shown as secondary. Calling `onComplete` proceeds with no ready agents and the main app shell mounts `NoReadyAgentsBanner` (see Desktop file list). The banner reads `GET /v1/agents` on mount and stays visible until ≥1 connected agent has `readiness.status === "ready"`.
- During checks → both disabled; footer reads `Checking N agents…`.

### Retry behavior

- Per-row Retry → `POST /v1/agents/:id/readiness:check`. Only that row enters `checking`.
- Top-level "Recheck all" → `POST /v1/agents/readiness:check`. All connected rows re-enter `checking`.
- Cache: if all reports are <60 s old when step 2 mounts, reuse them and show "Last checked: just now" + Recheck button. Prevents `--version` spam on Back/Forward.

### Repair display rules

- Copyable commands always come from `report.repair.command` — the UI never assembles shell strings. Prevents drift between adapter logic and what the user sees.
- Install links open via `tauri-plugin-opener`. URLs live in `readiness/repair-links.ts`.

### Accessibility

- Each row: `role="status"` + `aria-live="polite"` so status transitions are announced.
- Repair commands in `<code>` with `aria-label="Sign-in command for <agent name>"`.

## Error handling

### Failure surfaces

| Surface | Behavior |
|---|---|
| `ENOENT` from `execFile` | `checkInstalled` returns `ok: false`. Status → `missing`. Persisted. |
| Per-command timeout (5 s) | Step `ok: false`, `detail: "timeout after 5s"`. |
| `maxBuffer` exceeded | Child killed; step `ok: false`, `detail: "output truncated"`. |
| Per-agent budget exceeded (12 s) | Report `status: failed`, generic Retry action. Persisted. |
| Unhandled throw in adapter | Caught by `Promise.allSettled`; `failedReport(id, reason)` built with sanitized truncated reason. **Persisted via `persistReadiness()` before being returned**, so `GET /v1/agents` never shows a stale prior report after a completed-but-failed check. |
| Migration failure on startup | Daemon exits via existing migration runner's error path. |
| Stale persisted report | Next check overwrites unconditionally. |

### Output sanitization & PII

**Rule 1 — Never persist raw stdout from a successful auth check.** `claude auth status --json` and Gemini's settings files contain account-identifying data (email, org id, project id). On success, `errorOutput` is omitted entirely and `detail` carries only normalized facts: `"authenticated (gemini_api_key)"`, `"authenticated"`, or `"authenticated (anthropic, openai)"` for OpenCode (provider names only, no per-account info).

**Rule 2 — Sanitize stderr/output on failure** before persisting to `readiness_detail`:
- Truncate to 4 KB.
- Strip ANSI escapes.
- Run the redaction set below before the truncation.

**Redaction set** (applied in order; each match replaced with `<redacted>`):
- `sk-[A-Za-z0-9_\-]{16,}` (Anthropic & generic)
- `sk-ant-[A-Za-z0-9_\-]{16,}`
- `ghp_[A-Za-z0-9]{20,}`, `gho_[A-Za-z0-9]{20,}`, `ghs_[A-Za-z0-9]{20,}` (GitHub)
- `ya29\.[A-Za-z0-9_\-]+` (Google OAuth tokens)
- `AIza[A-Za-z0-9_\-]{20,}` (Google API keys)
- `Bearer\s+[A-Za-z0-9_\-\.]+` (any bearer token)
- `-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----`
- URL query/fragment auth params: `(\?|&|#)(?:access_token|id_token|api_key|token|key|password)=[^\s&#]+`
- Email addresses: `[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`
- Generic high-entropy 32+ char tokens: `\b[A-Za-z0-9_\-]{32,}\b` (last to avoid swallowing earlier matches)

The redactor lives in `readiness/sanitize.ts`, has unit tests for every pattern above (positive + negative), and is the **only** sanitizer called from `runCheckCommand`.

**Rule 3 — Repair commands** are static strings owned by adapter classes. No interpolation from user input.

## Testing

### Adapter tests (`*.readiness.test.ts` next to each adapter)

- `checkInstalled` paths: ok (exit 0 + version parsed), missing (`ENOENT`), timeout (mock long-running command).
- `checkAuth`: every branch of the classification table.
- `repairFor`: returns the expected `RepairAction` for each non-ready status.
- `execFile` is mocked via injectable `runFn` (same pattern as existing `resolveFn`). Tests verify the exact argv passed.

### Service tests (`readiness/service.test.ts`)

- `checkAgent(id)` happy path → persists, returns `ready`.
- `checkAgent(id)` install fails → skips auth, status `missing`, repair set.
- `checkAgent(id)` auth fails → status `needs_auth`, command in repair.
- `checkSelected()` mix of pass/fail → all reports returned; parallel execution verified via mock timing.
- Unknown agent → throws `UnknownAgentError`.
- Concurrent same-id calls → both receive same promise (dedup).
- 12 s budget exceeded → report `failed`.

### HTTP tests (extend `server.test.ts`)

- `POST /v1/agents/readiness:check` returns `reports[]` for connected agents only.
- `POST /v1/agents/:id/readiness:check` 404 on unknown, 400 on not-selected.
- `GET /v1/agents` includes `readiness` field after a check.

### Migration tests (extend `migrations.test.ts`)

- Apply `0009_agent_readiness`; verify columns exist and are nullable.
- Round-trip: persist a report, read back, JSON columns parse cleanly.

### Onboarding tests

- `OnboardingView.test.tsx`: step 2 mounts the readiness panel and no longer uses the 800 ms delay.
- New `ReadinessPanel.test.tsx`:
  - Renders one row per selected agent with correct icon/text per status.
  - Per-row Retry fires the single-agent endpoint; only that row re-enters `checking`.
  - `Continue` disabled until ≥1 `ready`; `Continue anyway` appears only when 0 ready and all checks settled.
  - Copy button copies exact `report.repair.command`.
  - Cached <60 s reports → "Last checked" shown, no auto-recheck.
  - Gemini `ready` row body includes the qualifier "configuration detected; not smoke-tested".
  - `RepairAction.requiresAppRestart === true` shows "Restart Orca after running this" copy and disables Retry with a tooltip.

### Main-shell tests

- `NoReadyAgentsBanner.test.tsx`: visible when `GET /v1/agents` returns 0 connected agents with `readiness.status === "ready"`; hidden when ≥1 is ready; dismissable but re-appears on next app launch while the condition holds.

### Real smoke tests (gated)

- `*.real-smoke.test.ts` for each adapter, gated on `ORCA_RUN_REAL_SMOKE=1`. Spawns the actual CLI's `--version`. Mirrors existing `claude-code.smoke.test.ts` convention. CI skips by default.
- **Auth-status smoke tests** (also gated): run each adapter's real auth probe (`claude auth status --json`, `codex login status`, `opencode auth list`) — no login required. Assertions:
  - Process exits within the 5 s timeout.
  - Output is non-crashing (no segfault / Node uncaught exception text).
  - The adapter classifies the result into one of the three `AuthStatus` values without throwing.
  - Sanitizer reduces any returned output to ≤4 KB and contains no patterns from the redaction set.
  These tests catch CLI vendor drift (exit-code changes, `--json` schema changes) that the unit tests' mocks would miss.

## Risks & open questions

- **Auth command convention drift.** Codex/Claude can change exit-code or JSON schema semantics between releases. Mitigation: per-adapter classification owned by the adapter class; gated auth-status smoke tests catch drift when run.
- **Gemini is configuration-detected, not smoke-tested.** Even with mode-specific checks (API key / Vertex API key / Vertex ADC / OAuth), we can still mark Gemini `ready` when credentials are present-but-invalid. Gemini rows explicitly carry the qualifier "configuration detected; not smoke-tested" so the UX never overstates verification depth. A real model-call smoke is the planned follow-up.
- **Env-var-only auth and daemon PATH/env.** A user can repair Gemini or OpenCode by exporting `GEMINI_API_KEY` / provider keys in their shell, but the **already-running Orca daemon** will not pick those up. Two consequences:
  1. `RepairAction.requiresAppRestart = true` for env-based fixes; the UI tells the user "Restart Orca after running this" and Retry is grayed with a tooltip until restart.
  2. OpenCode env-only credentials (provider keys not stored via `opencode auth login`) are explicitly **not** counted as `ready` in this milestone. They will be reported as `needs_auth` with a repair pointing at `opencode auth login`.
- **Continue anyway escape hatch.** Could be over-used. Tracked via telemetry event `readiness.continue_anyway` so we can measure adoption and decide whether to tighten the gate later.
- **PATH differences inside Tauri.** If the desktop app runs with a stripped PATH, `claude` may not resolve even when it's on the user's shell PATH. Existing `resolveBinary` already accepts `ORCA_*_BIN` overrides — readiness UX surfaces this as `missing` with the install link; we may later add a "set custom binary path" affordance.
- **`failed` persistence semantics.** `failed` reports (timeout, unhandled throw, budget exceeded) are persisted just like other statuses, so `GET /v1/agents` is always consistent with the most recent attempt. The trade-off: a transient failure (network blip during a CLI's auth probe) overwrites a previously-`ready` state. Users recover via Retry. We do not keep history.
