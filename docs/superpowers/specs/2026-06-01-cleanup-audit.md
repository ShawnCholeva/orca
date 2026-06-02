# Cleanup Audit

## Baseline

- SHA: 81bcc32
- Date: 2026-06-01
- Tests:
  - packages/contracts: 7 files passed, 124 tests passed
  - apps/daemon: 192 files passed | 7 skipped (199 total), 1679 tests passed | 8 skipped (1687 total)
  - apps/desktop: 40 files passed, 341 tests passed
- Typecheck: clean (all 3 packages)
- Build: success (all 3 packages; one pre-existing dynamic-import warning in desktop, not an error)
- Runtime smoke: DEFERRED to controller (manual)

---

## Section 1 — Subsystem Map

All paths relative to `apps/daemon/src/`. Importer counts via
`git grep -l "from '.*<dir>/"` excluding the dir itself and `*.test.ts`/`*.spec.ts`.
Last commit via `git log -1 --format=%cs -- apps/daemon/src/<dir>`.
`runtime-reached?` determined statically by tracing call paths from `index.ts`
(boot) and `server.ts` (HTTP wiring) to a real execution site.

| dir | files | wired via (file:line) | ext importers | last commit | runtime-reached? |
|---|---|---|---|---|---|
| `orchestrator/` | 8 | `index.ts:22` (subscribeOrchestrationTriggers), `index.ts:23` (reconcileInFlightGenerations); plus `tasks/usecases.ts:26`, `recommendations/usecases.ts:19` (runGeneration) | 7 (daemon-context, index, recommendations/fingerprint, recommendations/usecases, server, tasks/fingerprint, tasks/usecases) | 2026-05-28 | **yes (static)** — task/recommendation generation engine; reached every trigger event |
| `workflows/orchestrator/` | 48 | `server.ts:168` (registerOrchestratorRoutes), `server.ts:184-186` (WorkerSessionManager / WorkerQuestionStore / worker-answer-format), `server.ts:540` (OrchestratorService) | 3 (daemon-context, recommendations/usecases, server) | 2026-06-01 | **yes (static)** — the live workflow-run / step-dispatch / tmux-worker engine |
| `orchestrator-llm/` | 23 | `server.ts:172-181` (ShadowSessionManager, ShadowSessionLlmClient, model-provider client, OrchestratorMediator, prompts, build-context); `server.ts:490` (instantiation), `server.ts:684` / `1176` (shadowSessions.spawn) | 1 (server) | 2026-06-01 | **yes (static)** — live shadow-LLM mediator for orchestrator chat + workflow decisions; tmux shadow session spawned on goal bootstrap |
| `workflows/orchestration-transport/` | 36 | `server.ts:187` (registerOrchestrationTransportRoutes), `server.ts:189-193` (provider-catalog), `daemon-context.ts:80` (broker), `index.ts:26` (reconcileHiddenWorkersOnBoot) | 3 (daemon-context, index, server) | 2026-06-01 | **mixed** — broker+proposals+provider-catalog+routes **yes (static)**; entire `hidden-worker/*` and `one-shot/*` driver layer **no (registered but no live caller found)** — see §2 |
| `orchestrator-hooks/` | 2 | `server.ts:171` / `server.ts:1204` (registerOrchestratorHookRoutes) | 1 (server) | 2026-05-29 | **yes (static)** — `/v1/orchestrator-hooks/stop` is the Stop/StopFailure callback for the **shadow** session (resolves the mediator's pending LLM turn) |
| `agent-hooks/` | 4 | `server.ts:183` / `server.ts:1088` (registerAgentHookRoutes) | 1 (server) | 2026-05-31 | **yes (static)** — `/v1/agent-hooks/{response-done,elicit,stop}` are the **worker** tmux callbacks (synthesis trigger + question-relay hold hook) |

### Per-file live/dead split inside `workflows/orchestration-transport/` (36 files)

Computed per non-test file: external (non-test, outside the dir) importers.

**LIVE** (keep): `broker.ts` (7 importers incl. service/selector/synthesize/routes),
`proposals.ts` (selector), `provider-catalog.ts` (server), `routes.ts` (server),
and their intra-dir deps `attempts.ts`, `events.ts`, `types.ts`, `policy.ts`,
`human-review.ts`.

**DEAD-BUT-WIRED** (no live importer except boot reconcile): the whole
`hidden-worker/` subtree — `drivers/{claude,codex,gemini}.ts`, `drivers/registry.ts`,
`hooks.ts`, `runtime.ts`, `store.ts` (all **0** importers) and `hidden-worker/reconcile.ts`
(imported only by `index.ts` for stale-row cleanup, never spawns a driver); and the
whole `one-shot/` subtree — `codex.ts`, `gemini.ts`, `registry.ts`, `types.ts` (all **0** importers).

> **Note:** the facts handed to this audit said `orchestration-transport` has 16
> files; actual count is **36**. The 16 likely referred to the originally-listed
> subset. Counts above are measured.

---

## Section 2 — Pivot Ledger

### 2.1 `orchestrator/` vs `workflows/orchestrator/` — NOT A DUPLICATE PAIR

**WINNER: both survive (they are different subsystems with a misleading name collision).**

Evidence:
- `orchestrator/` is the **task & recommendation generation engine**:
  `triggers.ts` (event→generation trigger map), `runner.ts` (`runGeneration`,
  consumed by `tasks/usecases.ts:26` and `recommendations/usecases.ts:19`),
  `fingerprint.ts` (consumed by `tasks/fingerprint.ts`, `recommendations/fingerprint.ts`),
  `reconcile.ts` (boot cleanup of stale generation rows, `index.ts:82`). It has
  **nothing** to do with workflow runs.
- `workflows/orchestrator/` is the **workflow-run / step-dispatch / tmux-worker
  engine** (`service.ts`, `step-dispatch.ts`, `worker-session.ts`, `resume.ts`,
  `routes.ts`). Live worker spawn flows through `OrchestratorService.spawnStepAgent`
  → `workerSpawn` callback → `workerSessions.spawn` (tmux), wired at `server.ts:549-561`.

**Losing files to delete: NONE from this "pair."** Renaming to remove the name
collision is a Phase 6 concern (e.g. `orchestrator/` → `generation/`), not a deletion.

### 2.2 `orchestrator-llm/` (shadow-LLM) vs `workflows/orchestration-transport/` (hidden-worker) — THE HIGH-STAKES PICK

**WINNER: `orchestrator-llm/` for shadow LLM mediation; the `orchestration-transport`
hidden-worker/one-shot driver layer is DEAD and loses. The `orchestration-transport`
broker/proposals/provider-catalog/routes layer is a *separate, live* concern and
is NOT deleted.**

This is not a clean A-vs-B; the framing in the brief conflates two things. The
decisive evidence:

1. **Worker execution runs through tmux `worker-session.ts` (in
   `workflows/orchestrator/`), NOT the hidden-worker drivers.** `server.ts:549-561`
   wires `OrchestratorService`'s `workerSpawn`/`workerDeliver`/`workerTerminate`
   to `workerSessions.*` (a `WorkerSessionManager`). The hidden-worker
   `drivers/{claude,codex}` are never referenced by this path.

2. **The broker's driver hooks are never supplied at any live call site.**
   `broker.runHiddenInteractive` / `runOneShot` only do work if the caller passes
   `options.runHiddenInteractive` / `options.runOneShot` (broker.ts:294-356).
   `git grep` across all non-test code: the **only** `run*` callback supplied is
   `runSdkOneShot` at `workflows/operators/selector.ts:223` — an **in-process SDK
   LLM call** for operator selection, not a hidden-worker spawn. The four live
   `.propose(...)` sites (`selector.ts:222`, `service.ts:1149/1151`,
   `synthesize.ts:63`) never pass the hidden-worker or one-shot callbacks.
   Therefore `hidden-worker/drivers/*`, `hidden-worker/runtime.ts`,
   `hidden-worker/store.ts`, `hidden-worker/hooks.ts`, and `one-shot/*` have
   **zero runtime callers** (confirmed: 0 importers each).

3. **The live shadow LLM path is `orchestrator-llm/`.** `server.ts:490` instantiates
   `ShadowSessionManager`; `server.ts:530` builds `RoutedOrchestratorLlmClient` →
   `OrchestratorMediator`; `shadowSessions.spawn` is called at goal bootstrap
   (`server.ts:684`) and orchestrator-chat ask (`server.ts:1176`). The Stop hook
   that resolves a shadow turn posts to `/v1/orchestrator-hooks/stop`
   (`shadow-hook-settings.ts:2`).

4. **Spec recency confirms the pivot direction.** The newest specs describe the
   shadow-hook transport (the surviving model), not hidden-worker drivers:
   - `2026-05-28-orchestrator-mediated-workflows-design.md`
   - `2026-05-29-orchestrator-shadow-hook-transport-design.md` (interactive Claude +
     Stop/StopFailure hook capture — exactly what `orchestrator-llm` implements)
   - `2026-05-30-agent-input-transport-design.md`
   - `2026-05-31-worker-question-relay-hold-hook-design.md` (the `agent-hooks/elicit`
     hold hook — implemented in `agent-hooks/`, the live worker hook registrar)
   None of the 05-28→05-31 specs describe hidden-worker drivers; that approach
   (`orchestration-transport/hidden-worker`) is the earlier, superseded transport.

**LOSING FILES TO DELETE (dead-but-wired hidden-worker / one-shot driver layer):**
```
apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/claude.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/codex.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/gemini.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/registry.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/drivers/registry.test.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/hooks.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/hooks.test.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/runtime.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/runtime.test.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/store.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/store.test.ts
apps/daemon/src/workflows/orchestration-transport/hidden-worker/reconcile.ts        # + unwire index.ts:26 + :84
apps/daemon/src/workflows/orchestration-transport/hidden-worker/reconcile.test.ts
apps/daemon/src/workflows/orchestration-transport/one-shot/codex.ts
apps/daemon/src/workflows/orchestration-transport/one-shot/codex.test.ts
apps/daemon/src/workflows/orchestration-transport/one-shot/gemini.ts
apps/daemon/src/workflows/orchestration-transport/one-shot/gemini.test.ts
apps/daemon/src/workflows/orchestration-transport/one-shot/registry.ts
apps/daemon/src/workflows/orchestration-transport/one-shot/registry.test.ts
apps/daemon/src/workflows/orchestration-transport/one-shot/types.ts
```
**DO NOT DELETE** (live, despite living in the same dir): `broker.ts`, `proposals.ts`,
`provider-catalog.ts`, `routes.ts`, `attempts.ts`, `events.ts`, `types.ts`,
`policy.ts`, `human-review.ts` (and their tests).

> **CONFIDENCE: HIGH on the static trace** (zero importers + no callback supplier
> is strong). **Recommend ONE live smoke** to confirm dropping the hidden-worker
> reconcile + `/v1/orchestration-workers` GET routes breaks nothing the desktop
> reads. Desktop `git grep` for `orchestration-workers` / `orchestration-attempts`
> returned **no matches**, so the routes appear desktop-orphaned too — but smoke
> is the safe confirmation. Rows to live-confirm: the `hidden-worker/*` deletion
> and whether `orchestration-transport/routes.ts` (the workers/attempts GETs) can
> also go (likely yes — see §6 Phase 3 note).

### 2.3 `orchestrator-hooks/` vs `agent-hooks/` — NOT A DUPLICATE PAIR

**WINNER: both survive — they register hooks for two different consumers.**

Evidence:
- `orchestrator-hooks/routes.ts` → `POST /v1/orchestrator-hooks/stop`, calls
  `resolvePending(goalId, …)`. Consumer = the **shadow LLM session**
  (`orchestrator-llm`): `shadow-hook-settings.ts:2` and `shadow-session.ts:321`
  point the shadow tmux session's Stop/StopFailure hooks at this URL. Keyed by
  `goalId`.
- `agent-hooks/routes.ts` → `POST /v1/agent-hooks/{response-done,elicit,stop}`.
  Consumer = the **worker tmux sessions** (`workflows/orchestrator/worker-session.ts`,
  which imports `agent-hooks/hook-settings.ts`). `elicit` is the question-relay
  hold hook from the 05-31 spec. Keyed by `sessionId`.

Different keys (goalId vs sessionId), different endpoints, different consumers.
**Losing files to delete: NONE.** (The naming is confusing and is a Phase 6
rename candidate, e.g. `orchestrator-hooks/` → `shadow-hooks/`.)

### 2.4 Surviving shadow system: Claude vs Codex path (shared vs forked)

Surviving system = `orchestrator-llm/`. Single class `ShadowSessionManager`
(`shadow-session.ts`) handles both via `ShadowAdapterId = "claude-code" | "codex"`.

**SHARED** (provider-agnostic) across both:
- tmux lifecycle: `spawn` (shadow-session.ts:81), `startup` trust-prompt poll
  (:100), `terminate` (:242), `ask`/`askOnce` queueing + bracketed-paste submit
  (:134-166), pending-turn settlement (:257), `shadowSessionId` (:306).
- The mediator + LLM client stack: `mediator.ts`, `shadow-llm-client.ts`,
  `build-context.ts`, `prompts.ts`, `context.ts` are all provider-neutral.

**FORKED** (the actual `if (adapterId === "codex")` branch points):
| concern | Claude path | Codex path | location |
|---|---|---|---|
| launch binary | `claude` (`ORCA_CLAUDE_CODE_BIN`) | `codex` (`ORCA_CODEX_BIN`) | `shadow-session.ts:275-278` (`binFor`) |
| hook config file | `.claude/settings.local.json` via `buildShadowHookSettings` | `.codex/config.toml` + `.codex/hooks.json` via `buildCodexHookSettings` | `shadow-session.ts:280-301` (`writeHookConfig`) |
| result capture | **hook-driven**: `/v1/orchestrator-hooks/stop` → `resolvePending` → `extractActionBlock` (sentinel.ts) | **pane-polling**: 1s `capture-pane` loop, `textAfterTurnMarker` + `extractCodexPaneAction` (defined inline shadow-session.ts:336-342) | `shadow-session.ts:174-208` |
| pre-submit quirk | none | dismiss model-switch prompt | `shadow-session.ts:214-221` (`dismissCodexModelSwitchPrompt`) |
| error sentinels | StopFailure hook | `CODEX_USAGE_LIMIT` / `CODEX_AUTH_LOST` regexes | `shadow-session.ts:61-63`, used :195-205 |
| display name | "Claude Code" | "Codex" | `shadow-session.ts:308-310` |
| provider id map | `claude-code`→`orca/anthropic` | `codex`→`orca/openai` | `model-provider-llm-client.ts:9-10` |

This forked set is the input to §5's `ShadowProvider` interface.

---

## Section 3 — Orphan Triage (knip baseline)

Every entry in `docs/cleanup-knip-baseline.txt` classified. `DELETE` = true-dead,
`KEEP` = false-positive (knip can't see the use). Grouped by package.

### Unused files (2)
- `.claude/statusline.js` — **KEEP** (Claude Code statusline config consumed by the
  CLI harness, not by app code; outside build graph).
- `apps/daemon/src/context/index.ts` — **DELETE** (barrel; `git grep "context/index"`
  daemon-wide = 0 importers; every consumer imports the concrete module directly).

### Unused dependencies (1)
- `pino` (apps/daemon) — **DELETE** (no `from 'pino'` / `require('pino')` anywhere
  in daemon). Verify nothing transitively expects it before removing.

### Unused devDependencies (1)
- `postject` (apps/daemon) — **KEEP** (SEA/sidecar build tooling invoked from
  build scripts, not imported; dropping it can break the desktop sidecar bundle).
  Confirm against build scripts before any action; safest to leave.

### Unused exports (37) — daemon unless noted
Pattern: most are real but **internal-only**; knip flags the `export` keyword, not
the symbol's use. Triage = DELETE the unused export *symbol/file* only where it has
no in-repo use at all; otherwise downgrade to "drop the `export`" (a Phase 2 micro-edit, not a file delete).

- `elicitHookUrl` (agent-hooks/hook-settings.ts) — **KEEP / de-export** (used in
  same file at line 35; just over-exported).
- `buildConflictSnapshot` (conflicts/detectors.ts) — DELETE if no caller (verify).
- `DeterministicAssembler`, `ASSEMBLER_VERSION` (context/assembler.ts) &
  `ASSEMBLER_VERSION` (context/deterministic-assembler.ts) — **KEEP for now**;
  context assembler is on the live path; these are re-exported via the dead
  `context/index.ts` barrel. Once the barrel is deleted, re-run knip and re-triage.
- `emitCommitted` (events.ts) — DELETE if no caller (verify).
- `ExtractionNotFoundForCommitError`, `SessionNotFoundError`, `GoalNotFoundError`,
  `listSummariesByGoal`, `getLatestExtractionForSession` (extractions/*) — error
  classes / query helpers; **likely DELETE** (unused), verify each.
- `baseInput` (recommendations/fixtures) — test fixture; **KEEP** (fixtures used by
  tests knip may under-count) — verify.
- `RecommendationCandidateSchema`, `getRecommendationGenerationById`,
  `RecommendationGenerationNotFoundError` (recommendations/*) — DELETE if unused (verify).
- `sessionContextDir` (sessions/context-delivery.ts), `SessionError`
  (sessions/errors.ts), `resetPreparedStatements` (sessions/output-store.ts) —
  DELETE if unused (verify; `resetPreparedStatements` is a common test hook — check tests).
- `getTaskGenerationById`, `TaskGenerationNotFoundError` (tasks/usecases.ts) — DELETE if unused (verify).
- `listOrcaSessions` (tmux/runner.ts) — DELETE if unused (verify).
- `linkTransportAttemptDecisionInTx` (workflows/decisions/usecases.ts) — DELETE if unused (verify).
- `appendWorkerStateChangedEvent` (orchestration-transport/events.ts),
  `providerHookDirectory` (orchestration-transport/hidden-worker/hooks.ts) —
  **DELETE via §2.2** (hidden-worker is being removed wholesale).
- `DEFAULT_IDLE_MS` (workflows/orchestrator/idle-timeout.ts) — DELETE if unused (verify).
- `MODEL_OPERATOR_ID`, `AGENT_OPERATOR_ID`, `createConfig`, `modelOperatorDescriptor`,
  `agentOperatorDescriptor` (workflows/orchestrator/skill-step-test-helpers.ts) —
  **KEEP** (test helpers; knip flags them but `.test.ts` siblings use them — verify the helper isn't fully dead).
- `createRecommendationForWorkflow` (workflows/orchestrator/workflow-recommendations.ts) —
  note the in-tx variant `createRecommendationForWorkflowInTx` IS used (service.ts);
  the non-tx export is **DELETE if unused** (verify).
- `WorkflowStepNotFoundError`, `WorkflowStepInvalidTransitionError`,
  `WorkflowStepExitCriteriaIncompleteError`, `skipStep` (workflows/steps/usecases.ts) —
  DELETE if unused (verify; error classes often thrown but not imported by name).
- `didFallbackToInteractiveWorker` (apps/desktop transportStatus.ts) — **DELETE
  whole file**: `transportStatus.ts` has 0 importers in desktop (see §2.2 evidence).
- `getTemplate` (apps/desktop/workflows/api.ts) — DELETE if unused (verify).

### Unused exported types (65)
Type-only orphans (erased at runtime; safe-ish to remove, but trace each). Highlights:
- All `conflicts/detectors.ts` `Detector*` interfaces — DELETE if unused (verify; they may back the live detector fns).
- `ModelProviderId` (llm/types.ts) — **KEEP**: the *name* is used in 10+ files
  (model-catalog, selector, orchestrator-chat, etc.); knip flags the `llm/types.ts`
  re-export specifically. Confirm the canonical definition source before touching.
- `orchestrator-llm/context.ts` `WorkspaceRef` and `orchestrator-llm/session.ts`
  `Orchestrator*` interfaces — `session.ts` is part of the surviving shadow system
  but these specific interfaces may be vestigial; **verify** (some predate the
  hook-transport rewrite). Candidate DELETE if no importer.
- `orchestrator/runner.ts` `Run*Output`/`Run*CommitResult` interfaces — internal
  return types; DELETE the `export` if only used internally (verify).
- `registry/types.ts` `SkillExtensionPoint`/`SkillCategory`/`SkillInvocation`/
  `SkillContext` — the module IS used by skills, but these specific aliases may be
  unused; **verify per type**, DELETE the dead ones.
- All `orchestration-transport/{broker,hidden-worker/*,one-shot/*,proposals}.ts`
  types under hidden-worker/one-shot — **DELETE via §2.2**. The `broker.ts` /
  `proposals.ts` types in this list (`AdapterModeResolver`, `SdkCompatibilityResult`,
  `ProposalValidationResult`, `MalformedProposalFailureReason`) — **KEEP/de-export**
  (broker is live; verify each is truly unused before removing the `export`).
- `workflows/orchestrator/{deliver-initial-prompt,resume,workflow-recommendations}.ts`
  types (`InitialPromptHandle`, `ResumeRunRow`, `WorkflowRecommendationType`,
  `CreateWorkflowRecommendationOptions`) — internal; DELETE the `export` if unused (verify).
- Desktop types `WorkflowTransportStatusTone` (transportStatus.ts — dies with file),
  `RowState` (onboarding/ReadinessRow.tsx), `ThemeMode`/`ThemeTokens` (theme/themes.ts)
  — DELETE if unused (verify; theme types may feed `styled`/context typing knip misses).

### Duplicate exports (3) — packages/contracts — **ALL KEEP**
- `RecommendationType` | `ProposedActionKind` — intentional alias
  (`ProposedActionKind = RecommendationType`, index.ts:1801).
- `CreateWorkflowTemplateRequest` | `UpdateWorkflowTemplateRequest` — intentional
  alias (workflows/index.ts:765).
- `OrchestratorModelChoice` | `UpdateGoalOrchestratorModelRequest` — intentional
  alias (workflows/index.ts:954). All three are deliberate API ergonomics; KEEP.

### Configuration hints (3) — **KEEP** (knip.json tuning, not code): redundant entry
patterns for `apps/desktop/src/main.tsx`, `apps/daemon/src/index.ts`,
`packages/contracts/src/index.ts`. Optional knip.json cleanup, no code impact.

**Triage tally:** explicit `DELETE` files: `context/index.ts`,
`apps/desktop/.../transportStatus.ts`, plus the entire hidden-worker/one-shot
set from §2.2. `pino` dep DELETE. Most "unused exports/types" resolve to
**de-export micro-edits pending per-symbol verification**, not file deletions —
they are deliberately marked "verify" because knip cannot see same-file and
test-only uses. `KEEP` (false-positive) count: `.claude/statusline.js`, `postject`,
`elicitHookUrl`, `ModelProviderId`, all 3 duplicate-export aliases, the 3 config
hints, and the assembler/skill-helper/fixture exports flagged for re-check.

---

## Section 4 — Provider Inventory + Drop-List

Decision (given): **keep `claude-code`, `codex`; drop `opencode`, `gemini-cli`,
`shell-manual`.** Adapter ids are the contract enum values
(`packages/contracts/src/adapters/ids.ts:3`):
`["shell-manual", "claude-code", "opencode", "codex", "gemini-cli"]`. Note the
catalog uses **`gemini-cli`**, not `gemini`, as the id (file is `gemini.ts`).

| provider (id) | adapter file | readiness test | smoke / auth tests | exec-modes seed | model-catalog | registry reg site | contract enum | desktop refs |
|---|---|---|---|---|---|---|---|---|
| claude-code | adapters/claude-code.ts | claude-code.readiness.test.ts | claude-code.smoke.test.ts, claude-code.auth-smoke.test.ts | execution-modes.ts:13 | model-catalog.ts:10,16 | bootstrap.ts:13 (import), :54 (register) | ids.ts:3 | none by name (uses enum / `/v1/adapters`) |
| codex | adapters/codex.ts | codex.readiness.test.ts | codex.smoke.test.ts, codex.auth-smoke.test.ts | execution-modes.ts:23 | model-catalog.ts:11,33 | bootstrap.ts:15 (import), :56 (register) | ids.ts:3 | none by name |
| opencode | adapters/opencode.ts | opencode.readiness.test.ts | opencode.smoke.test.ts, opencode.auth-smoke.test.ts | execution-modes.ts:30 | (no catalog entry) | bootstrap.ts:14 (import), :55 (register) | ids.ts:3 ("opencode") | **none** (`git grep` desktop = 0) |
| gemini-cli | adapters/gemini.ts | gemini.readiness.test.ts | (no smoke/auth test) | execution-modes.ts:37 | model-catalog.ts:12,60 | bootstrap.ts:16 (import), :57 (register) | ids.ts:3 ("gemini-cli") | **none** (`git grep` desktop = 0); also `one-shot/gemini.ts` + `hidden-worker/drivers/gemini.ts` (dead, removed in §2.2) |
| shell-manual | adapters/shell-manual.ts | shell-manual.readiness.test.ts | (shell-manual.test.ts only) | execution-modes.ts:42 | (no catalog entry) | bootstrap.ts:12 (import), :53 (register); also plugin descriptor bootstrap.ts:45 | ids.ts:3 ("shell-manual") | **none** (`git grep` desktop = 0) |

> Desktop holds no hardcoded references to any dropped provider by name — it
> consumes the adapter list at runtime via the contract enum / `/v1/adapters`.
> So the contract enum edit (`ids.ts:3`) is the lever that exposes any remaining
> typed references via tsc exhaustiveness — exactly the Phase 4 plan's trail.

### DROP CHECKLIST (ordered, per provider)

**opencode**
1. `apps/daemon/src/adapters/opencode.ts`
2. `apps/daemon/src/adapters/opencode.readiness.test.ts`
3. `apps/daemon/src/adapters/opencode.smoke.test.ts`
4. `apps/daemon/src/adapters/opencode.auth-smoke.test.ts`
5. Remove `bootstrap.ts:14` import + `bootstrap.ts:55` `adapters.register(new OpenCodeAdapter())`
6. Remove exec-modes seed `execution-modes.ts:30-36` (`opencode` block)
7. Remove `"opencode"` from `packages/contracts/src/adapters/ids.ts:3`
8. `pnpm --filter @orca/contracts build`, then `tsc` to surface any remaining typed refs

**gemini-cli**
1. `apps/daemon/src/adapters/gemini.ts`
2. `apps/daemon/src/adapters/gemini.readiness.test.ts`
3. Remove `bootstrap.ts:16` import + `bootstrap.ts:57` `adapters.register(new GeminiAdapter())`
4. Remove exec-modes seed `execution-modes.ts:37-41` (`gemini-cli` block)
5. Remove model-catalog: provider map `model-catalog.ts:12` (`gemini-cli`→`orca/google-gemini`) + the `"gemini-cli"` model array `model-catalog.ts:60-78`
6. Remove provider-catalog display-name `orchestration-transport/provider-catalog.ts:14` (`orca/google-gemini`→`Gemini`)
7. Remove `"gemini-cli"` from `packages/contracts/src/adapters/ids.ts:3`
8. (gemini's `one-shot/gemini.ts` + `hidden-worker/drivers/gemini.ts` already removed in Phase 3 / §2.2)
9. `pnpm --filter @orca/contracts build`, then `tsc`

**shell-manual**
1. `apps/daemon/src/adapters/shell-manual.ts`
2. `apps/daemon/src/adapters/shell-manual.readiness.test.ts`
3. `apps/daemon/src/adapters/shell-manual.test.ts`
4. Remove `bootstrap.ts:12` import + `bootstrap.ts:53` `adapters.register(new ShellManualAdapter())`
5. Remove plugin descriptor `bootstrap.ts:45` (`orca.shell-manual`)
6. Remove exec-modes seed `execution-modes.ts:42-…` (`shell-manual` block)
7. Remove `"shell-manual"` from `packages/contracts/src/adapters/ids.ts:3`
8. `pnpm --filter @orca/contracts build`, then `tsc`

Cross-cutting after all three: `git grep -niE 'opencode|gemini|shell.?manual'`
should return only historical docs/specs (acceptable) and the surviving
`agent-adapters.test.ts` if it enumerates providers (update that test to the two
survivors).

---

## Section 5 — Unified Provider Design

Based on §2.4 fork analysis, the surviving shadow system's provider-specific
behavior reduces to **six fork points**, all currently inlined in
`shadow-session.ts` as `if (adapterId === "codex")` branches. The proposed
`ShadowProvider` interface captures exactly those.

### Proposed interface

```ts
// apps/daemon/src/orchestrator-llm/providers/types.ts
export type ShadowAdapterId = "claude-code" | "codex";

export interface ShadowLaunch {
  /** Executable to launch in the tmux pane (resolved bin, env-overridable). */
  bin: string;
}

export interface ShadowHookConfig {
  /** Files to write under the per-goal shadow dir before launch.
   *  Claude: [{ ".claude/settings.local.json", json }]
   *  Codex:  [{ ".codex/config.toml", toml }, { ".codex/hooks.json", json }] */
  files: Array<{ relPath: string; contents: string }>;
}

/** How a completed turn's text is obtained. */
export type ShadowCaptureMode =
  | { kind: "hook" }                       // claude: Stop hook → resolvePending
  | { kind: "pane-poll"; intervalMs: number }; // codex: capture-pane loop

export interface ShadowTurnParse {
  /** Extract the orca:action payload from a turn's text, or null if not ready. */
  parseAction(turnText: string): string | null;
  /** Optional terminal error sentinels (codex usage-limit / auth-lost). */
  detectError?(turnText: string): Error | null;
}

export interface ShadowProvider {
  readonly id: ShadowAdapterId;
  readonly displayName: string;                       // §2.4 adapterDisplayName
  readonly modelProviderId: string;                   // "orca/anthropic" | "orca/openai"
  launch(deps: { binOverrideEnv?: string }): ShadowLaunch;            // §2.4 binFor
  hookConfig(args: { goalId: string; port: number; authToken: string }): ShadowHookConfig; // writeHookConfig
  captureMode(): ShadowCaptureMode;                   // hook vs pane-poll fork
  turnParser(): ShadowTurnParse;                      // extractActionBlock vs extractCodexPaneAction
  /** Optional pre-submit pane hygiene (codex model-switch prompt dismissal). */
  beforeSubmit?(ctx: { tmux: TmuxRunner; sessionName: string }): Promise<void>;
  /** Readiness probe — delegates to adapter.checkAuth (already provider-keyed). */
  // readiness handled by existing ShadowSessionDeps.isReady(adapterId); not duplicated here.
}
```

### Current forking code this replaces (all in `shadow-session.ts`)
- `binFor` (:275-278) → `provider.launch().bin`
- `writeHookConfig` (:280-301) → `provider.hookConfig(...).files` written generically
- capture fork (:174-208 pane-poll vs hook) → `provider.captureMode()` selects the loop
- `extractActionBlock` vs `extractCodexPaneAction`/`textAfterTurnMarker` (:182-192,
  :336-342) → `provider.turnParser()`
- `dismissCodexModelSwitchPrompt` (:214-221) → `provider.beforeSubmit?(...)`
- `CODEX_USAGE_LIMIT`/`CODEX_AUTH_LOST` (:61-63) → `turnParser().detectError`
- `adapterDisplayName` (:308-310) → `provider.displayName`
- `model-provider-llm-client.ts:9-10` PROVIDER_BY_ADAPTER_ID map → `provider.modelProviderId`

`ShadowSessionManager` keeps all shared tmux lifecycle (spawn/startup/ask/terminate/
queueing/paste) and calls the resolved provider at each fork point.

### Proposed file layout
```
apps/daemon/src/orchestrator-llm/providers/
  types.ts        # ShadowProvider + supporting types (above)
  registry.ts     # resolveShadowProvider(id): ShadowProvider; throws on unknown
  claude.ts       # ClaudeShadowProvider (hook capture, .claude settings)
  codex.ts        # CodexShadowProvider (pane-poll, .codex config+hooks, model-switch)
```
(Seed pattern = the existing `hidden-worker/drivers/registry.ts` shape, which is
being deleted but is a fine template for the registry idea.)

### "Add a 3rd provider" walkthrough (proves the abstraction)
To add e.g. `cursor-agent`:
1. Add `"cursor-agent"` to `ShadowAdapterId` (and the contract enum).
2. Create `providers/cursor.ts` implementing `ShadowProvider`: bin name, its hook
   config file(s), `captureMode` (hook or pane-poll), a `turnParser`, optional
   `beforeSubmit`, display name, modelProviderId.
3. Register it in `providers/registry.ts` (one line).

**Zero edits to `ShadowSessionManager` or any orchestration core** — it only ever
calls interface members. This satisfies the design's Phase-5 acceptance bar.

---

## Section 6 — Per-Phase Gate-B Checklists

### Phase 2 — Prune orphans (safe leaves)
- [ ] Delete `apps/daemon/src/context/index.ts` (dead barrel; 0 importers) — remove any import it orphans (none expected).
- [ ] Delete `apps/desktop/src/goal-detail/workflow/transportStatus.ts` (0 importers) + its test if any.
- [ ] Remove `pino` from `apps/daemon/package.json` deps (no import anywhere) — DO NOT remove `postject` (build tooling, KEEP).
- [ ] De-export / delete the per-symbol "unused export" set **only after per-symbol verify** (see §3 list); skip anything that turns out test-only or same-file-used (`elicitHookUrl`, skill-step-test-helpers, fixtures, `ModelProviderId`, broker/proposals types).
- [ ] Re-run knip; assemble/skill-helper re-triage after `context/index.ts` removal.
- [ ] Gate B: `npx knip` shows these gone, no NEW orphans; `git grep` the deleted symbols = clean.

### Phase 3 — Consolidate (delete dead-but-wired shadow loser)
Delete the entire hidden-worker + one-shot layer (§2.2 list):
- [ ] `workflows/orchestration-transport/hidden-worker/` (whole dir: drivers/{claude,codex,gemini}.ts, drivers/registry.ts, hooks.ts, runtime.ts, store.ts, reconcile.ts + all `.test.ts`)
- [ ] `workflows/orchestration-transport/one-shot/` (whole dir: codex.ts, gemini.ts, registry.ts, types.ts + tests)
- [ ] Unwire `index.ts:26` (import) + `index.ts:84` (`reconcileHiddenWorkersOnBoot(...)` call)
- [ ] Evaluate `orchestration-transport/routes.ts` GET `/v1/orchestration-workers*` + `/orchestration-attempts`: desktop has 0 references; if smoke confirms unused, delete `routes.ts` + unwire `server.ts:187,1210`. Otherwise keep (attempts table still written by broker). **LIVE-SMOKE GATE.**
- [ ] KEEP `broker.ts`, `proposals.ts`, `provider-catalog.ts`, `attempts.ts`, `events.ts` (minus `appendWorkerStateChangedEvent` if orphaned), `types.ts`, `policy.ts`, `human-review.ts`.
- [ ] Drop any DB migrations/tables exclusive to hidden-worker store if confirmed unused (separate review — do NOT drop the transport_attempts table).
- [ ] Gate B: smoke 1 Goal end-to-end (proves surviving tmux worker path drives a Goal); `git grep -nE 'hidden-worker|one-shot|reconcileHiddenWorkers'` clean.

> No deletions for pivots 2.1, 2.3 (not duplicates) and the `orchestrator-llm`
> survives whole. Pivot 2.2 is the only Phase-3 deletion target.

### Phase 4 — Drop providers
- [ ] Execute the three DROP CHECKLISTs in §4 (opencode, gemini-cli, shell-manual), one provider per commit.
- [ ] `pnpm --filter @orca/contracts build` after each contract enum edit; fix tsc exhaustiveness fallout (that's the ref trail).
- [ ] Update `adapters/agent-adapters.test.ts` (and any provider-enumerating test) to the two survivors.
- [ ] Gate B: `git grep -niE 'opencode|gemini|shell.?manual'` → only docs/specs remain.

### Phase 5 — Unify providers
- [ ] Create `orchestrator-llm/providers/{types,registry,claude,codex}.ts` per §5.
- [ ] Failing test first: registry resolves `claude-code` + `codex` to a `ShadowProvider`; unknown id throws.
- [ ] Replace the 8 fork points in `shadow-session.ts` (§5 list) + the PROVIDER_BY_ADAPTER_ID map in `model-provider-llm-client.ts` with interface calls.
- [ ] Acceptance: run the "add a 3rd provider" thought-test (§5) — must be implement-interface + register, zero orchestration-core edits.
- [ ] Gate B: new test passes; `git grep -nE "adapterId === \"codex\"" apps/daemon/src/orchestrator-llm` → 0 in shadow-session.

### Phase 6 — Restructure (mechanical renames; resolves name collisions)
- [ ] `git mv apps/daemon/src/orchestrator/ apps/daemon/src/generation/` (it is the task/recommendation generation engine, not an orchestrator) — rewrite all importers (`tasks/*`, `recommendations/*`, `index.ts`, `daemon-context.ts`, `server.ts`).
- [ ] `git mv apps/daemon/src/orchestrator-hooks/ apps/daemon/src/shadow-hooks/` (it serves the shadow session) — rewrite importer (`server.ts`) and the URL string in `orchestrator-llm/shadow-hook-settings.ts` + `shadow-session.ts` + the route path `/v1/orchestrator-hooks/stop` (coordinate with desktop if it hardcodes the path — it does not, per §2).
- [ ] Optionally rename `orchestrator-llm/` → `shadow/` and fold `providers/` under it.
- [ ] Gate B: `npx knip` clean; behaviour identical (mechanical only); smoke 1 Goal.

> Defer route-path renames if any external (desktop/hook) consumer hardcodes the
> old path; §2 evidence says none do for these two, but confirm in the Phase-6 diff.
