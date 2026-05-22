# Agent Readiness — Design Spec

**Date:** 2026-05-22
**Status:** Draft (pending implementation)
**Owner:** Shawn Choleva

## Problem

Onboarding's "Connect your agents" step currently treats selection as the end-state: toggling an agent flips a `connected` boolean in SQLite. Step 2 of onboarding ("Preparing your workspace") is a fake 800 ms delay. The user is dropped into the main app without any proof the selected agents are actually installed, authenticated, or usable. The first session attempt is where breakage shows up — long after onboarding, with no repair affordance in context.

We need an explicit readiness pipeline that runs *during* onboarding so the user leaves with a verified set of agents — or with clear, actionable repair steps for the ones that need attention.

## Goals

- After onboarding, every selected agent has a persisted readiness status backed by real checks (install + auth).
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
| Check depth | `--version` (install) + provider-specific auth status command |
| Failure UX | Inline copyable repair command + Retry; block app entry until ≥1 agent ready OR user clicks "Continue anyway" |
| Repair execution | User runs commands in their own terminal; Orca never executes them |
| Persistence | Extend existing `agents` table with `readiness_*` columns |
| Capabilities | Out of scope |
| Gemini adapter | In scope — create `GeminiAdapter` alongside the readiness work |

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
- `apps/daemon/src/readiness/exec.ts` — `runCheckCommand()` wrapper around `execFile` with timeout/truncation.
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
export interface CheckStep {
  name: "installed" | "authenticated";
  ok: boolean;
  command: string;          // argv joined for display, e.g. "claude auth status"
  exitCode?: number;
  detail?: string;          // short, human-readable summary
  errorOutput?: string;     // stderr, truncated to 4 KB, secrets redacted
}

