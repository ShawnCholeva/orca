# Future Work

Outstanding, deferred, and explicitly-out-of-scope items, harvested from the plan/spec documents that drove Orca's evolution (now retired — the durable narrative lives in `ORCA.md` §14). This is a backlog of *what was deliberately left undone with enough context to resume*, not a roadmap commitment. Items are grouped by subsystem; file references are best-effort pointers from the source docs and should be re-verified against current code before acting.

Status hints: 🔴 blocked on external info · 🟡 deferred by decision · ⚪ intentional non-change (do **not** "fix" without re-deciding).

---

## Harness axes — Governed

- 🔴 **Antigravity worker permission gate (the one open coverage gap).** `agy` workers spawn **ungated / fail-open** — no risk classification, no `tool_gate` transition, no safety floor; claude-code and codex *are* gated. `workerHookConfig` is a `{files:[], spawnArgs:[]}` stub in `apps/daemon/src/orchestrator-llm/providers/antigravity.ts`. Blocked on 4 unknowns from the `agy` CLI/source: the permission-hook **event name**, the **hook-file JSON shape + on-disk path** `agy` reads, the **discovery mechanism** (env var / flag / cwd), and the **stdout decision schema**. Resume: implement `workerHookConfig` mirroring Codex's resolver wiring, flip the `worker-hook-config.test.ts` assertion (currently asserts the empty stub), keep `permissionRule`/`writePermissionRule` no-ops (no native allow-list persistence for antigravity yet).
- 🟡 **New-goal `operating_mode` default from the global setting.** `migrations/0041` hardcodes the column DEFAULT to `'human_review'` and goal creation ignores the global orchestrator-tab setting. Wire `createGoal` (`apps/daemon/src/server.ts`, `/v1/goals/:goalId` create path) to inherit the "default for future goals" value.
- 🟡 **Global supervision flip → default-only.** The `/v1/settings` flip to `unsupervised` still calls `continueAllPausedSteps()` with no `goalId`, draining parked steps for *every* goal including `human_review` ones (`confirmStep` doesn't re-check mode). Make the global flip default-only (stop force-confirming existing goals). In `server.ts` (`/v1/settings`) + `workflows/orchestrator/service.ts`.
- 🟡 **`gate_approval_counts` retention.** Grows one row per `(goal_id, action_class)` with no reaper; consider cleanup on goal archive. Low concern.
- 🟡 **Coverage:** route-level test for the `canRemember` advertise + the relaxation `GoalDecision` (only module-level + inspection coverage today).
- ⚪ **Real OS containment (`SpawnSandbox`).** The seam exists as a default no-op pass-through (`apps/daemon/src/adapters/sandbox.ts`); actual OS sandboxing (macOS `sandbox-exec` / Linux namespaces+seccomp / Windows) is explicitly out of scope. Agents run in the real repo with inherited credentials.
- ⚪ **Intentional non-changes — do not "fix":** `classify.ts` `\bnc\b` over-match (errs fail-safe / over-escalates); the double-namespaced `operator:agent:claude-code` risk label (revisit only with a real operator taxonomy — change producer + matcher together); the inert `autonomyLevel` column (SQLite column drops are messy; left in place).

## Harness axes — Stateful

> Core P1+P2 merged to `main` (StateDepsFacet, derived read/write-sets, deterministic conflict + belief-divergence). The following are deferred or partially-untested follow-ups.

- 🟡 **Activate `belief_divergence` (ships wired but INERT).** Step launch records workspace `branch:dirty` as null-encoded `":"`. Populate real `branch:dirty` via `inspectWorkspace` (`workspaces/inspect.ts`) at **both** the step_launch site (`service.ts` ~3251) and the step_complete site, building `currentVersions` from live inspect.
- 🟡 **Per-goal `conflict_policy` source.** Today hardcoded to the constant `"escalate"`, so the WARN/auto path is unit-tested but not reachable end-to-end. Either add a `goals` column (migration `0043` + the 4 `migrations.test.ts` snapshot enumerations) or derive from `operating_mode` (automated→auto, human_review→escalate).
- 🟡 **Multi-workspace goals: read/write-set workspace selection.** `deriveWriteSet`/read-set pin to the *first* attached workspace (`listWorkspacesByGoal[0]`) in `service.ts`; records the wrong workspace's set if a step targets a different attached workspace. Matters once belief-divergence is live.
- 🟡 **`deriveWriteSet` git rename/copy parse bug.** Real `git diff --name-status` rename/copy lines (`R100\told\tnew`, two tabs) parse the destination as a tab-embedded ref instead of the path. Fix: split remaining on tab, take last segment. Untested against real git output.
- 🟡 **`detectStateConflicts` coverage gaps.** Absent-version→divergence semantics and `kind:ref` discrimination (file vs memory_item at same ref → `[]`) are correct-by-inspection but untested; add a kind-discrimination test + an absent-ref test.
- 🟡 **Refinement read_set kind-namespace collision.** A refinement read_set entry maps to `kind:"decision"` ref:`goalId`, sharing the decision namespace with real decisions (pre-existing namespace-impurity risk).
- ⚪ **LLM semantic conflict-judge.** Only the no-op `ConflictJudge` seam shipped (`noopConflictJudge` keeps every overlap as a real conflict). An LLM judge gated behind the deterministic overlap signal (reusing the `SessionMemoryExtractor` seam) is a documented later drop-in — no LLM call today.
- ⚪ **Sibling-session summaries in launch read_set** deliberately omitted (`summaries: []`, no exported reader exists).
- ⚪ **No pessimistic locking, no auto-merge, no cross-goal state** — optimistic detect-don't-prevent is the chosen model.

## Harness axes — Executable

- 🟡 **P2/P3 sensors.** Full sensor ladder + lint/static sensors, oracle-adequacy enforcement, artifact offload of full sensor output (`artifact_ref`), and sensors as per-workspace declarative config with route-by-type feedback. P1 shipped typecheck + unit + veto only.
- 🟡 **Per-ecosystem sensor resolvers** (Makefile / `cargo` / `pytest`, …). P1 auto-detects only `package.json` scripts.
- 🟡 **`runCheckCommand` `MAX_BUFFER` raise (256 KiB).** Too small for verbose suites; a sensor tripping `max_buffer` is conservatively treated as failed (P2.5 follow-up).
- ⚪ **`detect.ts` uses `npm run`** while Orca workspaces are pnpm — works, noted as a curiosity, not a bug.

## Harness axes — Inspectable

- 🔴/🟡 **OTEL live end-to-end smoke not yet run.** worker→receiver→accumulator→drain→facet is asserted-by-construction only. Run a live smoke (one Claude step + one Codex step → confirm non-null `telemetry.cost`); Codex struct-form `[otel.exporter."otlp-http"]` is the least-exercised branch. Note: Codex `mcp-server` spawn has no OTEL (interactive/`exec` only); antigravity has no usage channel → always `cost=null`.
- 🟡 **`replay.ts` 10,000-row limit truncates the *oldest* transitions** — the wrong end to drop for a replay. Keep oldest, or paginate.
- 🟡 **Codex telemetry gaps.** `durationMs`/latency left null (no duration in `codex.sse_event`; `turn_ttft`/`api_request` shapes uncaptured); Codex cost estimate doesn't price cache tokens. Plus deferred per-tool durations/errors, ttft, edit accept/reject, LOC/commit/PR counts.
- 🟡 **Price map as a config source.** Static in-code table today; a config source is additive/deferred unless it churns.
- 🟡 **`prompt_ref` / `raw_output_ref` artifact offload.** Confirm where offloaded artifacts live (handles, not inline) before populating.
- 🟡 **Slimmer `/harness-replay` wire shape.** Route exposes raw `RiskFacet`/`EvidenceFacet`/`TelemetryFacet`; no Zod envelope on provenance/replay responses; prefix-precedence and negative-token clamp untested in `cost.ts`.
- 🟡 **`recommendations/input.ts` `recentFeedback` is genuinely dead** (only feeds the regeneration fingerprint); reviving it needs a fingerprint change (out of scope). Also feedback refs are stamped on every `step_complete` (over-broad) — scope to "since previous transition" or de-dup at attribution.
- ⚪ **Explicit non-goals:** full event-sourcing of all Orca state; external OTEL collector / Prometheus-Grafana; per-subagent within-worker token attribution; cross-run/global dashboards beyond per-goal `/harness-metrics`.

## Harness axes — spine & cross-cutting

- 🟡 **Write-path `recordHarnessTransition` returns the in-memory row unvalidated** (read path validates).
- 🟡 **Dropped `step_complete` transition emits no metric** (deferred to the TelemetryFacet phase).
- ⚪ **Autonomous Evolution Agent / self-modifying harness (L5)** — explicit non-goal; only the read-side failure-attribution substrate (categorical codes + clustering) is in scope.
- ⚪ **Cross-goal / global memory** — non-goal; experiential memory stays within per-goal templates.

---

## Adapters & worker permission modes

- 🟡 **Antigravity worker permission modes (Phase 4)** — `workerHookConfig` + `PreToolUse`/`request-review` shaping + native allow-list writer. (Same gap as the Governed antigravity item above, from the permission-modes angle.) Also: validate the antigravity `request-review` / `PreToolHookResult` overwrite edge case.
- 🟡 **Rename `ShadowProvider` → a shared `AgentProvider`** interface (noted as a future generalization in the `workerHookConfig` doc-comment).
- 🟡 **Codex hook-trust persistence** as an alternative to `--dangerously-bypass-hook-trust` ("not explored"); the assumed 600s hook timeout default remains unverified (only the per-hook `timeout` key was live-verified).
- ⚪ **Codex per-command "remember" / `writePermissionRule`** — out of scope by design (Codex uses a global `approval_policy`, no per-command rule); stays a no-op.
- ⚪ **Persisting *deny* decisions** — explicit non-goal (only `allow` + `remember` writes a rule).
- ⚪ **Orca-maintained permission allow-list ("Strategy A")** — abandoned; relies entirely on each CLI's native residual-permission event.
- ⚪ **Direct Google API model provider** (non-agent orchestration) — explicit non-goal of the antigravity adapter; `orca/google` is agent-backed metadata only.
- ⚪ **Pending approvals are in-memory only** — do not survive a daemon restart (accepted tradeoff).

## Workflow step results & supervised completion

- 🟡 **Telemetry counters** (`total_turns` / `tool_calls` on `WorkflowStepResult.performance`) stay optional until a reliable system source exists.
- 🟡 **Revision-signal consumer.** `step_revision_signals` is populated but nothing reads it; mining divergences to recalibrate scoring/approval criteria (plus any analytics UI) is future.
- 🟡 **Scoring fill-rate eval gate** — no prompt-eval harness; fill-rate observed in practice post-ship.
- 🟡 **Verbatim confirmation `lead` capture** — deferred; lead is rebuilt from `resultSummary ?? outcome.reason`, not snapshotted at confirm time.
- 🟡 **Run-pinning UI / template version history** — no "pinned to version N" view, no historical-version store; backfilling snapshots for pre-migration runs is out of scope.
- 🟡 **Output-schema object-level descriptions** — the shorthand grammar restricts rather than round-trips them on multi-line objects; `onValidityChange` save-gating polish was left optional.
- 🟡 **Step terminal-event payload carrying full `stepResult`** — left conditional on the workflow event payload budget; events may carry identifiers only with consumers fetching the step run.
- ⚪ **Per-goal supervision override** and **finer-grained autonomy gradations** — out of scope; autonomy stays the binary Supervised (L4) / Autonomous (L5) `operating_mode`, and the dormant `goals.autonomy_level` integer is left inert.
- ⚪ **Parallel/concurrent step execution** — multi-cursor traversal and join semantics out of scope (validation is written fan-out-ready; steps stay single-outgoing-edge).
- ⚪ **DB migration of existing user templates** for the new terminal-reachability rule — not done; validation applies only on next edit. No step-level `terminal` marker on the step contract (graph node `terminal` is the single source of truth).

## OrcaChat conversational surface

- 🟡 **Codex (and other adapters) support for the activity thread** — v1 is Claude-only; validate the provider-neutral contract against the Codex hook adapter in a follow-up. Reasoning-note extraction is likewise Claude-Code-transcript-specific (silent no-op otherwise).
- 🟡 **Full mark-done card wiring** — `mark_done_ready` maps to a `completed`/`paused_for_input` activity but is stubbed, not fully wired.
- 🟡 **Wire the orchestrator's own shadow-session hooks into the persisted activity stream** — the routing card stays synthetic/transient.
- 🟡 **Auto-collapsing completed activity cards** to a summary line — deferred; "revisit if scroll length becomes a problem."
- 🟡 **Reasoning-note volume** — if notes feel noisy in practice, summarize/throttle them (`server.ts onToolUse` / `activities/transcript.ts`).
- 🟡 **Optional `(Recommended)` badge detection** at render time (best-effort heuristic on Claude's label convention).
- ⚪ **Optional LLM polish of Orca-voiced worker-question text** — out of scope for v1; deterministic templating only.
- ⚪ **No retro-migration of worker questions already pending at upgrade time** — they keep the old activity shape. Orchestrator `ask_user` questions and permission approvals are unchanged by the free-text / persist-answered arcs.
- ⚪ **`git diff`-based diff capture** and a **per-turn consolidated "Changes" card** — rejected in favor of hook-reconstructed per-edit diffs.

## Graph routing, provider recovery, ledger & daemon addressing

- 🟡 **Desktop ledger rendering** beyond the daemon read route (Inspectable-style UI for the committed ledger).
- 🟡 **Daemon addressing — remote daemon.** Only the discovery-file/resolver seam exists; the remote endpoint + token refresh plug in later with no worker changes.
- 🟡 **Client-triggered re-adopt/respawn when daemon health is lost mid-use** — described (`lib.rs`) but has no dedicated automated test (manual smoke only).
- 🟡 **Prod-SEA packaging / Node availability** for the cross-platform resolver script; Windows file-permission handling is best-effort (chmod skipped).
- 🟡 **Phase-2 ledger open decisions to confirm against live code:** exact transaction structure for atomic ledger-commit + `step_output` + advance (async review kept outside the sync txn); always-commit empty ledger versions vs only non-empty; whether orchestrator review uses a real broker correction pass or the deterministic normalizer alone.
- ⚪ **Provider-recovery non-goals:** automatic provider switching in Auto-run, predicting quota availability when the provider doesn't report it, sharing native conversation state across providers, billing/quota-purchase flows.
- ⚪ **Daemon-addressing out of scope:** retrofitting in-flight workers (they age out); auto-stop / idle daemon shutdown (explicit stop + OS logout only).

## Templates, onboarding & splitter

- 🟡 **Fan-out / fan-in primitive** — a sibling to the splitter that spawns *all* of N: a fan-out node instantiating a child `WorkflowRun` per runtime task (different workspaces) + a fan-in/join node aggregating to the parent. Needs parent↔child run relationships and a dynamically materialized executed graph; the validator's branch-source-agnostic terminal-reachability is the pre-built seam. (Parallel cursors within one run are explicitly rejected in favor of child runs.)
- 🟡 **Phase-2 platform-managed ledger for templates** (the `<orca:step-complete>` envelope, versioning, canonical-ID allocation, orchestrator review) — see the ledger items above; the Feature-Development template runs without it.
- 🟡 **Future template categories** (Product, Design, …) — grouping is data-driven/additive but only `Engineering` exists today.
- 🟡 **Initiative Implementation `INITIATIVE_GRAPH` validity** and the catalog reconcile test's `goals` insert columns — flagged to confirm against the real schema during execution; check for lingering references to the removed `orca/engineering` / `orca/feature-development` seeds.
- ⚪ **Roles / `roleLabels`** — out of scope across catalog and onboarding (display metadata only; no role model, no role chips).
- ⚪ **Per-template enable/disable after install**, **cross-goal knowledge graph**, and **visit-limits / loop caps on routing** — explicit non-goals. The "Feature Development → Feature Implementation" rename lands only on fresh inserts (version-guarded upsert).

## Honest, participatory brainstorm

- 🟡 **Rewrite the other workflow instructions** (Feature, Bug, Refactor, Initiative, Quality, Code Review) for honest/participatory behavior — only Brainstorm's instructions were rewritten; the rest inherit only the engine/UI changes.
- 🟡 **Reasoning-note throttling/summarization** if noisy; opening the result-card artifact in the filesystem/editor (renders as text/title only today).
- ⚪ **No visible gate node for the open-questions check** (enforced as a completion invariant), **no per-item blocking-vs-note agent classification** (the step's `completionPolicy` decides), and **scoring math / quality dimensions unchanged**.

## Workspaces

- 🟡 **Goal-creation workspace picker** — the entire `2026-06-21` spec (pick from registered workspaces instead of browsing the filesystem at goal creation; `create-goal-flow/state.ts`, `steps/CoordinateStep.tsx`, `CreateGoalFlow.tsx`, `App.tsx`) was design-only ("no code yet"), not yet implemented. Open question: empty-state link landing depth (auto-open the add-workspace modal vs just land on the Workspaces tab — defaulted to the latter).
- ⚪ **Out of scope v1:** delete-workspace mutation; live-session indicators/counts on goal cards & workspace rows; associating an existing goal to a workspace from the Workspaces tab; workspace color/icon/slug; persisted live git state on the entity; a pre-submit liveness check for moved/deleted registered folders (the daemon's submit-time re-inspect is the only guard).

---

## ORCA.md hygiene

The harness-axes spec called for correcting materially-stale ORCA.md claims; the verified ones (three adapters not two, `orca/adaptive-delivery` not `orca/engineering` as default, ~32 KiB not 64 KiB context envelope, per-goal `operating_mode` superseding the 5-level `autonomyLevel` at runtime) have been applied. A few subtler claims from that appendix were **not** independently verified and are left as-is pending a code check: the memory lifecycle tiers (`observed → extracted → promoted → canonical`), the "reconstruct a Goal by replaying its events" claim, and the "LLM-driven extraction" framing. Verify against current code before trusting or editing them.

## Known test flakes (acknowledged, not root-caused)

- `http-surface.test.ts` and `human-review.test.ts` (15s timeout) — time out under parallel load, pass in isolation.
