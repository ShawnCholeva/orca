# Inspectable Axis — Design Spec (Phase 4)

**Status:** approved (brainstorm), pending implementation plan.
**Supersedes** §4.4 of `2026-06-23-harness-axes-design.md` for implementation — specifically its "capture worker tokens **via hooks**" assumption, which grounded research proved false (see §2). Everything else in §4.4 still holds.
**Builds on:** the merged `HarnessTransition` spine + `EvidenceFacet` (Executable, Phase 1–2) and `RiskFacet` (Governed, Phase 3). Both `evidence` and `risk` facets are tight; `telemetry` and `stateDeps` are still loose `z.record` — this plan tightens `telemetry`.

## 1. Goal

Make the harness **Inspectable**: every `HarnessTransition` carries a strict `TelemetryFacet` (cost, latency, model, outcome, interventions, rejected alternatives); worker-agent token+cost is captured; outcomes are categorical (clusterable); and a `/harness-metrics` projection + control-plane replay + failure attribution turn the append-only transition log into an auditable, queryable record. Scope: **full P1–P3** in one plan.

## 2. Grounded research (decisive — do not re-litigate)

- **No worker hook payload carries token usage.** Verified against Orca's `agent-hooks/routes.ts` AND the official Claude Code + Codex hook docs: every hook event (incl. turn-complete `Stop`, `SubagentStop`, `SessionEnd`) hands over only `transcript_path`, never `usage`/`tokens`/`cost`. The spec's "via hooks" mechanism is dead for all providers.
- **The existing `workflow_llm_calls` token capture does NOT generalize to workers.** It works only because Orca itself makes the orchestrator API call and holds the SDK `usage` object (`llm/anthropic.ts:170`, `llm/openai.ts:157`). Workers are external CLI processes in tmux PTYs — Orca never holds their response objects.
- **OTEL is the sanctioned non-parsing channel (chosen mechanism):**
  - **Claude Code:** `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*` exporters emit metrics `claude_code.token.usage` and `claude_code.cost.usage` (+ span token attributes), keyed by `session.id` (`OTEL_METRICS_INCLUDE_SESSION_ID`, default on). Source: code.claude.com/docs/en/monitoring-usage.
  - **Codex:** `[otel]` in `config.toml` with `exporter="otlp-http"` emits token counts on the `codex.sse_event` **log** record at `response.completed`. Works for interactive `codex` and `codex exec` (logs); **NOT** `codex mcp-server` (no OTEL). Source: developers.openai.com/codex/config-advanced.
  - **Antigravity:** no usage channel known → `cost = null` (graceful-degrade).
- Transcript parsing (Claude per-message `usage`; Codex `token_count` events) was rejected: conflicts with CLAUDE.md's "prefer hooks over parsing shadow sessions," and Codex's transcript format is officially "not a stable interface."

## 3. Locked decisions

- **D1 — Scope:** full P1–P3 Inspectable in one plan.
- **D2 — Graceful-degrade:** build the complete metric/attribution surface now; any metric whose source facet is absent (e.g. `StateDepsFacet`, Stateful/Phase 5 not built) reports `null` + a `reason` string, never `0`. Forward-compatible: when a facet later ships, its metric lights up with no Inspectable rewrite.
- **D3 — Worker tokens via OTEL** (not hooks, not transcript). Daemon owns the receiver; workers push.
- **D4 — Cost:** static `model → {usd_per_1k_in, usd_per_1k_out}` price map in code (resolved decision §7 of the axes spec). `TelemetryFacet.cost` is **nullable** (null = no usage source).
- **D5 — Replay is the scoped control-plane slice**, NOT full event-sourcing of all Orca state (explicit non-goal). Read-only reconstruction of the transition trajectory for a goal.

## 4. Design

### 4.1 `TelemetryFacet` (P1)
Tighten `HarnessTransition.telemetry` from `z.record(z.unknown()).nullable()` to `TelemetryFacet.nullable()`:
```
TelemetryFacet {
  cost: { tokens_in: int, tokens_out: int, usd: number } | null   // null = no usage source
  latency_ms: int | null
  model: string | null
  provider_id: string | null
  provider_version: string | null
  prompt_ref: string | null        // offloaded artifact handle, not inline
  raw_output_ref: string | null
  rejected_alternatives: [{ option: string, reason: string }]   // from workflow_decisions.alternatives
  human_interventions: [{ kind: string, ref: string }]          // approvals, revises, escalations, revived feedback
  outcome: { status: enum, failure_code: enum | null }          // CATEGORICAL
}
```
Apply the **contract-tightening discipline** (Phase-2 lesson): the SAME task updates `RecordTransitionInput.telemetry` in `harness-transitions/usecases.ts`, runs the daemon typecheck, and rebuilds the contracts dist.

