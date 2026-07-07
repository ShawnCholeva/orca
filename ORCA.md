# ORCA

The single durable guide to this project. It explains **what Orca is, why it is shaped the way it is, and where things live** — enough orientation for a human or an AI agent to work productively here.

**The codebase is the source of truth.** This document informs direction and decisions; it deliberately avoids anything that rots (line counts, test counts, milestone status, exact schemas). When this file and the code disagree, the code wins — fix this file.

---

## 1. What Orca is

Orca is a **local-first desktop application for multi-agent AI orchestration**. It coordinates multiple AI agent sessions (Claude Code, Codex) around long-running engineering **Goals** by preserving operational reasoning, managing shared context, and progressing from supervised to autonomous execution under human oversight.

The problem it solves: AI coding agents are individually powerful but operationally disconnected. Across many sessions, reasoning fragments, decisions are lost, context drifts, and humans become the coordination bottleneck. Orca is a shared operational reasoning layer *above* the agents — it coordinates native execution environments instead of replacing them. Claude Code still feels like Claude Code.

**What it is not:** a chatbot UI, an IDE clone, a prompt manager, a Jira replacement, or an autonomous-demo agent.

The current implementation target is **Level 4 — Supervised execution** (the orchestrator runs flows and pauses at human approval gates), built so reaching **Level 5 — Autonomous execution** does not require an architectural rewrite.

### Autonomy levels (what we build against)

Orca builds against **two** levels. The earlier ladder (manual → shared context → suggested orchestration) is no longer how the product is framed; everything now builds toward these two:

4. **Supervised execution** — the orchestrator runs flows and pauses at human approval gates. **← current target.**
5. **Autonomous execution** — the orchestrator runs to completion under exception-based human oversight.

These are not an aspirational ladder — they are the live **`operating_mode`** of every Goal: `human_review` *is* Level 4, `automated` *is* Level 5, driven by the Governed harness axis (a deterministic risk classifier + permission tiers + a non-disableable critical-action safety floor; see §14). The dormant per-goal `autonomyLevel` integer the old ladder mapped to has been superseded and is left inert. The goal is not maximum autonomy for its own sake; it is **operational coherence** — earning the move from Supervised to Autonomous safely, Goal by Goal.

---

## 2. Core concepts (the domain vocabulary)

These nouns appear everywhere in the code. Learn them first.

- **Goal** — the primary orchestration boundary. A long-running operational intelligence space that can span multiple workspaces/repos. Holds workspaces, tasks, sessions, workflows, memory, decisions. Completion is **human-authoritative** — the orchestrator may recommend it, the user decides.
- **Workspace** — a local folder/repo attached to a Goal. A Goal can have several. Git inspection is **lazy and bounded** (only on inspect/attach, never at boot; a missing/slow `git` degrades to "non-git folder" rather than failing).
- **Session** — a disposable agent execution environment owned by the daemon (PTY-backed). Sessions execute work and produce reasoning; they are not resumed after a daemon restart.
- **Role** — a persistent operational identity (Architect, Engineer, Reviewer, QA, …). Sessions are disposable; roles persist across the Goal and influence context assembly and validation expectations.
- **Memory item** — Goal-scoped, reasoning-first. Typed (decision, constraint, risk, blocker, architecture_note, session_summary, open_question, …) with a lifecycle: `observed → extracted → promoted → canonical`. Promotion is automatic by default; high-risk items can require confirmation.
- **Decision** — a first-class entity that records *why* (reasoning, alternatives, tradeoffs), not just what was chosen.
- **Recommendation** — an orchestrator-generated next action with a rationale and confidence (create_session, review_output, split_task, run_validation, mark_complete, …).
- **Workflow / run** — a reusable orchestration pattern (a sequence of steps) executed against a Goal. See §5.

Memory is **Goal-scoped, never workspace-scoped**, and the MVP deliberately has **no cross-goal memory** — contextual integrity over breadth.

---

## 3. System architecture

```
Tauri v2 Desktop App (React + TypeScript)      apps/desktop
        ↓  HTTP commands/queries + WebSocket (events, terminal streams)
Node.js Orchestrator Daemon (Fastify + SQLite) apps/daemon
        ↓
Adapters · PTY · tmux · Shadow sessions
        ↓
Claude Code / Codex / Git / local workspaces
```

Three design commitments drive almost every decision:

1. **Local-first.** Source, terminals, sessions, logs, and DB stay on the machine. No cloud required. SQLite is the storage layer; everything lands under `~/.orca` (override `ORCA_DATA_DIR`).

2. **UI / runtime separation.** The Tauri app is *not* the orchestration runtime — it renders and sends user actions. The **daemon is the system of record** for goals, sessions, tasks, workflows, memory, decisions, and events. The UI reads projections, not raw event streams.

3. **Deterministic core, selective AI.** Cheap deterministic code handles lifecycle, event routing, state projections, dependency/task graphs, workflow transitions, and approval gates. The LLM is invoked **only** where judgment is needed (goal refinement, decomposition, summary/memory extraction, conflict synthesis, recommendations, step judgement). This is the central cost-control mechanism — *hooks and events before AI inspection*.

### Event-driven spine

Domain events are persisted append-only and fan out over an internal event bus to projection builders, the workflow engine, memory/recommendation engines, and the UI event stream (`WS /v1/events`). Commands mutate state and emit events; queries read projections. Reconstructing a Goal's history means replaying its events.

---

## 4. Where things live (daemon map)

The daemon (`apps/daemon/src`) is organized by subsystem. Each typically has `usecases.ts` (logic), `projection.ts` (read model), `routes.ts` (HTTP), and `*.test.ts` colocated.

