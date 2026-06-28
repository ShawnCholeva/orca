---
name: orca-dev-loop
description: >
  Use when you want an agent to put itself in a development loop against the
  running Orca web app: drive a user-defined task in the browser with Playwright,
  observe every problem it hits as a user, fix each at the root, then repeat the
  task until the experience is correct. Triggers: "drive the app and fix what you
  see", "dogfood Orca", "the run/UI looks stuck/broken", "exercise this and
  harden it", "loop until correct". Steerable task — not necessarily reaching a
  workflow's Done.
---

# Orca Dev Loop

## Overview

Put yourself in a loop against the **running Orca web app** through Playwright:
perform a **user-defined task**, observe **every problem you hit as a user**,
root-cause and fix each **at the substrate — not the symptom**, rebuild/restart,
then **repeat the same task until the experience is correct** (a clean pass with
no new problems).

**The task is steerable.** It might be "run a goal through a workflow to Done,"
but it might just as well be "evaluate the goals list," "stress the permission
card," or "check whether X feels responsive." Drive whatever the user points you
at. The exit criterion is *correctness*, not any particular workflow node.

**Core principle:** if you didn't drive it as a user and watch it, you don't
know what's broken.

## NON-NEGOTIABLE: every fix follows the harness principles

Before designing **any** fix in this loop you MUST read and conform to:

- **`FUTURE_ARCHITECTURE.md`** — confirm the fix moves toward (or at least does
  not preclude) the end-state spine: deterministic control-plane owns
  lifecycle/routing/gates; control-plane / execution-plane split; the Runner
  Protocol; human-authoritative completion.
- **`agent-harness.pdf`** principles (auto-RAG injects relevant passages each
  turn; query it directly via `scripts/paper-rag/query.py` when designing a fix):
  - Code is the **harness boundary** between model intent and the environment —
    fix the boundary, not the surface.
  - **Inspectability**: status, state, and progress must be honest and traceable
    (no spinner over stopped work, no silent block, no phantom activity).
  - **Plan → Execute → Verify** with permissioned state transitions and HITL
    gates at safety boundaries.
  - Treat each observed problem as **telemetry that drives a harness revision** —
    a comparative improvement you can re-run and confirm, not a one-off patch.

Consult `ORCA.md` for how a subsystem works **today**. **Flag in your response**
whenever a fix would conflict with the spine. A fix that only hides the symptom
is a failed iteration.

## When to use

- Dogfooding any part of the app and fixing what you find as you go.
- A task/run/UI looks stuck, broken, or confusing and you need to drive it,
  reproduce, and fix the cause.
- Hardening the substrate by running real user flows through it until clean.

**Not for:** a unit bug with a known repro (use superpowers:systematic-debugging
directly) or a pure CSS tweak (use `pnpm dev:browser` directly).

## Steering inputs — ASK FIRST

If unspecified, ask before starting — this is where the user steers direction:

| Knob | Notes |
|------|-------|
| **Task / direction** (REQUIRED) | What to do or evaluate in the app this iteration. |
| Exit criterion | Default: a full pass of the task with **no new problems**. User may set a specific correctness bar instead. |
| Focus | What class of problems to prioritize (responsiveness, honest status, dead-ends, message clarity…). |
| Workspace / orchestrator model / workflow template | Only when the task involves creating or running a goal. |
| Supervision | Supervised (you confirm each park) vs auto-run. |

## Environment prep (once per loop)

1. **Run the daemon from built dist, not `tsx watch`.** A task that edits
   daemon/contract *source* (e.g. an Execution worker) reloads and crashes a
   tsx-watched daemon mid-run. Dist is immune:
   ```
   pnpm --filter @orca/contracts build && pnpm --filter @orca/daemon build
   node apps/daemon/dist/index.js &        # discovery at ~/.orca/daemon.json
   ```
2. **`pnpm dev:browser`** — serves the frontend against the live daemon via a
   proxy that survives daemon restarts (no token in the client). See CLAUDE.md.
3. **Playwright MCP** (`mcp__playwright__*`) — your eyes and hands on the UI.

## The loop

1. **Do the task in the app via Playwright** — navigate, snapshot, click, type,
   screenshot — exactly as a user would.
2. **Observe every problem** (rubric below). Write each one down **verbatim**
   with where it happened.