### 4.2 Worker-token capture via OTEL (P1 — the heavy, recon-first part)
- **Daemon OTLP receiver:** a minimal **OTLP/HTTP** endpoint embedded in the Fastify server (no sidecar collector — fits Orca's local-first single-daemon model). Accepts OTLP metrics + logs (JSON or protobuf — recon the simplest the CLIs emit), extracts the token/cost signals, discards the rest.
- **Spawn wiring:** Claude workers get the telemetry env vars through the existing `buildSpawnEnv` allowlist (`INTERACTIVE_ENV_PASSTHROUGH`); Codex workers get `[otel]` written into their `configDir` `config.toml` (the existing per-worker config mechanism that already writes `config.toml`/`hooks.json`). Endpoint points at the daemon's receiver (loopback).
- **Attribution:** OTEL signals are keyed by `session.id`. Map `session.id → Orca session → goal`. Because `TelemetryFacet` is **per-transition** but tokens accrue **per-session/turn**, maintain a **per-session cost accumulator**; attach accrued cost to the relevant transition at its boundary (e.g. the step-complete / response-done transition for that session). Define the accumulator→attachment rule explicitly in the plan.
- **Codex entry-point caveat:** confirm how Orca spawns Codex workers (interactive vs `exec` vs `mcp-server`); OTEL token logs require interactive/`exec`. If Orca uses `mcp-server`, Codex degrades to `cost=null` until changed (recon-first).

### 4.3 Categorical failure codes (P1)
Add a categorical `failure_code` enum to transition `outcome` (mirror the extraction enum in `migrations/0005_memory.sql:15`). Workflow steps currently carry only free-text `reason`; populate the categorical code at the failure boundaries so P3 attribution can cluster.

### 4.4 `/v1/goals/:id/harness-metrics` projection + unified provenance (P2)
Read-only fold over the transition log producing the six paper metrics (p.62), each self-describing source + availability (D2):
| Metric | Source | Availability now |
|---|---|---|
| Trajectory efficiency | transition count, tokens, revises, duration | ✅ |
| Verification strength | `EvidenceFacet` coverage + oracle_adequacy | ✅ |
| Recovery | crash/revise recovered vs escalated | ✅ |
| State consistency | `StateDepsFacet` conflicts | ⛔ null ("StateDepsFacet not yet emitted") |
| Safety compliance | `RiskFacet` gate decisions honored vs denied | ✅ |
| Replayability | % transitions with complete facets | ✅ |
Plus: unify the two disjoint provenance models (decisions/alternatives/influenced_by + guardrail evals + FK lineage) into multi-hop lineage reachable from a transition.

### 4.5 Replay + attribution + revived feedback (P3)
- **Control-plane replay:** read-only reconstruction of a goal's transition trajectory (ordered fold over the log; the scoped slice, not full event-sourcing).
- **Failure attribution:** cluster transitions by `failure_code` × {step, adapter, guardrail, sensor} to surface recurring culprits — the read-side substrate for the paper's Evolution Agent (the agent itself is an L5 **non-goal**; only the read side is in scope).
- **Revive recommendation feedback:** the dormant `recentFeedback` (assembled into `RecommendationInput` but read by nothing) becomes a `human_intervention` signal on the transition, feeding attribution.

## 5. Internal phasing (one plan, three sub-phases)
- **P1:** `TelemetryFacet` contract + cost map; OTLP receiver + spawn wiring + per-session cost attribution; categorical failure codes.
- **P2:** `/harness-metrics` projection (graceful-degrade) + unified multi-hop provenance.
- **P3:** control-plane replay; failure attribution clustering; revived recommendation feedback.

## 6. Recon-first items (before the relevant tasks)
1. **OTLP receiver shape:** the exact OTLP wire format (JSON vs protobuf, metrics vs logs) each CLI emits, and the minimal parse to extract token/cost keyed by `session.id`. The novel infra piece — recon before building the receiver.
2. **Codex spawn entry point** (interactive / `exec` / `mcp-server`) — determines whether Codex OTEL works or degrades.
3. **Per-session → per-transition cost attribution boundary** — which transition each session's accrued cost attaches to.
4. **`prompt_ref`/`raw_output_ref` offload:** confirm where offloaded artifacts live (handles, not inline) before populating those fields.

## 7. Non-goals (explicit)
- Full event-sourcing of all Orca state (only the control-plane transition log is replayable).
- The autonomous Evolution Agent / self-modifying harness (L5; only the read-side attribution substrate is in scope).
- Running an external OTEL collector / observability stack (the daemon embeds a minimal receiver; no Prometheus/Grafana).
- Per-subagent (within-worker) token attribution beyond what `session.id`-keyed OTEL provides.
- Cross-run/global aggregation dashboards beyond the per-goal `/harness-metrics` projection.

## 8. Constraints (inherited)
Contracts idiom (`z` schema + inferred type, `.strict()`, datetime); migrations append to `migrationFiles` (next free number TBD at plan time — Governed used 0041/0042); daemon subsystem idiom (prepared-stmt caching + `resetPreparedStatements`); fail-closed defaults; contract-tightening lesson (tighten facet ⇒ update `RecordTransitionInput` + daemon typecheck + rebuild contracts dist in the same task); update migration-list snapshot tests additively.
