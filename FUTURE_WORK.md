# Future Work

Outstanding, deferred, and explicitly-out-of-scope items, harvested from the plan/spec documents that drove Orca's evolution (now retired — the durable narrative lives in `ORCA.md` §14). This is a backlog of *what was deliberately left undone with enough context to resume*, not a roadmap commitment. File references are best-effort pointers from the source docs and should be re-verified against current code before acting.

**Status hints:** 🔴 blocked on external info · 🟡 deferred by decision · ⚪ intentional non-change (do **not** "fix" without re-deciding — all ⚪ items live in [Appendix A](#appendix-a--non-goals--decided-against)).

## How this is sequenced

Work runs **from the substrate up**: lock the harness spine so it can't structurally drift, then activate each harness axis in turn, then catch the surfaces up, then pull the autonomy levers. Each phase has an **exit criterion** — the signal that the substrate is solid enough to start the next phase. You can walk the phases top-to-bottom; within a phase, items are ordered so the foundational ones come first.

| Phase | Theme | Exit criterion |
|---|---|---|
| **0** | Lock the spine | Substrate is runtime-enumerable; the engine is modular along its natural seams; no facet is hand-synced. |
| **1** | Close the Governed axis | No ungated worker path exists; supervision settings behave correctly per-goal. |
| **2** | Activate the Stateful axis | Belief-divergence is live end-to-end; the conflict WARN/auto path is reachable. |
| **3** | Complete Executable & Inspectable | Full sensor ladder; OTEL verified on a live run; replay is correct. |
| **4** | Surfaces & features on the harness | The conversational/adapter/template/workspace surfaces are caught up to the substrate. |
| **5** | Composition, learning & autonomy | The delegate seam and learning loop exist; the gate can drive itself in L5 (the L4→L5 crossing). |

> **Guiding concern (applies to every phase).** Each architectural decision in Orca is individually defensible, but the sum — four harness axes × four facets × four boundaries × three adapters × graph-routed templates × recovery state machines × a versioned ledger, much of it converging in one daemon and one engine file — is a large surface area for a small team. The risk is good calls outpacing the capacity to keep them all correct (the ungated antigravity path in Phase 1 is the first visible instance). **Bias toward consolidation over new axes until the spine is runtime-enumerable and the engine is modular** — which is exactly what Phase 0 buys.

---

# Phase 0 — Lock the spine

The harness spine works but is **hand-wired**, so the substrate can structurally drift. This phase consolidates it behind self-registering registries and modularizes the engine that drives it. Nothing above this should race ahead of a substrate that can drift. **No behavior change in this phase** — pure consolidation, justified by present duplication and leaning on existing harness/orchestrator test coverage.

### 0.1 — Harness substrate factory: facet / boundary / sensor registries — ✅ DONE (2026-06-25)

Shipped all three self-registering registries (`defineFacet`/`defineBoundary`/`defineSensor`) + load-time/test conformance guards + the `GET /v1/harness/registry` introspection route. The `defBoundary` emit factory is the sole sanctioned transition write path; validate-on-write closed the unvalidated-write gap; the dormant `mark_done` boundary now fires on human-accepted completion (carrying a minimal TelemetryFacet — see deferred roll-ups in **2.7**); the `integration`/`static` sensor drift is now explicit-unimplemented. Spec + plan: `docs/superpowers/specs/2026-06-25-harness-substrate-registries-design.md`, `docs/superpowers/plans/2026-06-25-harness-substrate-registries.md`.

### 0.2 — Decompose `OrchestratorService` (~4,645 lines)

🟡 The entire mediation engine — dispatch, provider recovery, judgement, scoring, ledger commit, gate/splitter routing — lives in one class (`workflows/orchestrator/service.ts`). It is the most safety-critical module in the system yet the largest and hardest to review; a 4.6k-line file is where latent bugs hide, and at L4/L5 those execute *past* a human gate. **No behavior change** — extract along the natural seams as collaborator modules/units, **one seam per PR**, leaning on the existing orchestrator test suite as the behavior-preservation guard. Pattern: free-function modules for internal helpers (delete the private methods, repoint call sites — no forwarding stubs); a standalone unit where there's a public surface with held deps.

- ✅ **Step scoring & result building** — DONE (2026-06-25). Extracted to `step-result-builder.ts` (free fns); 5 methods deleted, call sites repointed. Spec/plan: `docs/superpowers/specs|plans/2026-06-25-orchestrator-decomposition-ab*`.
- ✅ **Provider recovery** state machine — DONE (2026-06-25). **Lifted entirely out** into a standalone `ProviderRecoveryController` (server.ts calls it directly; the 7 methods left `OrchestratorService`), depending on a new **`RunnerPort`** — the execution-plane capability surface = the in-process precursor to FUTURE_ARCHITECTURE's Runner Protocol. Two pure shared helpers extracted to `repair-context.ts`. The now-unused `workerWait` constructor param was removed.
- ✅ **Ledger commit (pure trio)** — DONE (2026-06-25). `completeStepWithLedger`/`commitStepOutputAndLedger`/`createStepOutputArtifact` extracted to `ledger-commit.ts` (free fns, zero `this.*`, no deps object); call sites repointed.
- ✅ **Shared DB-row access** — DONE (2026-06-25). `GoalRow`/`StepRunRow`/`readGoal`/`readStepRun`/`preferencesForGoal` + the two reader error classes consolidated into `db-rows.ts` (imports from no orchestrator file → no cycle); closes the prior `step-result-builder`/controller type-duplication. A concrete step toward FUTURE_ARCHITECTURE's storage-provider seam (raw row reads now centralized). Spec/plan: `docs/superpowers/specs|plans/2026-06-25-orchestrator-decomposition-cd*`.
- ⚪ **Advance/route engine — intentionally kept whole.** `commitAdvanceOrComplete` + gate/splitter routing (`parkForGateApproval`, `evaluateAndParkSplitter`, `routeGateDestination`, `decideGate`, `confirm*`) is the orchestrator's irreducible dispatch core: it recurses into `requestNextDecision`/`spawnStepAgent` with a `routeGateDestination ⇄ evaluateAndParkSplitter` cycle. Extracting it piecemeal needs ~7 injected callbacks (incl. the methods it recurses into) — a pass-through, not a seam. FUTURE_ARCHITECTURE: "deterministic code owns lifecycle, routing, gates" (one core). Documented in a code-comment on `commitAdvanceOrComplete`; do **not** force-extract.
- ✅ **DispatchEngine split — DONE (2026-06-25).** The cohesive advance/route engine (`requestNextDecision`, `advanceToNextStep`, `commitAdvanceOrComplete`, gate/splitter routing, `spawnStepAgent`, `blockRun`, the commit/decision plumbing — ~22 methods) is now its own `DispatchEngine` class (`dispatch-engine.ts`); `OrchestratorService` is the event-handler/reaction layer (`onWorkflowSessionCompleted`/`onSessionOutputChunk`/`onAgentResponseDone`/`onUserMessage`/`confirmStep`/`reviseStep`/revisions/…) that calls the engine via `this.engine`. The boundary is **acyclic** (handlers→engine; no engine method calls a handler); the engine is the paper's "Control Unit." Done as a transitional-delegate two-step (Phase 1 narrowed the seam, then introduce-engine-with-delegates, then remove-delegates) for safety. `service.ts` ~4,641 → ~1,807 across the whole 0.2 arc; the engine is ~1,970 in its own file. Spec/plan: `docs/superpowers/specs|plans/2026-06-25-dispatchengine-phase2-split*` (+ phase1-narrow-seam).
  - 🟡 *Follow-up (non-blocking):* the shared types/errors (`RequestNextDecisionOptions`, `StepDispatchCapabilities`, the `Orchestrator*Error` classes) now originate in `dispatch-engine.ts` and are re-exported from `service.ts`; `ledger-commit.ts`/`orchestrator-message.ts` import the *type* back from `service.js` (`import type`, erased — no runtime cycle, but a latent cycle-shaped seam). Lift them into a small `dispatch-types.ts` (or `errors.ts`) that both classes + the leaf modules import directly. Also: the 4 pure-engine test helpers name the `DispatchEngine` local `service` — rename to `engine` for clarity when next touched.
  - ✅ **Phase 1 (narrow the seam) — DONE (2026-06-25).** Extracted the pure shared utility/query helpers to free-fn modules (`queries.ts`: `stepRunIdsByTemplateId`/`artifactCountForStep`/`retryCount`/`hasActiveUnansweredQuestion`/`readStepOutputAsRecord` + `publishStaged`; `orchestrator-message.ts`: `postOrchestratorMessage`) and dropped the dead `operatorSelector` constructor param + its route-deps/server/guard threading — tightening Phase 2's engine interface to ~8 graph-operation methods. Spec/plan: `docs/superpowers/specs|plans/2026-06-25-dispatchengine-phase1-narrow-seam*`.
  - 🟡 **Follow-up: finish the `operatorSelector` excision.** `daemon-context.ts` still constructs `new OperatorSelector(...)` and exposes `DaemonContext.operatorSelector`, but after Phase 1 nothing reads it (the orchestrator was its last consumer). Drop the field + construction + the `OperatorSelector` class/import if no other consumer claims it. Left undone in Phase 1 to respect its scope (pre-existing code).
- ~~**Harness transition emit sites**~~ — ✅ DONE in 0.1 (the `defBoundary` emit factory replaced all 5 string-literal sites; `recordHarnessTransition` is now internal to the factory).

### 0.3 — Per-adapter hook-readiness contract check

🟡 **Third-party hook dependence is the deepest structural risk.** The orchestration foundation rests on undocumented, can-change-anytime CLI hook behavior (e.g. the verified "Codex hooks fire only in the interactive TUI, never `codex exec`"; the unverified 600s hook-timeout default). The `workerHookConfig()` seam + `supportsPermissionPersistence` localize the blast radius, but the *dependence* can't be abstracted away. Add a thin per-adapter readiness/contract check that **fails loud if a provider's hook surface drifts** (event name / payload shape / firing context), so a silent upstream change surfaces as a readiness failure rather than silently-stuck goals.

> **Exit criterion:** the substrate is runtime-enumerable (e.g. `GET /v1/harness/registry`), every facet/boundary/sensor flows through its registry, the engine is split along the seams above, and an adapter hook drift fails loud instead of silent.

---

# Phase 1 — Close the Governed axis

The harness Governed axis is complete *except* for the items below — the first being a genuine safety hole.

- 🔴 **Antigravity worker permission gate (the one open coverage gap).** `agy` workers spawn **ungated / fail-open** — no risk classification, no `tool_gate` transition, no safety floor; claude-code and codex *are* gated. `workerHookConfig` is a `{files:[], spawnArgs:[]}` stub in `apps/daemon/src/orchestrator-llm/providers/antigravity.ts`. **Blocked on 4 unknowns** from the `agy` CLI/source: the permission-hook **event name**, the **hook-file JSON shape + on-disk path** `agy` reads, the **discovery mechanism** (env var / flag / cwd), and the **stdout decision schema**. **Resume:** implement `workerHookConfig` mirroring Codex's resolver wiring, flip the `worker-hook-config.test.ts` assertion (currently asserts the empty stub), keep `permissionRule`/`writePermissionRule` no-ops for now (native allow-list persistence is the separate Phase 4 follow-on). Also validate the antigravity `request-review` / `PreToolHookResult` overwrite edge case.
- 🟡 **New-goal `operating_mode` default from the global setting.** `migrations/0041` hardcodes the column DEFAULT to `'human_review'` and goal creation ignores the global orchestrator-tab setting. Wire `createGoal` (`apps/daemon/src/server.ts`, `/v1/goals/:goalId` create path) to inherit the "default for future goals" value.
- 🟡 **Global supervision flip → default-only.** The `/v1/settings` flip to `unsupervised` still calls `continueAllPausedSteps()` with no `goalId`, draining parked steps for *every* goal including `human_review` ones (`confirmStep` doesn't re-check mode). Make the global flip default-only (stop force-confirming existing goals). In `server.ts` (`/v1/settings`) + `workflows/orchestrator/service.ts`.
- 🟡 **`gate_approval_counts` retention.** Grows one row per `(goal_id, action_class)` with no reaper; consider cleanup on goal archive. Low concern.
- 🟡 **Coverage:** route-level test for the `canRemember` advertise + the relaxation `GoalDecision` (only module-level + inspection coverage today).

> **Exit criterion:** no worker provider spawns ungated; the global supervision flip and new-goal default both respect per-goal `operating_mode`.

---

# Phase 2 — Activate the Stateful axis

> Core P1+P2 already merged to `main` (StateDepsFacet, derived read/write-sets, deterministic conflict + belief-divergence detection). These are the deferred follow-ups that take it from *wired-but-inert* to *live*. Order matters: 2.1 makes divergence real; 2.2 makes the auto path reachable; 2.3–2.6 harden it.

- 🟡 **2.1 Activate `belief_divergence` (ships wired but INERT).** Step launch records workspace `branch:dirty` as null-encoded `":"`. Populate real `branch:dirty` via `inspectWorkspace` (`workspaces/inspect.ts`) at **both** the step_launch site (`service.ts` ~3251) and the step_complete site, building `currentVersions` from live inspect.
- 🟡 **2.2 Per-goal `conflict_policy` source.** Today hardcoded to the constant `"escalate"`, so the WARN/auto path is unit-tested but not reachable end-to-end. Either add a `goals` column (migration `0043` + the 4 `migrations.test.ts` snapshot enumerations) or derive from `operating_mode` (automated→auto, human_review→escalate).
- 🟡 **2.3 Multi-workspace goals: read/write-set workspace selection.** `deriveWriteSet`/read-set pin to the *first* attached workspace (`listWorkspacesByGoal[0]`) in `service.ts`; records the wrong workspace's set if a step targets a different attached workspace. Matters once belief-divergence is live.
- 🟡 **2.4 `deriveWriteSet` git rename/copy parse bug.** Real `git diff --name-status` rename/copy lines (`R100\told\tnew`, two tabs) parse the destination as a tab-embedded ref instead of the path. Fix: split remaining on tab, take last segment. Untested against real git output.
- 🟡 **2.5 `detectStateConflicts` coverage gaps.** Absent-version→divergence semantics and `kind:ref` discrimination (file vs memory_item at same ref → `[]`) are correct-by-inspection but untested; add a kind-discrimination test + an absent-ref test.
- 🟡 **2.6 Refinement read_set kind-namespace collision.** A refinement read_set entry maps to `kind:"decision"` ref:`goalId`, sharing the decision namespace with real decisions (pre-existing namespace-impurity risk).
- 🟡 **2.7 Enrich the `mark_done` terminal with roll-ups.** Phase 0.1 fires `mark_done` (the harness ledger's terminal boundary) carrying a *minimal* TelemetryFacet — `outcome.status="succeeded"` + a `human_interventions` sign-off record. Two enrichments were deliberately scoped out of 0.1 (they're new aggregation capabilities, not consolidation): **(a) cumulative write-set** — a `StateDepsFacet` roll-up of everything the Goal changed across all its steps; the highest-value "what did this Goal actually do" signal and ideal fuel for the 5.2 learning loop. **(b) Goal-total cost** — sum each step's telemetry cost into the terminal facet, but only once OTEL telemetry is trustworthy (Phase 3: live OTEL smoke unrun, Codex cost gaps, antigravity always null), since a roll-up over partial/null data misleads.

> **Exit criterion:** belief-divergence fires from live workspace state on a real run, and the conflict WARN/auto path is reachable end-to-end (not just unit-tested).

---

# Phase 3 — Complete the Executable & Inspectable axes

Sensor ladder + observability. The Executable sensor work folds onto the `defSensor` registry from Phase 0.

## Executable axis

- 🟡 **P2/P3 sensors.** Full sensor ladder + lint/static sensors, oracle-adequacy enforcement, artifact offload of full sensor output (`artifact_ref`), and sensors as per-workspace declarative config with route-by-type feedback. P1 shipped typecheck + unit + veto only. *(Register new kinds via `defSensor`.)*
- 🟡 **Per-ecosystem sensor resolvers** (Makefile / `cargo` / `pytest`, …). P1 auto-detects only `package.json` scripts. *(Note: `detect.ts` uses `npm run` while Orca workspaces are pnpm — works, a curiosity not a bug; see Appendix A.)*
- 🟡 **`runCheckCommand` `MAX_BUFFER` raise (256 KiB).** Too small for verbose suites; a sensor tripping `max_buffer` is conservatively treated as failed (P2.5 follow-up).

## Inspectable axis

- 🔴/🟡 **OTEL live end-to-end smoke not yet run.** worker→receiver→accumulator→drain→facet is asserted-by-construction only. Run a live smoke (one Claude step + one Codex step → confirm non-null `telemetry.cost`); Codex struct-form `[otel.exporter."otlp-http"]` is the least-exercised branch. Note: Codex `mcp-server` spawn has no OTEL (interactive/`exec` only); antigravity has no usage channel → always `cost=null`.
- 🟡 **`replay.ts` 10,000-row limit truncates the *oldest* transitions** — the wrong end to drop for a replay. Keep oldest, or paginate.
- 🟡 **Codex telemetry gaps.** `durationMs`/latency left null (no duration in `codex.sse_event`; `turn_ttft`/`api_request` shapes uncaptured); Codex cost estimate doesn't price cache tokens. Plus deferred per-tool durations/errors, ttft, edit accept/reject, LOC/commit/PR counts.
- 🟡 **Price map as a config source.** Static in-code table today; a config source is additive/deferred unless it churns.
- 🟡 **`prompt_ref` / `raw_output_ref` artifact offload.** Confirm where offloaded artifacts live (handles, not inline) before populating.
- 🟡 **Slimmer `/harness-replay` wire shape.** Route exposes raw `RiskFacet`/`EvidenceFacet`/`TelemetryFacet`; no Zod envelope on provenance/replay responses; prefix-precedence and negative-token clamp untested in `cost.ts`.
- 🟡 **`recommendations/input.ts` `recentFeedback` is genuinely dead** (only feeds the regeneration fingerprint); reviving it needs a fingerprint change (out of scope). Also feedback refs are stamped on every `step_complete` (over-broad) — scope to "since previous transition" or de-dup at attribution.
- 🟡 **Dropped `step_complete` transition emits no metric** (deferred to the TelemetryFacet phase).

> **Exit criterion:** the full sensor ladder runs, OTEL cost is confirmed non-null on a live two-provider run, and replay keeps the oldest transitions.

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

- The daemon tsconfig chain does **not** enable `noUnusedLocals`/`noUnusedParameters`, so `tsc` does not flag orphaned imports/locals. The 0.2 decomposition leans on "delete method → repoint → remove orphaned imports" with green typecheck as the safety net — but orphaned *imports* are invisible to that gate (one slipped through in the C/D ledger extraction and was caught only in review). Consider enabling `noUnusedLocals` (+ `noUnusedParameters`) to close the blind spot; do it as a focused pass (it will surface pre-existing unused symbols across the daemon).
