# ORCA

The single durable guide to this project. It explains **what Orca is, why it is shaped the way it is, and where things live** — enough orientation for a human or an AI agent to work productively here.

**The codebase is the source of truth.** This document informs direction and decisions; it deliberately avoids anything that rots (line counts, test counts, milestone status, exact schemas). When this file and the code disagree, the code wins — fix this file.

---

## 1. What Orca is

Orca is a **local-first desktop application for multi-agent AI orchestration**. It coordinates multiple AI agent sessions (Claude Code, Codex) around long-running engineering **Goals** by preserving operational reasoning, managing shared context, and progressing through five autonomy levels under human supervision.

The problem it solves: AI coding agents are individually powerful but operationally disconnected. Across many sessions, reasoning fragments, decisions are lost, context drifts, and humans become the coordination bottleneck. Orca is a shared operational reasoning layer *above* the agents — it coordinates native execution environments instead of replacing them. Claude Code still feels like Claude Code.

**What it is not:** a chatbot UI, an IDE clone, a prompt manager, a Jira replacement, or an autonomous-demo agent.

The current implementation target is **Level 3 autonomy** (suggested orchestration with human supervision), built so reaching Level 4 does not require an architectural rewrite.

### Autonomy levels (the product's spine)

1. **Manual** — user coordinates sessions and context by hand.
2. **Shared context** — sessions become aware through shared Goal memory.
3. **Suggested orchestration** — orchestrator recommends tasks/sessions/workflows, synthesizes reasoning, detects conflicts, escalates ambiguity. Human supervises and teaches. **← current target.**
4. **Supervised execution** — orchestrator runs flows and pauses at approval gates.
5. **Autonomous execution** — exception-based human oversight.

The goal is not maximum autonomy. It is **operational coherence** built safely, level by level.

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
| Migrations | `migrations.ts` + `apps/daemon/migrations/*.sql` | Ordered, append-only SQL migrations. |

Inside `workflows/`:

- `templates/` — workflow definitions (e.g. `seed-engineering.ts`, the `orca/engineering` template) and validation pipeline.
- `runs/` — run lifecycle.
- `steps/` — per-step run state.
- `orchestrator/` — the mediation engine: step dispatch, agent interview, judgement, revise loop, crash retry, idle timeout, resume, worker sessions/questions, synthesis.
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

- **Step completion is hybrid-gated:** agent proposes structured output → engine validates against `outputSchema` (deterministic) → orchestrator-LLM judges satisfaction. Neither alone decides.
- **Engine owns the lifecycle; the LLM never drives deterministic transitions.** The orchestrator-LLM does not get tool-call freedom to spawn agents or advance steps. This keeps progression predictable and cheap.
- **Agent selection is template-declarative,** not LLM-selected. Each step carries an ordered `agentPreference[]` of `{adapterId, modelId}`; the resolver picks the first ready adapter that supports the model, with fallback. Template authors match model weight to workload (cheap conversational models for interview/QA; heavier reasoning for synthesis/decomposition/review).
- **Run progression is event-driven** after creation — the engine reacts to user messages, agent hooks, crashes, and idle timeouts. There is no central polling loop.

### The `orca/engineering` workflow

The default template runs 8 steps, each with its own output schema validated at completion:

`intake → research → prd → issue_breakdown → execution → qa → review → done`

`execution` carries a `validation_required` guardrail (the schema requires `validation.ran && validation.passed`); a red validation becomes revise feedback to the agent. `done` captures memory items. The only enforced user yield is `approval_mark_done` at the end.

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

There are exactly **two agent adapters: `claude-code` and `codex`** (`packages/contracts/src/adapters/ids.ts` is canonical). Earlier docs mention opencode and a shell/manual adapter — those have been removed/are historical; trust the contract enum.

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

The orchestrator context envelope is bounded (~64 KiB); when over budget it truncates oldest agent turns first, then earliest prior-step artifacts, and **never** truncates current-step or goal metadata. Right-sized context is a first-class cost and quality concern.

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
| `ORCA_PORT` | Daemon HTTP port (default 8787). |
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
- **Workflow over-rigidity** → recommendations over enforcement at Level 3; the engine adapts, the human teaches.
- **Plugin complexity** → internal-only, frozen registry; no marketplace, no dynamic loading until scoped.

---

## 13. Explicit non-goals (today)

Not built, deliberately: cloud sync, team collaboration, external plugin marketplace / dynamic loading, full cross-goal memory, Level 4/5 autonomy, custom model hosting, a generic chatbot interface, or a VS Code replacement. Several of these have reserved hooks (a `memoryItems` slot in the orchestrator context envelope, the storage-provider seam, the plugin interface shape) so adding them later is additive, not a rewrite.
</content>
