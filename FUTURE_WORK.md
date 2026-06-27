# Future Work

Outstanding, deferred, and explicitly-out-of-scope items, harvested from the plan/spec documents that drove Orca's evolution (now retired — the durable narrative lives in `ORCA.md` §14). This is a backlog of *what was deliberately left undone with enough context to resume*, not a roadmap commitment. File references are best-effort pointers from the source docs and should be re-verified against current code before acting.

**Status hints:** 🔴 blocked on external info · 🟡 deferred by decision · ⚪ intentional non-change (do **not** "fix" without re-deciding — all ⚪ items live in [Appendix A](#appendix-a--non-goals--decided-against)).

## How this is sequenced

Work runs **from the substrate up**: lock the harness spine so it can't structurally drift, then activate each harness axis in turn, then catch the surfaces up, then pull the autonomy levers. Each phase has an **exit criterion** — the signal that the substrate is solid enough to start the next phase. You can walk the phases top-to-bottom; within a phase, items are ordered so the foundational ones come first.

| Phase | Theme | Exit criterion |
|---|---|---|
| **0** ✅ | Lock the spine | Substrate is runtime-enumerable; the engine is modular along its natural seams; no facet is hand-synced. **— COMPLETE (2026-06-26).** |
| **1** | Close the Governed axis | No ungated worker path exists; supervision settings behave correctly per-goal. |
| **2** | Activate the Stateful axis | Belief-divergence is live end-to-end; the conflict WARN/auto path is reachable. |
| **3** | Complete Executable & Inspectable | Full sensor ladder; OTEL verified on a live run; replay is correct. |
| **4** | Surfaces & features on the harness | The conversational/adapter/template/workspace surfaces are caught up to the substrate. |
| **5** | Composition, learning & autonomy | The delegate seam and learning loop exist; the gate can drive itself in L5 (the L4→L5 crossing). |

> **Guiding concern (applies to every phase).** Each architectural decision in Orca is individually defensible, but the sum — four harness axes × four facets × four boundaries × three adapters × graph-routed templates × recovery state machines × a versioned ledger, much of it converging in one daemon and one engine file — is a large surface area for a small team. The risk is good calls outpacing the capacity to keep them all correct (the ungated antigravity path in Phase 1 is the first visible instance). **Bias toward consolidation over new axes until the spine is runtime-enumerable and the engine is modular** — which is exactly what Phase 0 buys.

---

# Phase 0 — Lock the spine — ✅ COMPLETE (2026-06-26)

The harness spine works but is **hand-wired**, so the substrate can structurally drift. This phase consolidates it behind self-registering registries and modularizes the engine that drives it. Nothing above this should race ahead of a substrate that can drift. **No behavior change in this phase** — pure consolidation, justified by present duplication and leaning on existing harness/orchestrator test coverage.

### 0.1 — Harness substrate factory: facet / boundary / sensor registries — ✅ DONE (2026-06-25)

Shipped all three self-registering registries (`defineFacet`/`defineBoundary`/`defineSensor`) + load-time/test conformance guards + the `GET /v1/harness/registry` introspection route. The `defBoundary` emit factory is the sole sanctioned transition write path; validate-on-write closed the unvalidated-write gap; the dormant `mark_done` boundary now fires on human-accepted completion (carrying a minimal TelemetryFacet — see deferred roll-ups in **2.7**); the `integration`/`static` sensor drift is now explicit-unimplemented. Spec + plan: `docs/superpowers/specs/2026-06-25-harness-substrate-registries-design.md`, `docs/superpowers/plans/2026-06-25-harness-substrate-registries.md`.

### 0.2 — Decompose `OrchestratorService` (~4,645 lines)

🟡 The entire mediation engine — dispatch, provider recovery, judgement, scoring, ledger commit, gate/splitter routing — lives in one class (`workflows/orchestrator/service.ts`). It is the most safety-critical module in the system yet the largest and hardest to review; a 4.6k-line file is where latent bugs hide, and at L4/L5 those execute *past* a human gate. **No behavior change** — extract along the natural seams as collaborator modules/units, **one seam per PR**, leaning on the existing orchestrator test suite as the behavior-preservation guard. Pattern: free-function modules for internal helpers (delete the private methods, repoint call sites — no forwarding stubs); a standalone unit where there's a public surface with held deps.

- ✅ **Step scoring & result building** — DONE (2026-06-25). Extracted to `step-result-builder.ts` (free fns); 5 methods deleted, call sites repointed. Spec/plan: `docs/superpowers/specs|plans/2026-06-25-orchestrator-decomposition-ab*`.
- ✅ **Provider recovery** state machine — DONE (2026-06-25). **Lifted entirely out** into a standalone `ProviderRecoveryController` (server.ts calls it directly; the 7 methods left `OrchestratorService`), depending on a new **`RunnerPort`** — the execution-plane capability surface = the in-process precursor to FUTURE_ARCHITECTURE's Runner Protocol. Two pure shared helpers extracted to `repair-context.ts`. The now-unused `workerWait` constructor param was removed.
- ✅ **Ledger commit (pure trio)** — DONE (2026-06-25). `completeStepWithLedger`/`commitStepOutputAndLedger`/`createStepOutputArtifact` extracted to `ledger-commit.ts` (free fns, zero `this.*`, no deps object); call sites repointed.
- ✅ **Shared DB-row access** — DONE (2026-06-25). `GoalRow`/`StepRunRow`/`readGoal`/`readStepRun`/`preferencesForGoal` + the two reader error classes consolidated into `db-rows.ts` (imports from no orchestrator file → no cycle); closes the prior `step-result-builder`/controller type-duplication. A concrete step toward FUTURE_ARCHITECTURE's storage-provider seam (raw row reads now centralized). Spec/plan: `docs/superpowers/specs|plans/2026-06-25-orchestrator-decomposition-cd*`.
- ⚪ **Advance/route engine — intentionally kept whole.** *(⚪ = a settled decision, not pending work — no checkmark by design.)* `commitAdvanceOrComplete` + gate/splitter routing (`parkForGateApproval`, `evaluateAndParkSplitter`, `routeGateDestination`, `decideGate`, `confirm*`) is the orchestrator's irreducible dispatch core: it recurses into `requestNextDecision`/`spawnStepAgent` with a `routeGateDestination ⇄ evaluateAndParkSplitter` cycle. Extracting it piecemeal needs ~7 injected callbacks (incl. the methods it recurses into) — a pass-through, not a seam. FUTURE_ARCHITECTURE: "deterministic code owns lifecycle, routing, gates" (one core). Documented in a code-comment on `commitAdvanceOrComplete`; do **not** force-extract.
- ✅ **DispatchEngine split — DONE (2026-06-25).** The cohesive advance/route engine (`requestNextDecision`, `advanceToNextStep`, `commitAdvanceOrComplete`, gate/splitter routing, `spawnStepAgent`, `blockRun`, the commit/decision plumbing — ~22 methods) is now its own `DispatchEngine` class (`dispatch-engine.ts`); `OrchestratorService` is the event-handler/reaction layer (`onWorkflowSessionCompleted`/`onSessionOutputChunk`/`onAgentResponseDone`/`onUserMessage`/`confirmStep`/`reviseStep`/revisions/…) that calls the engine via `this.engine`. The boundary is **acyclic** (handlers→engine; no engine method calls a handler); the engine is the paper's "Control Unit." Done as a transitional-delegate two-step (Phase 1 narrowed the seam, then introduce-engine-with-delegates, then remove-delegates) for safety. `service.ts` ~4,641 → ~1,807 across the whole 0.2 arc; the engine is ~1,970 in its own file. Spec/plan: `docs/superpowers/specs|plans/2026-06-25-dispatchengine-phase2-split*` (+ phase1-narrow-seam).
  - ✅ *Follow-up — DONE (2026-06-26).* Shared types/errors (`RequestNextDecisionOptions`, `StepDispatchCapabilities`, `TokenAccumulator`, the `Orchestrator*Error` classes) lifted into a leaf `dispatch-types.ts` that both `dispatch-engine.ts` and the leaf modules import directly; the `service.ts` re-export seam is gone (runtime helpers `NULL_ACCUMULATOR`/`buildTelemetry`/`nowWithFirstTimestamp` still re-exported). The 4 pure-engine test helpers renamed `service`→`engine` / `makeService`→`makeEngine`. Plan: `docs/superpowers/plans/2026-06-26-orchestrator-decomposition-followups.md`.
  - ✅ **Phase 1 (narrow the seam) — DONE (2026-06-25).** Extracted the pure shared utility/query helpers to free-fn modules (`queries.ts`: `stepRunIdsByTemplateId`/`artifactCountForStep`/`retryCount`/`hasActiveUnansweredQuestion`/`readStepOutputAsRecord` + `publishStaged`; `orchestrator-message.ts`: `postOrchestratorMessage`) and dropped the dead `operatorSelector` constructor param + its route-deps/server/guard threading — tightening Phase 2's engine interface to ~8 graph-operation methods. Spec/plan: `docs/superpowers/specs|plans/2026-06-25-dispatchengine-phase1-narrow-seam*`.
  - ✅ **Follow-up: finish the `operatorSelector` excision — DONE (2026-06-26).** Dropped the `DaemonContext.operatorSelector` field + `new OperatorSelector(...)` construction + import from `daemon-context.ts`; deleted the dead `OperatorSelector` class (+ `selector.test.ts` + cascade-dead private helpers). The whole-branch review then found `selector.ts`'s remaining 4 type exports had zero importers (the plan's "still-used" premise was wrong; `noUnusedLocals` can't flag unused *exports*) — `selector.ts` deleted in full.
- ~~**Harness transition emit sites**~~ — ✅ DONE in 0.1 (the `defBoundary` emit factory replaced all 5 string-literal sites; `recordHarnessTransition` is now internal to the factory).

### 0.3 — Per-adapter hook-readiness contract check — ✅ DONE (2026-06-26)

Each provider now **declares its hook-surface assumptions as data** (`hookContract(): HookAssumption[]` on `ShadowProvider`, per `(provider × surface × event)`: depended-on event, file, payload fields, firing context, verified-against CLI version, `verified` flag, provenance note). Two checks consume it: a **boot self-conformance guard** (`assertHookContractConformance()` in `orchestrator-llm/providers/hook-contract.ts`, wired in `index.ts` right after `assertHarnessRegistryConformance`) that **hard-fails daemon startup** if a provider's declared contract no longer matches its emitted hook config — and an on-demand **`GET /v1/harness/hook-contracts`** route that layers CLI-version-pin drift (flag on minor/major, ignore patch; version read from the persisted readiness probe) + honest `unverified`/`unknown` status. No live third-party process is spawned — the checker regenerates Orca's own emitted config and matches the event as a JSON key (so a dropped `Stop` hook can't hide behind `StopFailure`). Antigravity declares its worker-permission surface as an explicit `verified:false` gap (the Phase 1 unknowns), so it surfaces as `unverified` rather than masquerading as green. Stateless, no migration, no `packages/contracts` change. Documented honest limit: a *same-version* semantic rename is undetectable by version-pin (the optional runtime watchdog is its only mitigation, out of scope). Spec/plan: `docs/superpowers/specs|plans/2026-06-26-adapter-hook-contract-check*`.

> **Exit criterion — MET.** The substrate is runtime-enumerable (`GET /v1/harness/registry` + `/v1/harness/hook-contracts`), every facet/boundary/sensor flows through its registry, the engine is split along the 0.2 seams, and an adapter hook drift now fails loud (boot guard) instead of silent. **Phase 0 complete.**

---

# Phase 1 — Close the Governed axis

The harness Governed axis is complete *except* for the items below — the first being a genuine safety hole.

- 🟡 **Antigravity worker permission gate (the one open coverage gap).** `agy` workers spawn **ungated / fail-open** — no risk classification, no `tool_gate` transition, no safety floor; claude-code and codex *are* gated. `workerHookConfig` is a `{files:[], spawnArgs:[]}` stub in `apps/daemon/src/orchestrator-llm/providers/antigravity.ts`. **The 4 unknowns are now RESOLVED** (2026-06-26 spike: official docs at https://antigravity.google/docs/hooks + a live `agy` 1.0.13 smoke). The earlier "mirror Codex's hook file" premise was *partly wrong* — agy's hook + decision schema differ from Claude/Codex, and there is a genuine **worker-isolation** snag (below).
  - **Verified hook spec.** File `.agents/hooks.json` in the workspace (or global `~/.gemini/config/`). Events: `PreToolUse`/`PostToolUse` (matcher = tool name, e.g. `run_command`, `browser_.*`, `*`), `PreInvocation`/`PostInvocation`/`Stop` (no matcher, flat handler list — this flat form is exactly what the orchestrator's `Stop` hook already writes, which is why orchestrator Stop is genuinely fine). **PreToolUse format:** `{"<name>":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"…","timeout":30}]}]}}` (handlers nest under `hooks:[]` inside each matcher entry — NOT the flat Stop form). Optional top-level `"enabled":false` disables a named hook.
  - **PreToolUse stdin (camelCase):** `{toolCall:{name,args}, stepIdx, conversationId, workspacePaths[], transcriptPath, artifactDirectoryPath}`. **No `tool_use_id`** — synthesize a correlation id (like the Codex relay) from `conversationId`+`stepIdx`+sha1(`toolCall`).
  - **PreToolUse stdout:** `{decision:"allow"|"deny"|"ask"|"force_ask", reason?, permissionOverrides?:string[]}`. `deny` = hard-block immediately; `ask` = prompt (respects Always-Allow); `force_ask` = always prompt. (Field is `reason`, not the binary's internal `deny_reason`.)
  - **Hooks are interactive-only** (do not fire in `agy -p` print mode) — confirmed live. The worker already detects idle via pane capture, so the gate needs only the `PreToolUse` hook (no worker `Stop` hook required).
  - **Design (resolved part).** workerHookConfig emits `.agents/hooks.json` with a `PreToolUse` `matcher:"*"` hook + an **output-translating `.cjs` relay** (mirrors the existing `orca-stop-hook.cjs`): read agy's `toolCall.{name,args}` from stdin, synthesize a tool_use_id, POST `{tool_name,tool_input,tool_use_id}` to `/v1/agent-hooks/permission?sessionId=…` (reusing the *entire* existing gate — `classify.ts`→`decideGate` safety floor→`tool_gate` transition→operator await), then **translate** the daemon's `{hookSpecificOutput:{decision:{behavior:"allow"|"deny"}}}` into agy's `{decision:"allow"}` / `{decision:"deny",reason}`. Keep `permissionRule`/`writePermissionRule` no-ops (Phase 4). Flip the `worker-hook-config.test.ts` empty-stub assertion. Keep the `hookContract` worker entry `verified:false` until the live deny-blocking smoke passes in the **real daemon flow**.
  - **OPEN DESIGN DECISION — worker hook isolation (the only blocker left).** Claude uses `--settings <path>` and Codex uses `CODEX_HOME` to point the worker at an isolated `configDir`; **agy has NO per-invocation config/customization-dir override** (live-falsified 2026-06-26 against agy 1.0.13): `ANTIGRAVITY_EXECUTABLE_DATA_DIR` is **sidecar-data only** (not config/auth/hooks), `--user-data-dir` is **not a real flag**, and `GEMINI_DIR`/`GEMINI_HOME` do **not** relocate (every run falls back to `appDataDir=~/.gemini/antigravity-cli`; customization at `~/.gemini/config/` + workspace `.agents/`). So the CODEX_HOME-style relocation is **infeasible today** — agy reads `.agents/hooks.json` from the *workspace cwd*, which the orchestrator shadow session + the (sequential, ≤1-at-a-time) worker share. Remaining candidate resolutions: (b) one git **worktree per worker** so each gets its own `.agents/` (clean, but no worker-worktree infra exists today — larger scope; also reusable for Phase 5.1 isolated state); (c) **workspace-shared `.agents/hooks.json`** carrying both the orchestrator Stop hook and a worker `PreToolUse` hook, with request-time session correlation — since steps are sequential, the relay can embed `?goalId=…` (like the existing Stop relay) and the daemon resolves the active worker session for that goal, OR map agy's `conversationId` (present in PreToolUse stdin) → Orca sessionId. **Open subtlety for (c):** the orchestrator shadow session is *also* an agy process in the same workspace, so a workspace `PreToolUse` hook would fire for orchestrator tool calls too — confirm whether the orchestrator should be gated or the hook must scope to worker sessions only. Decide (b) vs (c) before implementing — it determines the workerHookConfig shape.
  - **Closing verification:** spawn a real antigravity worker via the live daemon (`daemon-terminal` tmux), trigger a tool, confirm `{decision:"deny"}` actually blocks and the payload maps correctly; then flip the contract to `verified:true`.
- ✅ **New-goal `operating_mode` default from the global setting — DONE (2026-06-26).** `createGoal` (`apps/daemon/src/goals.ts`) now reads `getSupervisionMode()` and maps it (`supervised → human_review`, `unsupervised → automated`), binding `operating_mode` on insert and in the returned `Goal` (which previously hardcoded `human_review`). `migrations/0041`'s column DEFAULT left in place as a fallback (already applied in the field; the insert is now explicit). Tests: `goals.test.ts` "createGoal operating_mode default".
- ✅ **Global supervision flip → default-only — DONE (2026-06-26).** The `/v1/settings` → `unsupervised` branch no longer calls the goal-unscoped `continueAllPausedSteps()`; the global setting is now purely the default for *future* goals, and per-goal `operating_mode` is the source of truth (flipped via `PUT /v1/goals/:goalId/operating-mode`, which scopes its own drain). `service.ts` unchanged — `continueAllPausedSteps` already supported the `goalId` filter. RED test in `server.test.ts` reproduced the bug (a parked `human_review` step was force-confirmed by the global flip).
- ✅ **`gate_approval_counts` retention — DONE (2026-06-26).** `archiveGoal` now reaps the goal's `gate_approval_counts` rows in its transaction via `deleteApprovalCountsForGoal` (new fn in the owning `harness-risk/accountability.ts`). Test: `goals.test.ts` "reaps the goal's gate_approval_counts rows on archive".
- ✅ **Coverage — DONE (2026-06-26).** The `canRemember` advertise already had route-level coverage (`server.permission-flow.test.ts` "pendingApproval.canRemember is true for claude-code, false for codex"). Added the missing route-level **relaxation `GoalDecision`** test: remember+allow records one confirmed `Gate relaxed:` decision; plain allow records none (`server.permission-flow.test.ts` "remember+allow records an auditable relaxation GoalDecision").

> **Exit criterion:** no worker provider spawns ungated; the global supervision flip and new-goal default both respect per-goal `operating_mode`.

---

# Phase 2 — Activate the Stateful axis

> Core P1+P2 already merged to `main` (StateDepsFacet, derived read/write-sets, deterministic conflict + belief-divergence detection). These are the deferred follow-ups that take it from *wired-but-inert* to *live*. Order matters: 2.1 makes divergence real; 2.2 makes the auto path reachable; 2.3–2.6 harden it.

- ✅ **2.1 Activate `belief_divergence` — DONE (2026-06-26).** It was inert for *two* reasons (the spec named one): workspace `branch:dirty` was null-encoded `":"` at launch, **and** `step_complete` built `currentVersions` by copying the step's own re-derived `version_deps` (self-vs-self, never diverges). Activated as **launch-snapshot vs. complete-current** (the semantics the `recordStepLaunchTransition` comment already documented): a new injectable sync `VersionProbe` + `probeWorkspaceForSession` (`harness-state/workspace-version.ts`) records the live workspace version at launch; `buildStepCompleteStateFacet` takes `self.version_deps` from this step's `step_launch` transition and builds `currentVersions` from a fresh live probe, so divergence fires when the workspace moved under the step. Falls back to live-derived deps (inert) when no launch snapshot exists. Used the **sync injectable prober** (not async `inspectWorkspace`) to match the surrounding sync fail-safe paths + write-set's `GitDiffer`, and to keep it unit-testable. Tests: `workspace-version.test.ts`, `step-complete.test.ts`, `service.agent-step.test.ts` (real-git launch snapshot).
- ✅ **2.2 Per-goal `conflict_policy` source — DONE (2026-06-26).** **Derived from `operating_mode`** (chosen over a `goals` column: a column with no writer/UI still defaults to a constant → not reachable e2e, defeating the exit criterion; and Appendix A keeps autonomy the binary L4/L5 with no independent conflict knob). `conflictPolicyForGoal` (`harness-state/conflict-policy.ts`): `automated → auto` (warn+proceed), `human_review → escalate` (pause); absent goal → `escalate` (safe floor). Both record sites call it. **Reachable e2e now** via `PUT /v1/goals/:id/operating-mode`. Tests: `conflict-policy.test.ts`; `service.agent-step.test.ts` Test E (automated → warn event + proceeds, no pause) + Test A corrected to `human_review` (its prior automated+escalate setup was an incoherent state the hardcode had masked).
- ✅ **2.3 Multi-workspace read/write-set selection — DONE (2026-06-26).** The authoritative per-step workspace is `sessions.workspace_id` (the launcher places the session there). Replaced the goal-`[0]` re-derivation with `probeWorkspaceForSession` at **both** belief-state sites — both key off the SAME step session (launch records it via the now-captured `launcher.launch()` sessionId; complete completes it), so they always agree on the workspace, which is what makes 2.1's divergence comparison sound for multi-workspace goals. No behavior change today (launcher still uses `[0]`, so `session.workspace_id == goal[0]`); removes the latent bug. The sensor-ladder `[0]` (`service.ts`, evidence facet) is out of scope — Phase 3, Executable axis.
- ✅ **2.4 `deriveWriteSet` git rename/copy parse — DONE (2026-06-26).** Extracted a pure exported `parseNameStatus` and split each `--name-status` line on tab taking the **last** segment (the destination) — correct for one-path (M/A/D) and two-path (R/C) lines. Directly unit-tested against real rename/copy output (the old test used a fake differ, so the real parse was never exercised).
- ✅ **2.5 `detectStateConflicts` coverage — DONE (2026-06-26).** Added the kind-discrimination test (file vs memory_item at the same ref → no collision) + the absent-ref→divergence test. Characterization only.
- ✅ **2.6 Refinement read_set kind — DONE (2026-06-26).** Added a distinct `"goal_refinement"` kind to `StateRefKind` (additive enum widening, no migration — the kind lives in the JSON facet); `deriveReadSet` now uses it instead of sharing the `decision` namespace.
- 🟡 **2.7 Enrich the `mark_done` terminal with roll-ups.** **(a) cumulative write-set — ✅ DONE (2026-06-26).** `mark_done` now declares `["telemetry", "stateDeps"]`; `buildGoalWriteSetRollup` (`harness-state/write-set-rollup.ts`) unions every `step_complete` write_set in the completing run, deduped by (kind, ref) with the latest change winning, bounded to the facet's 256-cap; `acceptRecommendation` threads it into `emitMarkDone`. Test: `write-set-rollup.test.ts` + a `usecases.test.ts` integration assertion. **(b) Goal-total cost — 🟡 still deferred (2026-06-27: remains gated)** — Phase 3 deferred the OTEL live smoke, and a sum over partial/null OTEL misleads until that smoke confirms cost is trusted. Land 2.7(b) immediately after the smoke passes (the `StateDepsFacet` roll-up from 2.7(a) already lands on `mark_done`, so this is the cost sum alongside it).

> **Exit criterion:** belief-divergence fires from live workspace state on a real run, and the conflict WARN/auto path is reachable end-to-end (not just unit-tested). **Status (2026-06-26):** all code landed + unit/integration covered (2.1–2.6, 2.7a; full daemon suite green). The WARN/auto half is reachable end-to-end through the real completion flow (Test E) + the `operating-mode` route. The "fires on a **real run**" half still wants a **live-daemon smoke** (rebuild/restart the daemon on this branch, run a real goal, mutate the workspace mid-step, confirm `belief_divergence` on `/harness-metrics`) — **pending**, not yet run.

---

# Phase 3 — Complete the Executable & Inspectable axes

Sensor ladder + observability. The Executable sensor work folds onto the `defSensor` registry from Phase 0.

## Executable axis

- 🟢 **P2/P3 sensors — ladder registration DONE (2026-06-27); capabilities still open.** The **full sensor ladder is now registered**: `static` (`static_analysis`→`static`) and `integration` (`integration_tests`→`test:integration`) joined the existing typecheck/lint/unit/build via `defineSensor` (`harness-sensors/detect.ts`), cost-ordered cheapest-first; `UNIMPLEMENTED_SENSOR_KINDS` is now empty and the conformance guard holds. *(Doc note: the prior "P1 shipped typecheck + unit only" was stale — `lint` and `build` were already registered before Phase 3.)* **Still deferred** (each its own seam): **oracle-adequacy enforcement** (`EvidenceFacet.oracleAdequacy` is computed at `runner.ts:74` but nothing vetoes on it yet), **artifact offload** of full sensor output (`artifactRef` is schema-only, always null), and **per-workspace declarative sensor config** with route-by-type feedback. Test: `detect.test.ts` (static/integration detection + ordering), `conformance.test.ts`.
- 🟡 **Per-ecosystem sensor resolvers** (Makefile / `cargo` / `pytest`, …). P1 auto-detects only `package.json` scripts. *(Note: `detect.ts` uses `npm run` while Orca workspaces are pnpm — works, a curiosity not a bug; see Appendix A.)* **Deferred-by-decision (2026-06-27):** no current workspace needs a non-npm resolver, so left additive per CLAUDE.md §2 — revive when a real consumer (a cargo/pytest workspace) appears.
- ✅ **`runCheckCommand` `MAX_BUFFER` raise — DONE (2026-06-27).** Raised 256 KiB → **8 MiB** (`readiness/exec.ts`). 256 KiB was small enough that a passing-but-verbose typecheck/test suite overflowed and — since a `max_buffer` result has no exit code, `runner.ts` scores it `failed` — produced a false veto. 8 MiB bounds memory while clearing real suites; full-output **artifact offload** stays the eventual home for unbounded logs (still deferred). Test: `exec.test.ts` (1 MiB now passes; 9 MiB still classifies `max_buffer`).

## Inspectable axis

- 🔴/🟡 **OTEL live end-to-end smoke not yet run — still PENDING after Phase 3 (deferred-by-decision 2026-06-27).** worker→receiver→accumulator→drain→facet remains asserted-by-construction only; Phase 3 left the live validation pending (it needs the daemon restarted on this branch + real Claude/Codex steps = the user's subscription, same hand-off as Phase 2's pending belief-divergence smoke). Run a live smoke (one Claude step + one Codex step → confirm non-null `telemetry.cost`); Codex struct-form `[otel.exporter."otlp-http"]` is the least-exercised branch. Note: Codex `mcp-server` spawn has no OTEL (interactive/`exec` only); antigravity has no usage channel → always `cost=null`. **Blocks the third exit-criterion clause and 2.7(b).**
- ✅ **`replay.ts` 10,000-row limit truncates the *oldest* transitions — DONE (2026-06-27).** Replaced the newest-first `LIMIT 10000` + reverse with a chronological (`created_at ASC, id ASC`) **keyset-paged** replay: `listTransitionsByGoalPaged` (`projection.ts`) backs `replayControlPlane(db, goalId, { cursor, limit })`, which returns a Zod-validated `ReplayPage` envelope (`@orca/contracts`) — `{ steps, page: { nextCursor, hasMore } }` with `seq` absolute across pages. `/v1/goals/:goalId/harness-replay` takes `?cursor`/`?limit`. A goal past one page now reconstructs from genesis forward instead of dropping its oldest history. Tests: `replay.test.ts` (oldest-first paging + created_at tie-break), `routes.test.ts` (HTTP `?limit`/`?cursor`).
- 🟡 **Codex telemetry gaps.** `durationMs`/latency left null (no duration in `codex.sse_event`; `turn_ttft`/`api_request` shapes uncaptured); Codex cost estimate doesn't price cache tokens. Plus deferred per-tool durations/errors, ttft, edit accept/reject, LOC/commit/PR counts. **Deferred-by-decision (2026-06-27):** the tractable-deterministic parts (parsing `turn_ttft`/`api_request` shapes) and the live-data parts (real Codex cache-token pricing, latency) are best landed *together against the OTEL smoke* rather than guessing shapes blind — revisit alongside the live smoke.
- 🟡 **Price map as a config source.** Static in-code table today; a config source is additive/deferred unless it churns.
- 🟡 **`prompt_ref` / `raw_output_ref` artifact offload.** Confirm where offloaded artifacts live (handles, not inline) before populating.
- ✅ **`/harness-replay` wire shape + `cost.ts` hardening — DONE (2026-06-27).** `/harness-replay` now returns a Zod-validated `ReplayPage` envelope (see the replay item above) — it was the only route exposing genuinely-raw facets. `cost.ts`: negative-token **clamp** added (`Math.max(0, …)`; `CostEntry` requires non-negative) and prefix-precedence locked with a characterization test (first-match on array order: `gpt-5-codex`→`gpt-5`). **Provenance/metrics/attribution envelopes intentionally skipped** — provenance is already parsed piece-by-piece on read (`HarnessTransition.parse` + `WorkflowGuardrailEvaluation.parse` + parsed decisions), and metrics/attribution return computed aggregates, not raw facets; a further top-level envelope would only re-validate already-validated data (CLAUDE.md §2, no validation for impossible scenarios).
- 🟢 **Feedback attribution scoped — DONE (2026-06-27); `recentFeedback` still dead.** The over-broad stamp is fixed: `recommendationFeedbackInterventions` (`dispatch-engine.ts`) now stamps only feedback created **since the previous `step_complete`** (`latestTransitionCreatedAt(db, goalId, "step_complete")` bounds a new `listFeedbackByGoalSince` query) instead of re-stamping the whole recent window on every `step_complete` — each feedback row now lands on exactly one step; the first step (no prior `step_complete`) still stamps all feedback so far. Test: `dispatch-engine.test.ts`. *(Note: `recommendations/input.ts` `recentFeedback` remains genuinely dead — it isn't even in the regeneration fingerprint, so reviving it needs a fingerprint change; still out of scope.)*
- 🟡 **Dropped `step_complete` transition emits no metric** (deferred to the TelemetryFacet phase).

> **Exit criterion:** the full sensor ladder runs, OTEL cost is confirmed non-null on a live two-provider run, and replay keeps the oldest transitions.
>
> **Status (2026-06-27, branch `phase-3-executable-inspectable` off `phase-2-stateful-axis`):** 2 of 3 clauses met **in code**, 1 **pending a live run** — honestly tracked, same as Phase 2's pending smoke.
> - ✅ *Full sensor ladder runs* — all six `WorkflowSensorKind` registered (3.3); each fires when its workspace declares the matching script.
> - ✅ *Replay keeps the oldest transitions* — keyset-paged, genesis-first (3.1).
> - ⏳ *OTEL cost non-null on a live two-provider run* — **cannot be met in code**; the worker→facet path is asserted-by-construction only and the live smoke was deferred-by-decision (needs daemon-on-this-branch + real agents). Blocks this clause and **2.7(b)**.
>
> Also landed this phase: `MAX_BUFFER` 8 MiB (3.2), `cost.ts` negative-token clamp + prefix test (3.5a), `/harness-replay` Zod envelope (item 5; provenance/metrics envelopes skipped as redundant), feedback attribution scoped to "since previous step_complete" (3.7). Deferred-by-decision: oracle-adequacy enforcement, `artifact_ref` offload, per-workspace sensor config, per-ecosystem resolvers (3.4), Codex telemetry gaps (3.6).

---

# Phase 4 — Surfaces & features on the harness

With the substrate locked and the four axes live, catch the surfaces up. These are largely independent of one another — order within the phase by what you're touching.

## Adapters & worker permission modes

- 🟡 **Antigravity native allow-list writer (Phase 4 of permission modes).** The Phase-1 item wires the *gate* (safety floor); this is the separate follow-on: `PreToolUse`/`request-review` shaping + native allow-list persistence so `writePermissionRule` stops being a no-op.
- 🟡 **Rename `ShadowProvider` → a shared `AgentProvider`** interface (noted as a future generalization in the `workerHookConfig` doc-comment).
- 🟡 **Codex hook-trust persistence** as an alternative to `--dangerously-bypass-hook-trust` ("not explored"); the assumed 600s hook-timeout default remains unverified (only the per-hook `timeout` key was live-verified).

## Workflow step results & supervised completion

- 🟡 **Revision-signal consumer.** `step_revision_signals` is populated but nothing reads it. *Canonically owned by the Phase 5 learning loop (5.2) — listed here only as the data-capture pointer.*
- 🟡 **Telemetry counters** (`total_turns` / `tool_calls` on `WorkflowStepResult.performance`) stay optional until a reliable system source exists.
- 🟡 **Scoring fill-rate eval gate** — no prompt-eval harness; fill-rate observed in practice post-ship.
- 🟡 **Verbatim confirmation `lead` capture** — deferred; lead is rebuilt from `resultSummary ?? outcome.reason`, not snapshotted at confirm time.
- 🟡 **Run-pinning UI / template version history** — no "pinned to version N" view, no historical-version store; backfilling snapshots for pre-migration runs is out of scope.
- 🟡 **Output-schema object-level descriptions** — the shorthand grammar restricts rather than round-trips them on multi-line objects; `onValidityChange` save-gating polish was left optional.
- 🟡 **Step terminal-event payload carrying full `stepResult`** — left conditional on the workflow event payload budget; events may carry identifiers only with consumers fetching the step run.

## OrcaChat conversational surface

- 🟡 **Codex (and other adapters) support for the activity thread** — v1 is Claude-only; validate the provider-neutral contract against the Codex hook adapter. Reasoning-note extraction is likewise Claude-Code-transcript-specific (silent no-op otherwise).
- 🟡 **Full mark-done card wiring** — `mark_done_ready` maps to a `completed`/`paused_for_input` activity but is stubbed, not fully wired.
- 🟡 **Wire the orchestrator's own shadow-session hooks into the persisted activity stream** — the routing card stays synthetic/transient.
- 🟡 **Auto-collapsing completed activity cards** to a summary line — deferred; "revisit if scroll length becomes a problem."
- 🟡 **Optional `(Recommended)` badge detection** at render time (best-effort heuristic on Claude's label convention).
- 🟡 **Reasoning-note volume / throttling** — if notes feel noisy in practice, summarize/throttle them (`server.ts onToolUse` / `activities/transcript.ts`). *(Same concern recurs for the Brainstorm surface below — fix once, generally.)*

## Graph routing, provider recovery, ledger & daemon addressing

- 🟡 **Desktop ledger rendering** beyond the daemon read route (Inspectable-style UI for the committed ledger).
- 🟡 **Daemon addressing — remote daemon.** Only the discovery-file/resolver seam exists; the remote endpoint + token refresh plug in later with no worker changes.
- 🟡 **Client-triggered re-adopt/respawn when daemon health is lost mid-use** — described (`lib.rs`) but has no dedicated automated test (manual smoke only).
- 🟡 **Prod-SEA packaging / Node availability** for the cross-platform resolver script; Windows file-permission handling is best-effort (chmod skipped).
- 🟡 **Phase-2 ledger open decisions to confirm against live code:** exact transaction structure for atomic ledger-commit + `step_output` + advance (async review kept outside the sync txn); always-commit empty ledger versions vs only non-empty; whether orchestrator review uses a real broker correction pass or the deterministic normalizer alone.

## Templates, onboarding & splitter

- 🟡 **Phase-2 platform-managed ledger for templates** (the `<orca:step-complete>` envelope, versioning, canonical-ID allocation, orchestrator review) — see the ledger items above; the Feature-Development template runs without it.
- 🟡 **Future template categories** (Product, Design, …) — grouping is data-driven/additive but only `Engineering` exists today.
- 🟡 **Initiative Implementation `INITIATIVE_GRAPH` validity** and the catalog reconcile test's `goals` insert columns — confirm against the real schema during execution; check for lingering references to the removed `orca/engineering` / `orca/feature-development` seeds.
- *(The Fan-out / fan-in primitive that used to live here is the same delegate seam as Phase 5.1 — owned there.)*

## Honest, participatory brainstorm

- 🟡 **Rewrite the other workflow instructions** (Feature, Bug, Refactor, Initiative, Quality, Code Review) for honest/participatory behavior — only Brainstorm's instructions were rewritten; the rest inherit only the engine/UI changes.
- 🟡 **Opening the result-card artifact** in the filesystem/editor (renders as text/title only today). *(Reasoning-note throttling here is the same concern as the OrcaChat item above.)*

## Workspaces

- 🟡 **Goal-creation workspace picker** — the entire `2026-06-21` spec (pick from registered workspaces instead of browsing the filesystem at goal creation; `create-goal-flow/state.ts`, `steps/CoordinateStep.tsx`, `CreateGoalFlow.tsx`, `App.tsx`) was design-only ("no code yet"), not yet implemented. Open question: empty-state link landing depth (auto-open the add-workspace modal vs just land on the Workspaces tab — defaulted to the latter).

> **Exit criterion:** the conversational, adapter, template, and workspace surfaces no longer lag the substrate — each consumes the harness facets/boundaries directly rather than via synthetic/transient shims.

---

# Phase 5 — Composition, learning & autonomy

Design proposals harvested from an engine design review, **not commitments** — re-verify anchors and re-decide scope before acting. The throughline is two levers Orca has the prerequisites for but hasn't pulled — **composition via a delegate seam** and **learning from execution evidence** — plus the **L4→L5 autonomy crossing**. All deliberately scoped to stay within Orca's worldview (TypeScript, deterministic engine, the engine owns the lifecycle).

- 🟡 **5.1 Sub-workflow composition — a `workflow` operator / delegate seam (highest-payoff item).** Templates are flat graphs today: `OperatorKind = z.enum(["agent","model","human"])` (`packages/contracts/src/workflows/index.ts:119`), graph nodes are `step|gate|splitter` only, steps cap at `max(20)`, and no node can reference another template id. The lever is a *central graph that delegates to independently-versioned sub-graphs*: a delegate node spawns a child that runs with an **isolated state space**, parent values mapped in via an explicit `reads` contract and back out via `writes`, with full lineage. **This is the same primitive the Fan-out / fan-in idea needs** (parent↔child run relationships + a dynamically materialized executed graph); land the single-child delegate seam first, then fan-out is the same seam over N tasks. Orca already has the hard prerequisites — immutable `template_snapshot_json`, versioned templates, the node cursor (`runs/projection.ts`), branch-source-agnostic terminal-reachability validation. **Resume:** add a `workflow`/`subworkflow` operator kind (or a graph node targeting another template snapshot) that spawns a child `WorkflowRun` with an explicit `reads`/`writes` contract, links it parent↔child, and maps results back at a join.
- 🟡 **5.2 Close the learning loop from captured evidence.** Orca already *captures* the evidence and drops it: `step_revision_signals` is populated (`workflows/revision-signals/store.ts:4`, written at `service.ts:1612`) but only read back by `listRevisionSignals` (the "Revision-signal consumer" pointer in Phase 4); and `scoreStepResult` (`workflows/orchestrator/step-result-scoring.ts:42`) records per-step quality scores that nothing consumes. **Resume:** a reflective optimizer that mines a template's own accumulated revision signals (superseded scoring + user feedback) to propose edits to *that template's* step `instructions`. Stays inside Orca's boundary — **per-template, not cross-goal** (cross-goal/global memory remains a non-goal). Ship it **opt-in and gated**: this kind of evidence-mining loop is reliable mainly in-distribution, so propose-and-confirm, never silent template mutation.
- 🟡 **5.3 Make the gate the loop's objective + wire the LLM gate-evaluator (the L4→L5 seam).** Orca is most of the way there: a rejecting gate already surfaces `{reason, issueRefs}` as `repairContext` injected into the re-run prompt (`latestRejectingGate`, `service.ts:1362,2583`; asserted in `service.gate-routing.test.ts`), and gate criteria are runtime-derived from goal + ledger + instructions. The gap: gates are resolved **only by a human** today (`service.ts:3795`; `parkForGateApproval` `:3800`, `decideGate` `:4131`) — yet the full `GateEvaluationRequest`/`GateEvaluationProposal` contract is already built and unwired (`packages/contracts/src/workflows/index.ts:784-812`). Derive the gate from the goal, branch on the verdict, route the **failing criterion** to the closing step (Orca's backward-edge routing already does this), and **terminate honestly** when a goal is unachievable rather than spinning. **Resume:** wire the dormant evaluator to drive gates in `operating_mode = automated` (L5) while keeping the human verdict for `human_review` (L4). This is the natural place the Governed axis crosses from supervised to autonomous.
- 🟡 **5.4 Verify both halves — independent/adversarial check on self-reported scoring.** Step completion is hybrid-gated (deterministic schema validate → LLM judge), which is sound — but the `approve_step_complete` *scoring* block (outputCompleteness/correctness/instructionAdherence/downstreamReadiness/riskLevel, `orchestrator-llm/prompts.ts`) is **self-reported by the same orchestrator-LLM that approves the step**. A green deterministic skeleton wrapped around garbage LLM output is still a failure. **Resume:** for high-risk steps (reuse the existing harness risk classifier so this is **risk-gated, not universal**), add a cheap second-model pass prompted to *refute* the completion, gating the approve. Reuse the broker plumbing that already serves splitter/gate evaluation.
- 🟡 **5.5 Reasoning-first ordering on structured orchestrator outputs.** Have every LLM node emit a `reasoning` field *first*, before the structured payload (chain-of-thought as schema structure, not a bolted-on paragraph). **Resume:** audit the orchestrator-LLM's discriminated `OrchestratorAction` + scoring schema (`orchestrator-llm/prompts.ts:85-118`) to confirm a reasoning field is required and ordered *before* the verdict and the 0..1 dimensions; reorder if not. Near-zero-cost prompt-schema change.

> **Exit criterion:** the delegate seam runs a child workflow with an isolated state space; the learning loop proposes (never silently applies) template edits; and a gate can drive itself to a verdict in L5 while L4 keeps the human.

---

# Appendix A — Non-goals & decided-against

⚪ Intentional non-changes. Do **not** "fix" these without re-deciding — grouped by area.

**Governed / safety**
- **Real OS containment (`SpawnSandbox`).** The seam exists as a default no-op pass-through (`apps/daemon/src/adapters/sandbox.ts`); actual OS sandboxing (macOS `sandbox-exec` / Linux namespaces+seccomp / Windows) is explicitly out of scope. Agents run in the real repo with inherited credentials.
- **`classify.ts` `\bnc\b` over-match** (errs fail-safe / over-escalates); the **double-namespaced `operator:agent:claude-code` risk label** (revisit only with a real operator taxonomy — change producer + matcher together); the **inert `autonomyLevel` column** (SQLite column drops are messy; left in place).
- **Autonomous Evolution Agent / self-modifying harness (L5)** — explicit non-goal; only the read-side failure-attribution substrate (categorical codes + clustering) is in scope.
- **Cross-goal / global memory** — non-goal; experiential memory stays within per-goal templates (this also bounds the Phase 5.2 learning loop to per-template).
- **LLM-authors-and-runs-the-workflow-at-runtime** — the opposite of Orca's load-bearing rule that the engine owns the lifecycle and the LLM never gets tool-call freedom to advance steps.

**Stateful axis**
- **LLM semantic conflict-judge.** Only the no-op `ConflictJudge` seam shipped (`noopConflictJudge` keeps every overlap as a real conflict). An LLM judge gated behind the deterministic overlap signal (reusing the `SessionMemoryExtractor` seam) is a documented later drop-in — no LLM call today.
- **Sibling-session summaries in launch read_set** deliberately omitted (`summaries: []`, no exported reader exists).
- **No pessimistic locking, no auto-merge, no cross-goal state** — optimistic detect-don't-prevent is the chosen model.

**Executable axis**
- **`detect.ts` uses `npm run`** while Orca workspaces are pnpm — works, noted as a curiosity, not a bug.

**Inspectable axis**
- Full event-sourcing of all Orca state; external OTEL collector / Prometheus-Grafana; per-subagent within-worker token attribution; cross-run/global dashboards beyond per-goal `/harness-metrics`.

**Adapters & permission modes**
- **Codex per-command "remember" / `writePermissionRule`** — Codex uses a global `approval_policy`, no per-command rule; stays a no-op.
- **Persisting *deny* decisions** — only `allow` + `remember` writes a rule.
- **Orca-maintained permission allow-list ("Strategy A")** — abandoned; relies entirely on each CLI's native residual-permission event.
- **Direct Google API model provider** (non-agent orchestration) — explicit non-goal of the antigravity adapter; `orca/google` is agent-backed metadata only.
- **Pending approvals are in-memory only** — do not survive a daemon restart (accepted tradeoff).

**Workflow step results & autonomy**
- **Per-goal supervision override** and **finer-grained autonomy gradations** — autonomy stays the binary Supervised (L4) / Autonomous (L5) `operating_mode`; the dormant `goals.autonomy_level` integer is left inert.
- **Parallel/concurrent step execution** — multi-cursor traversal and join semantics out of scope (validation is written fan-out-ready; steps stay single-outgoing-edge).
- **DB migration of existing user templates** for the new terminal-reachability rule — validation applies only on next edit. No step-level `terminal` marker on the step contract (graph node `terminal` is the single source of truth).

**OrcaChat**
- **LLM polish of Orca-voiced worker-question text** — deterministic templating only for v1.
- **No retro-migration of worker questions** already pending at upgrade time — they keep the old activity shape. Orchestrator `ask_user` questions and permission approvals are unchanged by the free-text / persist-answered arcs.
- **`git diff`-based diff capture** and a **per-turn consolidated "Changes" card** — rejected in favor of hook-reconstructed per-edit diffs.

**Graph routing, provider recovery & daemon addressing**
- **Provider-recovery non-goals:** automatic provider switching in Auto-run, predicting quota availability when the provider doesn't report it, sharing native conversation state across providers, billing/quota-purchase flows.
- **Daemon-addressing out of scope:** retrofitting in-flight workers (they age out); auto-stop / idle daemon shutdown (explicit stop + OS logout only).

**Templates, onboarding & splitter**
- **Roles / `roleLabels`** — out of scope across catalog and onboarding (display metadata only; no role model, no role chips).
- **Per-template enable/disable after install**, **cross-goal knowledge graph**, and **visit-limits / loop caps on routing** — explicit non-goals. The "Feature Development → Feature Implementation" rename lands only on fresh inserts (version-guarded upsert).

**Brainstorm**
- **No visible gate node for the open-questions check** (enforced as a completion invariant), **no per-item blocking-vs-note agent classification** (the step's `completionPolicy` decides), and **scoring math / quality dimensions unchanged**.

**Workspaces (out of scope v1)**
- Delete-workspace mutation; live-session indicators/counts on goal cards & workspace rows; associating an existing goal to a workspace from the Workspaces tab; workspace color/icon/slug; persisted live git state on the entity; a pre-submit liveness check for moved/deleted registered folders (the daemon's submit-time re-inspect is the only guard).

---

# Appendix B — Reference & hygiene

### ORCA.md hygiene

The harness-axes spec called for correcting materially-stale ORCA.md claims; the verified ones (three adapters not two, `orca/adaptive-delivery` not `orca/engineering` as default, ~32 KiB not 64 KiB context envelope, per-goal `operating_mode` superseding the 5-level `autonomyLevel` at runtime) have been applied. A few subtler claims were **not** independently verified and are left as-is pending a code check: the memory lifecycle tiers (`observed → extracted → promoted → canonical`), the "reconstruct a Goal by replaying its events" claim, and the "LLM-driven extraction" framing. Verify against current code before trusting or editing them.

### Known test flakes (acknowledged, not root-caused)

- `http-surface.test.ts` and `human-review.test.ts` (15s timeout) — time out under parallel load, pass in isolation.

### Typecheck gate blind spot (hygiene)

- ✅ **`noUnusedLocals` — DONE (2026-06-26).** The daemon tsconfig now enables `noUnusedLocals` (in `apps/daemon/tsconfig.json`'s own `compilerOptions`, scoped to the daemon), closing the orphaned-import blind spot that the 0.2 decomposition relied on review to catch. The focused pass removed 60 dead symbols across 25 files. `noUnusedParameters` is deliberately still OFF (it has intentional unused-param hits — out of scope). Note the residual gap: `noUnusedLocals` does **not** flag unused module-level *exports* (this is how the orphaned `selector.ts` slipped the gate — caught only by the whole-branch reviewer).