| Area | Dir | Responsibility |
|---|---|---|
| HTTP/WS server wiring | `server.ts`, `index.ts` | Fastify app, route registration, auth token, WS routes. The map of *everything* wired together. |
| Goals & refinement | `goals/`, `goals.ts`, `goal-refinements.ts` | Goal CRUD, deterministic refinement. |
| Workspaces | `workspaces/` | Attach/detach, bounded git inspection. |
| Sessions (PTY) | `sessions/`, `pty/` | Daemon-owned PTY lifecycle, output tail store, reconciliation on boot. |
| tmux worker sessions | `tmux/` | Spawn agent worker sessions in tmux (`-e KEY=VAL` env, idempotent kill-then-new). |
| Adapters | `adapters/` | `claude-code` and `codex` spawn factories; execution-mode config + dispatcher. |
| Agent hooks | `agent-hooks/`, `shadow-hooks/` | HTTP endpoints agents' native hooks call back into (Stop/response-done, etc.). |
| Orchestrator-LLM | `orchestrator-llm/`, `orchestrator-chat/` | The goal-scoped mediating LLM: session, mediator, prompts, shadow vs provider client routing. |
| Workflows | `workflows/` | The big one — see below. |
| Memory | `memory/` | Typed Goal memory, promotion rules, refinement seeding. |
| Context assembly | `context/` | Right-sized context package per session (deterministic assembler + renderer). |
| Extraction / generation | `extractions/`, `generation/` | Pull structured memory/decisions/tasks from session output. |
| Decisions / conflicts | `decisions/`, `conflicts/` | First-class decisions; overlap/contradiction detection. |
| Recommendations | `recommendations/` | Rule-based next-action engine with evidence + feedback loop. |
| Tasks | `tasks/` | Dynamic work-unit graph. |
| Readiness | `readiness/` | Adapter/system availability + version checks. |
| LLM clients | `llm/` | `anthropic` + `openai` clients behind a registry. |
| Registry | `registry/` | Static internal plugin + skill registry, frozen at boot. |
| Harness substrate | `harness-telemetry/`, `harness-state/`, `harness-sensors/`, `harness-metrics/`, `harness-risk/` | The four-axis `HarnessTransition` spine: self-registering facet/boundary/sensor registries (`defineFacet`/`defineBoundary`/`defineSensor`) with boot conformance guards, the OTLP cost receiver, derived state-deps + conflict/belief-divergence detection, the deterministic sensor ladder, the risk classifier + permission tiers, and the `/v1/harness/registry` · `/v1/harness/hook-contracts` · `/harness-metrics` · `/harness-replay` introspection routes. |
| Migrations | `migrations.ts` + `apps/daemon/migrations/*.sql` | Ordered, append-only SQL migrations. |

Inside `workflows/`:

- `templates/` — workflow definitions (built-ins registered in `catalog.ts`'s `BUILTIN_TEMPLATE_CATALOG`) and validation pipeline.
- `runs/` — run lifecycle.
- `steps/` — per-step run state.
- `orchestrator/` — the mediation engine: step dispatch, agent interview, judgement, revise loop, crash retry, idle timeout, resume, worker sessions/questions, synthesis. The advance/route/gate/splitter/spawn core is its own deterministic **`DispatchEngine`** (the paper's "control unit"); **`OrchestratorService`** is the event-handler/reaction layer that calls it (the boundary is acyclic). Provider rate/quota recovery is a standalone **`ProviderRecoveryController`** over a **`RunnerPort`** — the in-process execution-plane seam that precedes FUTURE_ARCHITECTURE's Runner Protocol.
- `orchestration-transport/` — transport broker, fallback policy, human-review path, provider catalog.
- `artifacts/`, `decisions/`, `guardrails/`, `operators/` — supporting concerns.

Desktop (`apps/desktop/src`): `App.tsx` entry; `orchestrator/` (the OrcaChat surface); `goal-detail/` with panels for `sessions/`, `tasks/`, `memory/`, `decisions/`, `recommendations/`, `conflicts/`, `workflow/`, `context-preview-panel/`; `create-goal-flow/`; `api.ts` daemon client.

Shared contracts (`packages/contracts/src`): zod schemas + types shared between daemon and desktop — adapter ids, execution modes, workflow contracts, output schemas. **`adapters/ids.ts` is the canonical adapter list.**

---

## 5. The orchestrator-mediated workflow model (the central "why")

This is the most important architecture to understand, and the part most likely to be misread from the older design docs.

**The shape:** one user-selected **orchestrator-LLM** is the *sole* conversational partner for a Goal. Every workflow step spawns its **own agent session**; the orchestrator-LLM mediates every message between the user and that agent, and judges when a step is satisfied. The run is autonomous from goal-create through all steps, with a **single user yield point: the final mark-done confirm.**

Why this shape: previously the user had no consistent conversational partner — model-path steps showed input cards, agent-path steps ran in their own terminal, and the voice changed per step. Now there is one persistent voice (the orchestrator-LLM, whichever model/provider the user chose at goal creation) that paraphrases agent work into chat.

### Step lifecycle (deterministic engine drives, LLM judges)

```
step start (engine): resolve agent+model from template.agentPreference[]
                     resolve execution mode from adapter's DB config
                     spawn per-step agent session, register response-done hook
                     compose prompt = step.instructions + outputSchema
                                    + bounded prior-step artifacts + orca:step-complete convention
loop:
  agent response-done hook fires → orchestrator-LLM paraphrases to chat (+ "Why?" + raw transcript)
    if agent emitted <orca:step-complete>{...}:
        engine validates JSON against outputSchema (deterministic)
        orchestrator-LLM judges approve | revise(feedback)   [revise cap N=3]
        approve → persist step artifact, terminate session, advance
  user message → orchestrator-LLM forwards to agent | answers directly | offers scope options
  agent crash → orchestrator-LLM picks retry vs escalate     [retry cap 3]
  hook silent past idle window → engine reads PTY tail, proceeds as if a response arrived
final step → orchestrator composes summary → inline [Confirm done]/[Not yet] card
```

Key consequences encoded in the code:

- **Step completion is hybrid-gated:** agent proposes structured output → engine validates against `outputSchema` (deterministic) → orchestrator-LLM judges satisfaction. Neither alone decides. A risky or under-verified completion also passes through an independent **refute** — see the Verify-lane arc in §14 — before it commits.
- **Engine owns the lifecycle; the LLM never drives deterministic transitions.** The orchestrator-LLM does not get tool-call freedom to spawn agents or advance steps. This keeps progression predictable and cheap.
- **Agent selection is template-declarative,** not LLM-selected. Each step carries an ordered `agentPreference[]` of `{adapterId, modelId}`; the resolver picks the first ready adapter that supports the model, with fallback. Template authors match model weight to workload (cheap conversational models for interview/QA; heavier reasoning for synthesis/decomposition/review).
- **Run progression is event-driven** after creation — the engine reacts to user messages, agent hooks, crashes, and idle timeouts. There is no central polling loop.

### Workflow templates (catalog + graph-routed)

Templates are no longer all seeded at boot. A curated **catalog** (`workflows/templates/catalog.ts`) holds the built-in definitions with display metadata; the user **installs on selection** (`GET /catalog`, `POST /install`), and boot only runs `reconcileBuiltInTemplates` to drop stale built-ins that have no runs. The recommended default is **`orca/adaptive-delivery`** — a single graph that uses a *splitter* node to reason over the goal and route to one of three entry depths (it subsumed the older Brainstorm / Feature-Development / Initiative templates). Other built-ins: `orca/bug-triage-fix` (mapped onto the systematic-debugging four phases), `orca/code-review`, `orca/refactor`, `orca/quality-coverage`. The legacy linear `orca/engineering` template still exists as fallback content but is no longer the seeded default.

Runtime routing is **graph-authoritative**: a workflow graph of labeled edges, orchestrator-judged **gates** (`approved`/`rejected` ports, backward edges allowed), N-way **splitters**, and an explicit `terminal` step drives advancement through a run-level node cursor — not `ordinal + 1`. Each step still carries its own output schema validated at completion, `execution`-style steps carry a `validation_required` guardrail (now backed by the Executable axis's deterministic sensor veto, §14), and the only enforced user yield is the terminal mark-done confirm. Runs are pinned to a `template_snapshot` captured at start, so mid-run template edits don't leak in.

A **gate is the workflow's PEV Verify phase.** Under `human_review` (L4) it parks for a human `decideGate`, unchanged. Under `automated` (L5) an LLM gate evaluator — riding the runner-agnostic `ShadowAsk` seam, the live variant of the same dormant-broker pattern the splitter uses — fills the verdict, but the deterministic core still owns routing and the termination bound: it stops on an objective non-progress signal (the same `issueRefs` recurring, i.e. stagnation) or the hard `GATE_REJECT_CAP` ceiling, never on model self-report. The LLM only ever proposes a verdict + `issueRefs`; on rejection those route to the closing step the same way for both paths, via `latestRejectingGate → repairContext`.

**Composition — the `delegate` node (the 4th graph node type).** Alongside `step`/`gate`/`splitter`, a **`delegate`** node spawns a **child `WorkflowRun`** of another, independently-versioned template (pinned by `childTemplateId` + `childTemplateVersion`) on the same goal. While the child runs, the parent parks in a dedicated **`delegating`** run status and the child becomes the active leaf; the parent↔child link is recorded so the **delegation stack** survives restart (depth-guarded, `MAX_DELEGATION_DEPTH`; cross-template validation rejects cyclic and over-deep delegation). The child runs with an **isolated state space** — it never sees the parent blackboard. Data crosses the boundary only through a **typed template interface**: the child declares typed `inputs`, its terminal step declares an `outputSchema`, and the delegate node maps `reads` (`{ childInputKey: parentKey }`, seeded as the child's synthetic entry artifact) in and `writes` (`{ parentOutputKey: childOutputKey }`, materialized on the delegate node from the child's terminal output) back out. The join is **verdict-gated** and integrates with all four harness axes (§14): budget spans the composition (Executable/Governed), `operating_mode` derives the conflict/launch policy and an auditable `GoalDecision` (Governed), belief-divergence is checked at join (Stateful), and `delegate_spawn`/`delegate_join` `HarnessTransition`s carry the resolved `reads` values (Inspectable). The dogfood pair `orca/scoped-delivery` → `orca/scope-brief` exercises the seam end-to-end.

---

## 6. Shadow sessions, hooks, and execution modes

How an agent turn is dispatched is an **execution mode**, configured per-adapter in the DB (`adapter_execution_modes`) and toggleable as a one-row edit:

- **`shadow_session`** — a long-lived interactive PTY ("shadow" session). The daemon writes to stdin and detects "response done" via the agent's **native hook** firing back to a daemon HTTP endpoint. This is the **preferred (and currently only enabled) mode for both `claude-code` and `codex`** — orchestration runs against interactive subscriptions, not API keys.
- **`one_shot`** — a single request/response per turn. The mode exists in the contract but is **disabled** for both adapters today (see the per-adapter seed in `adapters/execution-modes.ts` and its `disabledExecutionModes` reasons).

**Why hooks instead of scraping stdout** (a hard project rule, see `CLAUDE.md`): parsing terminal output is brittle and ambiguous. Agent-native hooks (Claude Code Stop hook, Codex hooks) are first-class orchestration inputs — they fire deterministic "this turn is done" signals that become domain events. Always prefer hooks over parsing shadow workers/sessions.

**Why interactive shadow sessions instead of one-shot for Claude Code:** the one-shot `-p` flag bills against the API budget, whereas an interactive (shadow) session runs against the interactive subscription. The execution-mode config records this rationale in its `disabled_modes` policy log. This billing reality is *the* reason the shadow transport exists.

Mode resolution: the dispatcher uses the adapter's preferred enabled mode, falls back to other enabled modes on failure, and never attempts a disabled mode. Adapter capability (`supportedExecutionModes`) is declared in code; the enabled/disabled split lives in the DB and is seeded at boot.

**tmux** is the mechanism for spawning worker agent sessions out-of-process so their PTYs are inspectable and survivable; `tmux/runner.ts` wraps it (env via `-e`, idempotent kill-then-create).

---

## 7. Adapters and providers

There are **three agent adapters: `claude-code`, `codex`, and `antigravity`** (Google's `agy` CLI) — `packages/contracts/src/adapters/ids.ts` is canonical. Earlier docs mention opencode and a shell/manual adapter (removed/historical) or "exactly two" adapters (predates the antigravity addition); trust the contract enum. Note: antigravity reached adapter/model parity but its worker **permission gate is not yet wired** (it spawns ungated — see §14 and `FUTURE_WORK.md`), so claude-code/codex are the fully-governed paths today.

Adapters are daemon-internal spawn factories returning `command`, `args`, `env`, `cwd`. Both the goal-scoped orchestrator-LLM and per-step agents route through the same adapter layer, so billing and mode semantics are unified.

LLM provider clients (`llm/anthropic.ts`, `llm/openai.ts`) sit behind a registry; the orchestrator-LLM routes between a shadow client (interactive PTY) and a provider client depending on the configured mode (`server.ts` constructs a `RoutedOrchestratorLlmClient`).

---

## 8. Storage and data

- **SQLite** is the only storage layer (`better-sqlite3`, WAL mode). No `StorageProvider` abstraction yet — intentionally deferred. The architecture keeps Postgres as a *future* option for team/cloud mode, so avoid hard SQLite-specific assumptions in domain logic.
- **Migrations** are an ordered list in `migrations.ts` referencing `apps/daemon/migrations/*.sql`, applied once and tracked in a `_migrations` table. Add new migrations by appending a numbered `.sql` and registering it in the array — never edit an applied migration.
- **Events** are append-only; **projections** are the queryable read models the UI consumes. Terminal bytes are *never* written to the general event store — session output goes only to a capped per-session output tail (`session_output_chunks`, default 1 MiB, overflow drops oldest chunks).
- **Data directory:** `~/.orca` on Linux/macOS, `%APPDATA%\Orca` on Windows. Override with `ORCA_DATA_DIR`. Resetting = stop the app and delete `orca.db`, `orca.db-wal`, `orca.db-shm`.

---

## 9. Plugins and skills (internal, static)

Orca is "plugin-first" in *interface shape* but **internal-only in practice**: the plugin and skill registries are populated once at boot in `registry/bootstrap.ts` and then **frozen**. No dynamic loading, no JSON manifests, no external plugin API, no permissions/sandbox — all deferred until a milestone scopes them.

- Add a **plugin descriptor** or **skill** by registering it in `bootstrapRegistries()` before the `freeze()` call, then update the bootstrap test that asserts the exact registered set.
- Skill `invoke` is pure: no I/O, no DB, no event-bus calls — the usecase that owns the extension point does those.

This keeps the extension *surface* stable (first-party code uses the same interfaces future third parties would) without paying for a plugin runtime the MVP doesn't need.

---

## 10. Context assembly (token efficiency)

Context injected into a session is assembled selectively, not dumped:

- **Always included:** Goal objective, current task, role, hard constraints, confirmed decisions, success/acceptance criteria.
- **Conditionally included:** sibling session summaries, architecture notes, known risks, recent changes, open questions.
- **Always excluded:** stale logs, irrelevant prior discussion, raw transcripts.

The orchestrator context envelope is bounded (~32 KiB rendered; per-section cap ~8 KiB); when over budget it truncates oldest agent turns first, then earliest prior-step artifacts, and **never** truncates current-step or goal metadata. Right-sized context is a first-class cost and quality concern.

---

## 11. Working in this repo

### Conventions (from `CLAUDE.md` / `AGENTS.md` — these override defaults)

1. **Think before coding.** State assumptions; surface tradeoffs; ask when unclear rather than guessing.
2. **Simplicity first.** Minimum code that solves the problem. No speculative abstractions, flexibility, or error handling for impossible cases.
3. **Surgical changes.** Touch only what the task requires. Don't refactor or reformat adjacent code. Match existing style. Mention unrelated dead code; don't delete it unprompted.
4. **Goal-driven execution.** Turn tasks into verifiable goals (write the failing test, then make it pass); loop until verified.

These bias toward caution over speed; use judgment on trivial tasks.

### Commands

```sh
pnpm install                              # installs workspaces, rebuilds native modules
pnpm --filter @orca/desktop tauri:dev     # full app: Vite + daemon as managed child
pnpm --filter @orca/daemon dev            # daemon only (HTTP on 127.0.0.1:8787, prints auth token)
pnpm typecheck                            # all workspaces
pnpm test                                 # all workspaces (vitest)
pnpm --filter @orca/daemon test
pnpm knip                                 # unused-export check
```

Prereqs: Node 20+, pnpm (via Corepack), Rust toolchain for Tauri, OS-specific Tauri deps. The desktop dev shell picks an ephemeral daemon port; port conflicts only bite the daemon-only path (override `ORCA_PORT`).

### Production bundle

`tauri:build` invokes `build:sidecar` (Node SEA: daemon JS embedded into a `node` binary, SQL migrations as SEA assets). Native bindings (`better-sqlite3`, `node-pty`) can't live inside the SEA blob — they ship as Tauri resources under `runtime/node_modules/...` with `ORCA_RUNTIME_DIR` injected at spawn. Native bindings must match the embedded Node major version; mismatches surface as `Module did not self-register` / `NODE_MODULE_VERSION` errors (fix: rebuild the native modules, then rebuild the sidecar). The sidecar is single-platform (the developer's OS/arch).

### Session/runtime env vars

| Variable | Purpose |
|---|---|
| `ORCA_DATA_DIR` | Override the SQLite/data directory. |
| `ORCA_PORT` | Daemon HTTP port (default 8787; set to 0 for an OS-assigned ephemeral port). |
| `ORCA_CLAUDE_CODE_BIN` / `ORCA_CODEX_BIN` | Override adapter command. |
| `ORCA_SESSION_OUTPUT_TAIL_BYTES` | Per-session persisted output tail cap (default 1 MiB). |
| `ORCA_SESSION_STOP_GRACE_MS` | SIGTERM→SIGKILL grace (default 5000). |
| `ORCA_SESSION_WS_BUFFER_LIMIT_BYTES` | Slow-subscriber buffer limit before the daemon drops it. |

### Debugging the daemon

A live daemon runs in a tmux session named **`daemon-terminal`** — attach to read logs directly. Worker agent sessions also run under tmux.

---

## 12. Key risks and the mitigations baked in

- **PTY stability** across OSes → PTY manager is isolated; sessions are not resumed after restart (boot reconciliation marks `starting`/`running` sessions as failed).
- **Token cost** → event/hook-first architecture, structured summaries, selective reasoning jobs, bounded context. The whole "deterministic core, selective AI" stance exists for this.
- **Memory quality** (auto-promotion can get noisy) → typed memory, confidence/importance scores, canonical status, promotion rules.
- **Workflow over-rigidity** → recommendations over enforcement under Supervised execution (Level 4); the engine adapts, the human teaches.
- **Plugin complexity** → internal-only, frozen registry; no marketplace, no dynamic loading until scoped.

---

## 13. Explicit non-goals (today)

Not built, deliberately: cloud sync, team collaboration, external plugin marketplace / dynamic loading, full cross-goal memory, custom model hosting, a generic chatbot interface, or a VS Code replacement. Several of these have reserved hooks (a `memoryItems` slot in the orchestrator context envelope, the storage-provider seam, the plugin interface shape) so adding them later is additive, not a rewrite.

---

## 14. How we got here — architectural evolution

This section records the **durable shape of the journey**, not a changelog. The detailed plan/spec documents that drove these arcs have been retired; what mattered architecturally is preserved here, and outstanding items pulled from those documents live in `FUTURE_WORK.md`. Arcs are grouped by concern, roughly in the order they landed.

### Adapters and worker permission modes
Orca started with two adapters and grew a third — **`antigravity`** (Google's `agy` CLI) — at model/readiness parity, with completed-turn capture deliberately sourced from Stop hooks + transcript JSONL rather than pane-scraping. Running worker CLIs unattended in background tmux panes surfaced a deadlock: native permission prompts nobody could answer wedged a goal forever. The fix was a per-goal **worker permission mode** (Auto-run vs Ask-in-chat) driven by each CLI's residual-permission hook through a single provider seam (`workerHookConfig()`), so workers stopped being a Claude-hardcoded path. It shipped daemon-core → desktop toggle → "Always allow" native rule writer (Claude) → Codex parity (its `PermissionRequest` hook, plus a `supportsPermissionPersistence` capability gate that hides "Always allow" where the provider can't persist a rule). A live Codex-hooks spike pinned down the durable mechanics (hooks fire only in the interactive TUI, never `codex exec`; `CODEX_HOME` relocation; the exact `PermissionRequest` envelope).

### Workflow step results and supervised completion
A long arc hardened *what a finished step is*. Output schemas became authorable as typed shorthand that round-trips losslessly to the structured `WorkflowStepOutputSchema`. A strict hidden **`WorkflowStepResult`** (lifecycle status separate from evaluation status, with measured quality/performance facts) is persisted per terminal step — measurement only, never gating advancement. Model scoring was pivoted *off* the API-key path onto the existing shadow `approve_step_complete` turn (billing reality, same as the orchestrator itself). Supervision then became the first real autonomy control: a global flag holds each approved+scored step at a `paused_for_input` checkpoint the user can Continue or Revise, and every post-approval refinement persists a `step_revision_signals` divergence row. The user-facing surface consolidated into one **unified, persisted step-confirmation card** (a daemon-built structured summary with collapsible scores), rebuilt durably from the persisted artifact on reload. Two structural guarantees shipped alongside: terminal-reachability graph validation, and **run version pinning** (a `template_snapshot` captured at start so mid-run edits/re-seeds can't leak in).

### The OrcaChat conversational surface
Chat evolved from a single idle stream into a supervision narration layer. A first-class **`activities` table** became the single source of paced, provider-neutral narration (coalesced, throttled, one live bubble per step), with worker questions mediated in Orca's own voice via the held-hook round-trip. The flickering live bubble was then replaced by a **persisted per-turn agent-activity card** that accumulates a hook-derived step checklist with reconstructed diffs and a closing summary. Worker questions became first-class chat messages: users can answer a pending `AskUserQuestion` with arbitrary free text, and answered questions persist into the transcript rather than living transiently in the activity layer.

### Graph-authoritative routing, recovery, ledger, and daemon addressing
Step advancement moved from `ordinal + 1` to a pure **graph traversal engine**: labeled edges, orchestrator-judged gates (`approved`/`rejected` ports, backward edges), an explicit `terminal` flag, a run-level node cursor, and an immutable gate-decision log — with gate-parked cursors treated as resumable on restart, not drift. Provider rate/quota limits became *recoverable*: a typed `ProviderRecoveryCheckpoint` drives a wait/retry/switch state machine that preserves the live session instead of failing the run. The `orca:step-complete` block grew into an envelope (`{ output, ledger_updates }`) so agents *propose* updates that the engine reviews, assigns canonical IDs, and commits as an immutable **versioned ledger** downstream steps read instead of re-parsing transcripts. The daemon became a **discoverable singleton** (`~/.orca/daemon.json` + lock, adopt-or-spawn) reached through a fire-time hook resolver that spools non-interactive hooks to disk and drains them on startup — fixing silent stuck goals (`ECONNREFUSED` on Stop hooks) and orphan-daemon accumulation by removing baked port/token from worker artifacts (the auth token now rotates freely).

### Templates: catalog, onboarding, and the splitter
Templates moved from "seed everything at boot" to a curated **catalog + install-on-selection** model (`GET /catalog` / `POST /install`, boot only reconciles stale built-ins), surfaced through a data-driven onboarding step. Built-ins were reworked to map onto real methods — e.g. **Bug Triage & Fix** onto the systematic-debugging four phases. The capstone was the **splitter node**: a third graph primitive (alongside steps and gates) that reasons over a goal and routes to one of N author-named branches. It powers **`orca/adaptive-delivery`**, a single graph that picks an entry depth and subsumed the separate Brainstorm / Feature-Development / Initiative templates. A deliberate companion was the **honest, participatory brainstorm** rework — a per-step `completionPolicy` (`interview`/`reasoning`/`handoff`) that forbids an interview step from completing while open questions remain, forces a confirmation pause on handoff, and writes a real spec to `.orca/specs/` instead of finishing silently on a metrics card. That participatory voice was later extended from the adaptive-delivery / bug-triage built-ins to the remaining secondary templates (`orca/code-review`, `orca/refactor`, `orca/quality-coverage`, bumped to v3): pause-and-ask at user-owned forks, treat prior step output as untrusted evidence, YAGNI on change steps, and a closing summary rather than a silent finish.

### Workflow composition — the delegate seam (Phase 5E)
Flat graphs gained a **fourth node type** — `delegate` — turning a template into a *central graph that delegates to independently-versioned sub-graphs* (FUTURE_WORK 5.1's highest-payoff lever). A delegate node spawns a child `WorkflowRun` of another template (version-pinned) on the same goal; the parent parks in a new `delegating` status while the child runs as the active leaf, and the parent↔child composition row makes the **delegation stack** durable across restart (depth-guarded, cycle-rejecting). The child's state space is **isolated** — parent values cross in only through the delegate node's `reads` map (seeded as the child's entry artifact) and the child's terminal output crosses back only through `writes` (materialized on the delegate node). The child's typed `inputs` + terminal `outputSchema` are the **composable, versioned interface** those maps validate against (the marketplace's composable unit, I5). The boundary is a first-class harness citizen: a **verdict-gated join**, budget spanning the whole composition, `operating_mode`-derived conflict + launch policy with an auditable `GoalDecision`, belief-divergence at join, and `delegate_spawn`/`delegate_join` `HarnessTransition`s — spawn/join is **control-plane** `DispatchEngine` logic, and child steps ride the existing `RunnerPort` runner-agnostically. It landed as a single-child seam (shaped so fan-out is additive) with one composed built-in dogfood: `orca/scoped-delivery` (Intake → delegate → Deliver) delegating to `orca/scope-brief`.

### Workspaces as first-class entities
"Workspace" was promoted from a per-goal repo attachment into a canonical entity — one workspace == one repo == one canonical path (UNIQUE) — with goal↔workspace made many-to-many via a `goal_workspaces` junction and a real workspace registry (`/v1/workspaces`). Persisted git state was deliberately stripped off the entity; git probing stays transient on inspect. The goal-creation **workspace picker** that builds on this now ships: a "Pick from registered" affordance beside "Browse…" lists registered workspaces and, on select, hydrates through the same `inspect → inspectSucceeded` path the filesystem browse uses (so `pendingWorkspaces` stays source-agnostic); its empty state offers a jump to the Workspaces tab. (In plain-browser mode Tauri's folder dialog is unavailable, so the picker is also the only add-workspace path there.)

### The harness axes (the unifying recent frame)
The most recent and most structural arc operationalizes the four reliability properties from the *Code as Agent Harness* paper — **Executable, Governed, Stateful, Inspectable** — on one durable spine: an engine-owned, append-only **`HarnessTransition`** record emitted at four boundaries (`step_launch`, `step_complete`, `tool_gate`, `mark_done`), each carrying four independently-shippable facets (`RiskFacet`, `EvidenceFacet`, `StateDepsFacet`, `TelemetryFacet`) that *are* the four axes. It is written only by deterministic code — a scoped control-plane slice consistent with "deterministic core, selective AI." The spine is **runtime-enumerable and modular**: the facet/boundary/sensor registries self-register and are guarded at boot (an adapter whose declared `hookContract()` no longer matches its emitted hooks hard-fails startup), the engine is split into the `DispatchEngine` control unit + the `OrchestratorService` reaction layer + a `ProviderRecoveryController` over the `RunnerPort` execution-plane seam, and `GET /v1/harness/registry` + `/v1/harness/hook-contracts` make the substrate introspectable.
- **Executable** — a daemon-side sensor runner executes the full cost-ordered sensor ladder (typecheck/lint/unit/build/static/integration, cheapest first; each fires when its workspace declares the matching script) and applies a **deterministic veto** overriding the LLM judge on a failing verdict (activating the formerly-dead `validation_rule` guardrail). The `EvidenceFacet` additionally carries a deterministic **grounding** block (2026-07-07): steps declare `grounding` checks on the template (five primitives — `paths_exist`, `paths_changed`, `member_of`, `implies`, `subset_of_prior`, each `enforce` or `observe`) and the evidence gate mechanically verifies the checkable claims in the step's structured output (named paths exist, claimed changes reconcile against git state, verdicts are consistent with the step's own findings, references resolve against prior step outputs), with the same veto/route-back semantics as sensor failures. Grounding is deterministic claim verification, **not an execution oracle**: `oracleAdequacy` stays sensor-only, a grounding-only pass caps at the `partially_verified` metrics tier (never "Run & tested"), the refute still fires for grounding-only steps, and the learning loop's `oracleSufficientRate` counts sensor-bearing completions only. All workspace IO rides one `WorkspaceProbe` seam (`pathExists`/`changedPaths` — verdicts and path names, never file contents), a reserved Runner Protocol request for the execution-plane extraction. (`apps/daemon/src/harness-sensors/grounding.ts`; declarations in `templates/catalog.ts`, validated against each step's `outputSchema` by `validate-pipeline.ts`.)
- **Governed** — retired the dormant per-goal `autonomyLevel` integer for the live `operating_mode` (Supervised ⟷ Autonomous), with a deterministic argument-aware risk classifier, permission tiers, a non-disableable critical-action **safety floor**, and approval-streak accountability that can relax a gate via an audited `GoalDecision`. Per-goal `operating_mode` is the source of truth (flipped via `PUT /v1/goals/:goalId/operating-mode`, which scopes its own drain); the global supervision setting now only seeds the default for *new* goals. A **`budget_rule` guardrail** adds a per-workflow / per-step-type spend cap: a pure evaluator denies when the scoped cumulative spend (summed from `step_complete` telemetry cost) reaches the cap, and the control-plane pre-dispatch pass routes the deny by `operating_mode` — escalate to a human launch-approval under `human_review`, hard-stop the run under `automated` (no human is watching an over-budget autonomous step). It ships **inert** — no built-in template carries a cap yet, by design — until one is authored. (Antigravity's gate is the one open coverage hole — it spawns ungated; see `FUTURE_WORK.md`.)
- **Inspectable** — worker-token/cost capture pivoted from hooks to an embedded OTLP/JSON receiver (research proved hooks never carry usage), plus a static price map, categorical failure codes, and a `/harness-metrics` projection with failure attribution. Replay is **keyset-paged, genesis-first** so the oldest transitions are preserved (reconstruct forward from the first event, not a truncated recent window). Live OTLP cost is confirmed end-to-end for Claude (per-step `cost.usd`); the Codex struct-exporter path and its cache-token pricing are still pending. A per-template, cross-run, version-aware metrics surface (`/v1/metrics/templates`) generalizes the per-goal `/harness-metrics` projection: it aggregates the same harness-transition facets across every run of a template, entirely in storage-agnostic TypeScript (no SQLite-specific JSON SQL), for the Metrics tab and the learning loop.
- **Stateful** — tightened the last opaque facet into derived read/write-sets, structured assumptions, version deps, and **optimistic, deterministic conflict + belief-divergence detection** behind a no-op `ConflictJudge` seam reserved for a future LLM judge (detect-and-surface, never auto-merge; no locks). Belief-divergence is **live and live-confirmed end-to-end**: a launch-time workspace version snapshot is compared against the live state at completion, so a step whose workspace moved under it diverges. The launch snapshot is recorded on **every** launch path — `commitAgentStepDecision`'s direct launch *and* `spawnStepAgent` (the bootstrap first step and every advance/gate-routed step); the latter was a real gap (no baseline ⇒ divergence could never fire on a real run) caught by the live smoke and fixed. The conflict policy is **derived from `operating_mode`** (auto-warn-and-proceed under Autonomous, escalate-and-pause under Supervised); read/write-sets key off the step's own `session.workspace_id` (sound for multi-workspace goals); and `mark_done` carries cumulative **write-set and cost** roll-ups (the cost twin sums each `step_complete`'s `telemetry.cost`; null when no step reported one). A **fabrication-rollback** check closes the paper's "synchronize artifacts but not assumptions" gap: on a correction, the corrected output's *new* file-path claims are diffed against the prior attempt and any that don't resolve against the step's `session.workspace_id` root are rejected with a bounded "fix only these" re-revise, while the verified-to-exist claims are recorded as scoped `StateAssumption` evidence-bundle entries (existence-only scope, `verified:true`). The claim resolution reads the working tree behind an injected resolver (execution-plane-movable behind `RunnerPort`); the reject decision stays control-plane.

**Phase 5B — learning loop.** The per-template metrics surface (Inspectable axis, above) feeds a **propose-and-confirm** reflective optimizer — the paper's Evolution Agent / GEPA analog — that mines accumulated revision signals and step scores and, on opt-in manual trigger ("Analyze this template"), produces up to three gated LLM proposals targeting diagnosed failure modes, deterministically routed to one of two revision targets: a template's step `instructions` (rules R1–R3) or, for R4 ("false confidence": high pass rate, weak/absent verification), a tightened step `outputSchema` — the deterministic completion validator (SP2, 2026-07-06). The deterministic core owns which lever is pulled; the LLM only fills the proposal's content. Each proposal carries a full change contract (targeted failure mode, predicted improvement, invariants, falsifier `version_comparison`, rollback plan) and awaits human confirm; apply is a route-gated **privileged in-place write** that can reach locked built-ins (capturing a pristine baseline on the first edit; the generic `PATCH /v1/workflow-templates/:id` stays locked). The falsifier is **forward version-comparison**: after apply, the `versionComparison` projection watches the named invariant dimensions, surfaces a regression alarm above sample threshold, and exposes rollback (prior instructions restored as a new forward version); **restore-to-default** wipes all learning on a built-in back to its captured baseline. The optimizer is per-template only and control-plane-pure — no execution-plane access, no pre-promotion replay, never autonomous. (`apps/daemon/src/learning/`, migration `0049`, `template_instruction_proposals` + `learning_template_baselines` tables, six `/v1/learning/*` endpoints, desktop Self-Improvement rail.)

**SP2 — the second revision target (schema check proposals).** Schema proposals are gated by a **code-enforced mutation whitelist** (`validateSchemaTightening`, checked at broker `validateProposal` time — before any human sees the proposal; the whitelist is deterministic code, not prompt trust): add a field, flip optional→required, extend a description — never delete, rename, retype, alter an enum, or weaken required→optional. This protects the splitter `branchKey` and delegate `writes` composition contracts, which reference existing keys/enum values the whitelist freezes. Migration `0055` adds the persisted `component` column the store previously hardcoded to `step_instructions`. Apply/rollback reuse the same privileged-write machinery (`setStepOutputSchemaInPlace`, sibling of the instructions writer); a human-edited schema that fails the whitelist is refused with a readable error rather than written. A **schema-specific canary** watches `versionInvalidOutputRateDelta` (per-step, per-version invalid-output completion-rate delta, same `VERSION_MIN` gating as the falsifier) and folds a regression flag into the existing alarm above +0.2 — observational only, arming the same rollback affordance, never auto-rolling back. The counterfactual judge (below) frames schema proposals as an output-structure question, unchanged in kind: still imagined execution over persisted outputs. The Self-Improvement panel reached mock fidelity: a review modal (line diff for instructions, field chips for schema — added/strictened), an honest judge display (verdict + sample sizes + expandable reasoning, no invented confidence), an applied-card falsifier line (`targetDelta`/`targetImproved` with the compared version pair), and the canary explanation when tripped. (`apps/daemon/src/learning/schema-mutation.ts`, `canary.ts`; desktop `SelfImprovement.tsx`.)

The learning loop's **evaluate stage** is realized as a **pre-promotion counterfactual judge** (2026-07-04): a human-triggered, isolated (`${templateId}::judge`, spawn+teardown) adversarial shadow turn over a proposal's step's persisted past outputs — bucketed by independent `RefuteFacet`/`EvidenceFacet` ground truth into solved (regression check) and targeted-failure (improvement check) corpora — returning a calibrated write-once `CounterfactualJudgment` (`pass`/`regression_risk`/`uncertain`/`insufficient_evidence`/`unavailable`) persisted on the proposal ledger (`judge_json`, migration `0053`). For SP2 schema proposals the same request frames the question as output-structure evaluation — would the failing outputs have been caught or improved by the tighter required structure — with no change to corpus, hold-out discipline, minimums, or write-once persistence. It **informs, never gates** the human promotion (apply is untouched); it is imagined execution over persisted outputs (real replay-re-run stays deferred to the execution-plane split), control-plane-pure via the `ShadowAsk` seam. (`apps/daemon/src/learning/{judge,corpus}.ts`, routes `/v1/learning/proposals/:id/judge`.)

**SP3 — the learning-event spine, a calibration readout, and the timeline.** Every proposal-lifecycle transition — `created`/`judged`/`applied`/`dismissed`/`rolled_back`/`superseded`/`baseline_restored`, plus an `analyzed` event per "Analyze this template" run recording skips and no-op runs — is now written append-only to `learning_events` (migration `0056`), atomically in the same transaction as the state change it records and stamped with the template version at event time; the `rolled_back` event freezes the falsifier's outcome snapshot (`targetDelta`, the compared version pair, invalid-output-rate delta, regression flag) as computed just before rollback, so rollback evidence survives later version churn. This closes the append-only-spine invariant for the learning loop specifically. Alongside it, a **display-only calibration readout** (`computeCalibration`) compares each evidence tier's designed prior (`TIER_CONFIDENCE`, unchanged) against its measured survival among independently-concluded claims (passes / (passes + refuted), among claims with a refute run alongside), reporting one of three honest states per tier — `measured` (≥5 concluded claims; evidence tiers additionally need ≥50% refute coverage), `insufficient` (too few claims), or `unmeasurable` (`self_reported` carries no independent signal by construction; an evidence tier under the coverage floor). At n≥10, a divergence beyond 0.2 between assumed and measured feeds one deterministic per-step insight line — the score's own coefficients stay fixed; calibration only says how trustworthy a tier's scores have been, never changes what they score. The Self-Improvement rail's activity log is replaced by a plain-language **learning-log timeline**: one line per event, with proposals that predate SP3 (no events exist for them) rendered from a synthesized line derived from the proposal row and visually marked "(before the learning log existed)" so it's never mistaken for a real event. **Caveats:** calibration is observational and windowed (the same recent-transitions window as the rest of `/v1/metrics/templates`, not a decayed all-time rate), and event history starts at SP3 — earlier proposals get only the one synthesized marker, never a full event trail. (`apps/daemon/migrations/0056_learning_events.sql`, `apps/daemon/src/learning/events.ts`, `apps/daemon/src/metrics/verification.ts`, desktop `apps/desktop/src/metrics/learning-log.ts` + `SelfImprovement.tsx`.)

OS sandbox containment (a `SpawnSandbox` no-op seam), the LLM conflict-judge, cross-goal experiential memory, and a self-modifying (autonomous) Evolution Agent remain explicit non-goals.

### Independent refute — the Verify lane (Phase 5.4)
The evidence gate (Executable, above) is an execution oracle — it catches crashes and boundary/perf failures, but nothing caught a green deterministic skeleton wrapped around a self-reported completion an execution oracle structurally can't verify (a no-sensor reasoning step, or an exec step whose sensors passed but didn't cover the requirement). A **refute** pass closes that gap: it runs in `approve_step_complete`, *after* the deterministic gates pass and *before* the completion commits, but only when `shouldRefute` fires — the step's aggregated `tool_gate` risk is `high`/`critical`, or no sensor oracle ran, or the oracle ran with coverage gaps (`EvidenceFacet.oracleAdequacy.gaps`). A well-verified low/medium-risk execution step skips it entirely — the refute is deliberately not universal. The refute itself is a **single, independent, adversarial** shadow-LLM turn (`refuteStepCompletion`), isolated from the approving orchestrator by a dedicated, goal-scoped session key (`${goalId}::refute`, never the bare `goalId`) so it carries none of the approver's context; its prompt is scoped by what the deterministic oracle already covered, so it targets only the unverified surface, and it is instructed to find a concrete, evidence-grounded reason to refute — or to say so. The verdict is **tri-state, calibrated** (`upheld`/`refuted`/`uncertain`), plus an engine-added `unavailable` when the call itself fails after one retry; `uncertain`/`unavailable` escalate to a human rather than guessing. Every refute that runs — any verdict — is recorded as an inspectable `RefuteFacet` (`verdict`, `triggered_by`, `risk_class`, `reason`, `issue_refs`) on the step's `step_complete` `HarnessTransition` (additive `refute_json` column), with a `refute_veto` failure code on a refuted veto — first-class, comparable telemetry for the learning loop (5.2, below). The two autonomy levels consume the same verdict differently: under **L5** (`automated`), `refuted` routes back to `reviseStep` with the bounded issue list (the N=3 `REVISE_CAP` still applies), `uncertain`/`unavailable` escalate to a human pause, and `upheld` falls through to commit — the deterministic core owns every branch, the LLM only fills the verdict. Under **L4** (`human_review`/`handoff`/conflict-pause), the refute is strictly **advisory**: it rides the `pending_completion_json` stash and the confirmation card's lead (`confirmationLead` prepends `⚠️ Independent review disputes/is uncertain about this completion: {reason}` when the verdict isn't `upheld` — `unavailable` gets a "could not be completed" phrasing with no reason clause) plus a structured advisory chip + reason + issue list on the **live pending** confirmation card; after the human resolves it, the structured chip is not rebuilt (`rebuildConfirmedFrame` omits the refute arg) so only the prose advisory persists in the completed-step card's lead. The human stays authoritative; the refute never re-gates on resume.

### Reasoning-first conditioning on judgment outputs (Phase 5.5)

The five core LLM judgment schemas — `StepResultScoringProposal`, `GateEvaluationProposal`, `RefuteCompletionProposal`, `SplitEvaluationProposal`, `JudgeInstructionEditProposal` — now emit a required, leading `reasoning` field ahead of their structured verdicts, so chain-of-thought is generated first and conditions the verdict. The lever is purely in the prompt (each judgment prompt emits `reasoning` first + a reason-first instruction). Reasoning is persisted as an **inspectable reasoning-trajectory**: additively onto `WorkflowStepResult`/`RefuteFacet`/`CounterfactualJudgment` JSON blobs (no migration), and via migration `0054` as nullable `reasoning` columns on `workflow_gate_decisions` and `workflow_split_decisions`. It is bounded at `REASONING_MAX = 2000` chars per the cost spine. The crisp `reason`/verdict/score fields and their consumers remain unchanged. Engine-constructed verdicts (`unavailable`/`insufficient_evidence`) carry null reasoning. **Two caveats:** (1) **Split is future-facing** — the `evaluate_split` LLM evaluator is currently unwired in production (falls to human_review), so the splitter's reasoning-first takes effect only when that transport is wired. (2) **Reasoning adds no independence** — it is the same model justifying its own verdict, composing with 5.4's refute + deterministic sensors rather than replacing them — and persisted reasoning is a *stated rationale*, not verified ground truth (the learning loop corroborates it against independent evidence).

### Paper Auto-RAG
To keep the harness paper's ideas in front of the agent without a manual step, the paper is indexed in a local ChromaDB store (`.orca/paper-index/`, local embeddings, no API key) with a warm query server and `SessionStart`/`UserPromptSubmit` hooks that inject only strong matches and stay silent otherwise. Retrieval is sharpened by local **pseudo-relevance feedback** (two-pass corpus term expansion, no LLM); the bibliography is excluded at index time to keep citation noise out. An earlier `claude -p` query-rewrite was tried and removed (latency) — PRF superseded it.
</content>