export interface RepairAction {
  kind: "run_command" | "install_url";
  command?: string;         // copyable shell command (run_command)
  url?: string;             // install link (install_url)
  label: string;            // button text, e.g. "Sign in to Claude Code"
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
ALTER TABLE agents ADD COLUMN readiness_status     TEXT;
ALTER TABLE agents ADD COLUMN readiness_checked_at TEXT;
ALTER TABLE agents ADD COLUMN readiness_detail     TEXT;  -- JSON: CheckStep[]
ALTER TABLE agents ADD COLUMN readiness_repair     TEXT;  -- JSON: RepairAction | null
ALTER TABLE agents ADD COLUMN readiness_version    TEXT;
```

All columns are nullable; existing rows survive the migration with `readiness_status = NULL`. The contract surfaces this as `readiness: null`, which the UI treats as `unchecked`.

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
  checkAuth(): Promise<CheckStep>;
  repairFor(status: AgentReadinessStatus): RepairAction | undefined;
}
```

Each adapter encapsulates its own argv. The service never inspects strings — it only reads `ok` and `detail` from steps.

### Per-agent commands

| Agent | install | auth | repair (needs_auth) | repair (missing) |
|---|---|---|---|---|
| claude-code | `claude --version` | `claude auth status` (exit 0 = ok, exit 1 = needs_auth) | `claude auth login` | install URL |
| codex | `codex --version` | `codex login status` (exit 0 = ok) | `codex login` | install URL |
| gemini-cli | `gemini --version` | heuristic: env `GEMINI_API_KEY` OR `GOOGLE_CLOUD_PROJECT` OR `~/.gemini/settings.json` exists | `gemini` (launches login) | install URL |
| opencode | `opencode --version` | `opencode auth list`; parse stdout — ≥1 provider = ok, empty = needs_auth | `opencode auth login` | install URL |

Install URLs live in `repair-links.ts` so updates are auditable and tested.

### Classification table (per adapter `checkAuth`)

| Adapter | exit 0 | exit non-zero | stderr matches `/not authenticated|not logged in|please log in|sign in/i` | other |
|---|---|---|---|---|
| claude-code | `ok: true` | `ok: false, detail: "needs_auth"` | n/a | `ok: false, detail: "misconfigured"` |
| codex | `ok: true` | `ok: false, detail: "needs_auth"` | n/a | same |
| gemini-cli | heuristic ok → `ok: true` | n/a (no command) | n/a | `ok: false, detail: "needs_auth"` |
| opencode | stdout has ≥1 provider → `ok: true` | `ok: false, detail: "misconfigured"` | parse failure → `needs_auth` | same |

## ReadinessService

```ts
export class ReadinessService {
  constructor(
    private readonly db: Database.Database,
    private readonly registry: AdapterRegistry,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async checkAgent(agentId: string): Promise<AgentReadinessReport> {
    // dedup in-flight calls
    // run checkInstalled; if !ok → status = missing
    // else run checkAuth; classify auth.detail → ready | needs_auth | misconfigured
    // persistReadiness(); return report
  }

  async checkSelected(): Promise<AgentReadinessReport[]> {
    // listAgents(db).filter(connected)
    // Promise.allSettled(map checkAgent)
    // failed promises → failedReport(id, reason)
  }
}
```

### Concurrency rules

- `checkSelected` runs agent checks in parallel via `Promise.allSettled`.
- Within a single agent, `checkInstalled` runs before `checkAuth`. If install fails, auth is skipped.
- `ReadinessService` keeps `Map<agentId, Promise<AgentReadinessReport>>` for in-flight dedup. Cleared on settle.

### Timeouts and budgets

- Per-command timeout: 5 s (hard, via `execFile` `timeout` option).
- Per-agent total budget: 12 s. If exceeded, the agent's report becomes `status: failed` with a generic Retry action.
- Whole-pipeline timeout: none. The UI can be cancelled by navigating away.

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
- Request bodies for both POSTs are empty objects; Zod rejects extra fields.

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
- All checks settled and zero `ready` → `Continue` hidden, `Continue anyway` shown as secondary. Calling `onComplete` proceeds with no ready agents and the main app surfaces a persistent banner.
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
| `ENOENT` from `execFile` | `checkInstalled` returns `ok: false`. Status → `missing`. |
| Per-command timeout (5 s) | Step `ok: false`, `detail: "timeout after 5s"`. |
| Per-agent budget exceeded (12 s) | Report `status: failed`, generic Retry action. |
| Unhandled throw in adapter | Caught by `Promise.allSettled`; `failedReport(id, reason)` with truncated reason. |
| Migration failure on startup | Daemon exits via existing migration runner's error path. |
| Stale persisted report | Next check overwrites unconditionally. |

### Output sanitization

- stderr/stdout truncated to 4 KB before persisting to `readiness_detail`.
- Defense-in-depth secret redaction before persistence: regex `/sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{32,}@/` replaced with `<redacted>`. Auth status commands are chosen because they don't print secrets, but the redaction guards against future CLI changes.
- Repair commands are static strings owned by adapter classes. No interpolation from user input.

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

### Real smoke tests (gated)

- `*.real-smoke.test.ts` for each adapter, gated on `ORCA_RUN_REAL_SMOKE=1`. Spawns the actual CLI's `--version`. Mirrors existing `claude-code.smoke.test.ts` convention. CI skips by default.

## Risks & open questions

- **Auth command convention drift.** Codex/Claude can change exit-code semantics between releases. Mitigation: classification table is per-adapter and easy to revise; real-smoke tests catch breakage when run.
- **Gemini auth is heuristic-only.** Without a smoke prompt we can't actually prove Gemini works. We accept false-positive `ready` for Gemini until a smoke check is added in a follow-up.
- **Continue anyway escape hatch.** Could be over-used. Tracked via telemetry event `readiness.continue_anyway` so we can measure adoption and decide whether to tighten the gate later.
- **PATH differences inside Tauri.** If the desktop app runs with a stripped PATH, `claude` may not resolve even when it's on the user's shell PATH. Existing `resolveBinary` already accepts `ORCA_*_BIN` overrides — readiness UX surfaces this as `missing` with the install link; we may later add a "set custom binary path" affordance.