3. **Fix each at the root** — see Fix loop. Honor the harness principles above.
4. **Rebuild + restart** the dist daemon.
5. **Repeat the same task.** Exit when a full pass surfaces **no new problems**
   (or the user's correctness bar is met).

## Observe rubric (the user's seat)

Judge as a user, not an operator:

- Does each message make sense — does it say what's happening / what's needed?
- Does the UI show work is happening, or does it look frozen?
- Is status **honest and inspectable** — no live spinner over stopped work, no
  silent block, no phantom activity, no stale "Working…"?
- Are dead-ends reachable — a state the user can't progress or recover from?
- Did anything require out-of-band poking a real user couldn't do?

## Two control surfaces

- **Playwright MCP = eyes + primary hands.** This is how a user drives it; it's
  also how you *see* problems. Prefer it.
- **Daemon HTTP API = reliable hands when the UI can't drive.** An in-task edit
  can HMR the frontend white; the API lets you keep the task moving and is also
  the precise way to read/advance a workflow run. Auth:
  `Authorization: Bearer <token>` from `~/.orca/daemon.json` (every route except
  `/v1/health`). Helpers: `scripts/peek-pending.mjs <goalId>` (read latest
  pending) and `scripts/approve-pending.mjs <goalId>` (conditional approve).

## If the task is "run a goal through a workflow"

The engine parks on a small fixed set of node kinds for **any** template; drive
all of them (state path is `/v1/goals/:goalId/workflow-runs/:id`; action path is
the shorter `/v1/workflows/runs/:id` — don't mix them):

1. Create + start: `POST /v1/goals/create-and-start-workflow`
   `{title, description, workspaces, orchestratorModel, workflowTemplateId}`.
2. Auto-run (optional): `PUT /v1/goals/:goalId/worker-permission-mode
   {workerPermissionMode:"auto"}` and/or `PUT /v1/goals/:goalId/operating-mode
   {operatingMode:"automated"}`.
3. Read state: `GET /v1/goals/:goalId/workflow-runs/:id` →
   `run.{status, currentNodeId, currentNodeKind, blockedReason, pendingSplitChoice}`.
4. Drive the park:

   | Park kind | Action |
   |-----------|--------|
   | step | `POST /v1/workflows/runs/:id/confirm-step` (no body) |
   | splitter | `POST /v1/workflows/runs/:id/confirm-split` (`{branch}` when `pendingSplitChoice` asks for a human route) |
   | gate | `POST /v1/workflows/runs/:id/confirm-gate` (no body) |
   | decision gate | `POST /v1/workflows/runs/:id/decide-gate {outcome:"approved"\|"rejected", reason?}` |
   | worker question | `POST /v1/goals/:goalId/worker-questions/:questionId/answer {answers\|freeText}` |
   | permission request | in `GET /v1/goals/:goalId/orchestrator-messages` as `pendingApproval` → `POST /v1/goals/:goalId/permission-approvals/:approvalId {decision}` |

5. Loop until `run.status === "completed"` or it blocks.

**Never blanket-allow permissions.** Auto-allow only reversible read/edit tools
in a git-tracked repo; surface Bash, network, and destructive tools for explicit
human review (`approve-pending.mjs` enforces this — it embodies the HITL safety
gate from the harness principles).

## Fix loop (per observed problem)

1. **Root-cause it.** REQUIRED: superpowers:systematic-debugging. No symptom
   patches. Use general-purpose subagents to trace; don't guess.
2. **Aim at the substrate.** REQUIRED reading before designing the fix:
   `FUTURE_ARCHITECTURE.md` + the `agent-harness.pdf` principles (see top).
3. **Fix with TDD.** REQUIRED: superpowers:test-driven-development. Failing test
   first. Delegate implementation to a `fork` subagent (inherits context).
4. **Rebuild + restart.** `pnpm --filter @orca/contracts build && pnpm --filter
   @orca/daemon build`, then restart the dist daemon. Always rebuild contracts
   when you touch them — stale contracts dist is what crashes the daemon.

## Common pitfalls (from real runs)

| Symptom | Cause → fix |
|---------|-------------|
| Daemon crashes mid-task after files are edited | Running under `tsx watch` → run from `dist`. |
| Daemon won't boot; TS errors about contract types | Contracts dist stale → `pnpm --filter @orca/contracts build`. |
| UI goes white mid-task | An in-task edit HMR'd the frontend → drive via the API; keep going. |
| Blanket `{decision:"allow"}` rejected by the classifier | Use the conditional approver (safe tools only), surface the rest. |
| Splitter parks with empty routing signal / falls to unwired broker | Needs a human routing choice → supply `{branch}` to `confirm-split`. |
| "Working on step…" lingers with no activity thread | Dishonest status — an observation to **fix**, not wait out. |
