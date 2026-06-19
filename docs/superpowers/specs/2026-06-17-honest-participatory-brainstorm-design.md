# Honest, Participatory Brainstorm Workflow — Design

**Date:** 2026-06-17
**Branch:** `feat/honest-orchestrator-surface`
**Status:** Approved for first implementation pass

## Problem

A user ran the Brainstorm workflow (Frame → Research → Proposal → Critique → Verify → Done) and came away unable to answer two basic questions: *what happened?* and *what's the result?* Three concrete failures drove this:

1. **No participation.** The whole multi-step run completed without asking the user anything. The real decision points — Proposal choosing one of four approaches, Critique flagging a constraint tradeoff — were resolved silently inside autonomous steps. The only questions surfaced were the leftover `open_questions` of the final step, presented *after* the direction was already set.
2. **No live account.** During each multi-minute step the user saw only `Working on the step...` plus raw tool lines (`Read CoordinateStep.tsx`). There was no human-readable narrative of what the agent was doing or why, so the conclusion felt like it materialized from nowhere.
3. **Metrics-first result card.** The step-result card led with QA telemetry (`READY FOR HANDOFF`, five quality percentages, `N artifacts · N blockers`). The only prose was the mediator's *scoring justification*. The actual product of the step — the recommendation, the chosen direction — was invisible, and the artifact was a count, not a link.

## Root-Cause Map

| Symptom | Layer | File |
|---|---|---|
| No participation | Step instructions discourage asking; no structural completion gate | `apps/daemon/src/workflows/templates/catalog.ts` |
| Questions only at the end | `open_questions` is a passive output field; nothing forces resolution | `catalog.ts` + mediator |
| No live account | Mediator narrates only at step boundaries, in process-voice | `apps/daemon/src/orchestrator-llm/prompts.ts` |
| Metrics-first card | Card leads with scores; only prose is the score `reason` | `apps/desktop/src/orchestrator/ActivityThread.tsx` |

## Two LLM Surfaces (context)

- **Step agents** — autonomous shadow sessions. Each receives goal + step instructions + output schema + prior outputs, works alone, and emits a `orca:step-complete` JSON block (`prompts.ts:composeAgentInitialPrompt`).
- **Mediator** — sits between the user chat surface and the active step agent; returns exactly one action per turn: `paraphrase_agent_message`, `forward_to_agent`, `approve_step_complete` (with scoring), `ask_user`, `revise_step`, `escalate_to_user` (`prompts.ts:composeOrchestratorPrompt`).

## Design Decisions (locked)

- **Participation model:** pause at *any material fork* — a decision point where options genuinely diverge and the choice is the user's (product/scope/UX). Not trivial mechanical choices.
- **A step is not "done" while anything is pending.** Pending items surface *during* the step as a live `ask_user` prompt; the step sits in a "waiting on you" state with no result card. The result card is terminal and only appears once nothing is pending.
- **Narration:** both — a plain-English activity feed as the reliable backbone, plus agent-authored reasoning notes layered in.
- **Result card:** leads with the plain-English result; scores demoted to a collapsed drawer.
- **Enforcement:** structural per-step `completionPolicy`, not instruction-only.
- **Scope:** step-instruction rewrites are **Brainstorm only** in this pass. Engine/UI changes (narration, card, completion logic) are cross-cutting and apply to every workflow automatically.

## Components

### 1. Completion policy (structural)

Add a per-step field to the workflow step template in `@orca/contracts`:

```
completionPolicy: "interview" | "reasoning" | "handoff"  // optional, default "reasoning"
```

`WorkflowStepTemplate` (`packages/contracts/src/workflows/index.ts:274`) is a `.strict()` Zod object, so the field **must** be added to the schema (as an optional enum defaulting to `reasoning`) or parsing rejects it.

Semantics, enforced in the completion path + mediator:

- **`interview`** (Frame): cannot complete while `open_questions` is non-empty. A **deterministic backstop** in the completion check refuses `approve_step_complete` when an interview step's output has non-empty `open_questions`. The step drains the queue via `ask_user`, then presents its synthesized result and requires explicit user confirmation before completing. `open_questions` is a *working queue*, not a deliverable.
- **`reasoning`** (Research, Proposal, Critique, Verify): pauses at any material fork via `ask_user`; cannot complete while a decision is pending.
- **`handoff`** (Done): `open_questions` is a legitimate non-blocking deliverable; recorded on the result card, does not block completion. A handoff step does **not** auto-complete: it pauses for user confirmation of its produced artifact (the spec) before completing — see §6.

Default for steps that don't set it: `reasoning`. Only Brainstorm steps are assigned explicit policies in this pass (Frame=interview, Research/Proposal/Critique/Verify=reasoning, Done=handoff).

Built-in templates are persisted via a version-guarded upsert from the catalog (`apps/daemon/src/workflows/templates/usecases.ts:177 upsertBuiltInTemplate`), not a hand-written migration. Bumping the Brainstorm template `version` in `catalog.ts` refreshes the stored rows with the new field. Implementation should confirm the step storage shape (JSON blob vs. typed columns) to ensure the new field flows through the upsert.

### 2. Step instructions (Brainstorm only — `catalog.ts`)

**Frame** (locked):

> Interview the user relentlessly, from a product perspective, until you reach a shared, unambiguous understanding of what they want to build and why. You may inspect the workspace to orient yourself on what the product is and what the user is working with, but stay in a product frame — do not analyze the code technically or begin designing how to solve the goal; the next step handles technical grounding and approaches. Walk down each branch of the design tree, resolving dependencies between decisions one at a time, and pursue every aspect that materially shapes the intent, hard constraints, and what success looks like. Ask exactly one question at a time and always offer your recommended answer. Treat open questions as a working queue you must drain, not an output field. When no questions remain, present your synthesized frame (problem, success outcome, constraints) and ask the user to confirm or revise. Complete only after the user confirms.

The six steps mirror obra's brainstorming process: Frame (clarify) → Research (explore the codebase) → Proposal (2–3 approaches + recommendation, YAGNI) → Critique (isolation/clarity pressure-test) → Verify (validate the design facets) → Done (write the spec + hand off).

**Research** *(reasoning)*:

> Ground the confirmed frame in the current codebase before any solution is proposed. Explore the existing structure and follow established patterns; identify the smallest set of files, modules, and constraints the work would touch, the risks the framing missed, and any existing problems in this area that would affect the work. Do not propose approaches yet. When the codebase reveals a decision that genuinely diverges and is the user's to make, pause and ask with concrete options and a recommendation rather than resolving it silently.

**Proposal** *(reasoning)*:

> Propose two or three genuinely different approaches grounded in the research, each with explicit tradeoffs, then lead with your recommended one and the reasoning behind it. Apply YAGNI ruthlessly — cut any scope, abstraction, or flexibility the goal does not require. Stay pre-implementation: make no code changes. When the choice between approaches is the user's to make (a product, scope, or UX fork), pause and ask with the options and your recommendation rather than selecting silently.

**Critique** *(reasoning)* — challenges the approach the **user chose**, which may differ from Proposal's recommendation:

> Challenge the approach the user chose — which may differ from Proposal's recommendation — in a fresh context, treating prior step output as untrusted evidence. Pressure-test it for isolation and clarity: does it break into smaller units with single, clear purposes and well-defined interfaces; can each be understood and tested without reading the others' internals; can internals change without breaking consumers? Surface second-order risks, gaps, and failure modes, and state whether it is sound enough to proceed. When a concern exposes a decision that is the user's to make, pause and ask with concrete options and a recommendation.

**Verify** *(reasoning)*:

> Validate the chosen approach against the success outcome and hard constraints before it advances. Confirm it is feasible and that the design accounts for the facets it touches — component boundaries, data flow, error handling, and testing — and that the acceptance signals are concrete and checkable. When validation surfaces an unresolved decision that is the user's to make, pause and ask with options and a recommendation rather than assuming.

**Done** *(handoff)* — persists the spec to disk and reports back:

> Record the durable design and persist it as a spec artifact. Determine the goal's target workspaces: if the goal runs in a single repository, save the spec to `.orca/specs/<YYYY-MM-DD-topic>.md` in that workspace; if the goal spans multiple workspaces, pause and ask the user whether to write it to all of them or a single/subset before saving. The spec must capture a concise summary, the chosen direction with its rationale, and any open questions for the next workflow. Before saving, self-review the design for placeholders, internal contradictions, scope creep, and ambiguous requirements, and resolve what you can. Make no code changes. When complete, present the user a clear closing summary of what was decided and where the spec was saved — do not finish silently.

#### Output-schema changes (`catalog.ts`)

- **Proposal**: add `chosen_approach: string` (required) — the approach the user selected at the fork, with their rationale; distinct from `recommendation`. Critique, Verify, and Done all reference the chosen approach.
- **Done**: add `artifacts: [{ type, reference, description }]` (the existing artifact convention used by the Feature workflow) — emit `type: "spec"`, `reference:` the saved `.orca/specs/...` path. The result card's "View artifact" link hangs off this.

#### Done step behavior notes

- The spec-save decision is a **fork**, not an `open_questions` entry. `handoff` policy means `open_questions` doesn't *block* completion — it does **not** mean the step can't ask. Multi-workspace → `ask_user` with the workspace options and **no recommended/default option** (the user must choose explicitly).
- Done's context must include the goal's **target-workspace list** so it can distinguish single- from multi-workspace and write to the correct path(s) — a context-assembly requirement.
- "Don't finish silently": the terminal closing summary is both the result-card headline (Section 4) **and** an explicit mediator closing message in chat.

### 3. Narration during steps (engine/UI — all workflows)

- **Activity-feed backbone:** translate the existing `tool_use` activity stream into plain-English actions, replacing raw renderings like `Read CoordinateStep.tsx`. Reliable and cheap; guarantees the user always sees motion.
- **Reasoning notes:** add a prompt convention so the step agent emits short first-person progress/reasoning notes as its thinking shifts. Surfaced inline in the activity thread. Tune to avoid noise; the backbone covers gaps when the agent is quiet.

### 4. Result card (engine/UI — all workflows — `ActivityThread.tsx`)

- Renders only when the step is genuinely done (nothing pending).
- Leads with the step's own `summary` plus the headline result field for the step (e.g. Proposal's `chosen_approach`, Done's `chosen_direction`) and a link to open the artifact (e.g. Done's saved spec).
- Quality scores, the score `reason`, `handoffReady`, and artifact/blocker/warning counts move into a collapsed "details" drawer.

### 5. Mediator (engine — `prompts.ts`)

- Honors `completionPolicy`: never `approve_step_complete` while a blocking item is pending (interview step with non-empty `open_questions`, or a reasoning step with an unresolved fork) — `ask_user` instead.
- Still scores on approval; scores now render in the card's drawer rather than as the headline.

### 6. Done persistence + confirmation (Phase 3)

How the Done step persists the spec and gets the user's sign-off. Design decisions (locked):

- **Agent authors and writes the file; daemon verifies and records.** Spec documents are large, complex markdown (existing specs run 8–30 KB with code fences and tables), so routing the content through the structured `orca:step-complete` JSON → synthesis → validation pipeline is fragile (escaping, payload budgets). Instead the Done agent writes the file directly with its file tools to `.orca/specs/<YYYY-MM-DD-topic>.md` and reports the path(s) in its `artifacts[]` output. On completion the daemon **verifies** the reported file(s) exist under `.orca/specs/` and records the `spec` artifact. The daemon does not author or validate the markdown body — it catches the failure mode that matters (no file written). This makes Done the first Brainstorm step that writes to disk, by design.
- **Workspace list in the Done agent's prompt.** `composeAgentInitialPrompt` (and its caller) must include the goal's attached workspaces (name + root) so the Done agent knows single- vs multi-workspace and the exact path(s) to write.
- **Multi-workspace: the agent asks mid-step.** Given the agent owns the write, it also owns the "which workspaces?" fork via the Phase 2 `ask_user` path (no default/recommended option), then writes to each chosen target. The daemon verify step confirms the file(s) landed where expected.
- **Confirm-before-complete (applies to `handoff`).** A handoff step does not auto-complete. After the spec is written, Done pauses on the existing **confirmation checkpoint** (`pauseForConfirmation`/`resumeFromConfirmation`), surfacing the spec path + `chosen_direction`/summary for review — **regardless of global supervision mode**. The user either confirms ("Continue" → Done completes → daemon verifies/records → closing summary) or types adjustments in chat (→ `forward_to_agent` → the Done agent rewrites the spec file → re-present). This reuses the proven supervised-completion machinery; the only new behavior is forcing the pause for `handoff` steps even in autonomous mode.
- **Closing summary, not silent finish.** On confirmed completion, post a chat message naming what was decided and where the spec was saved (also the result-card headline, §4).

## Data Flow

1. Step agent runs; emits plain-English activity (backbone) + reasoning notes (inline) into the activity thread.
2. On a material fork or unresolved open question, agent asks → mediator emits `ask_user` → user answers → mediator `forward_to_agent` → loop.
3. Interview step: queue drained → agent presents synthesized result → user confirms → completion check passes.
4. Mediator `approve_step_complete` with scoring → terminal result card renders, result-first, scores in drawer.
5. Done step: writes the spec to `.orca/specs/` in the target workspace(s) (asking the user which, when multi-workspace), emits a `spec` artifact, and the mediator posts a closing summary naming what was decided and where the spec was saved.

## Testing

- **Completion invariant:** unit test that the completion check refuses to approve an `interview` step whose output has non-empty `open_questions`, and approves once empty.
- **Mediator rule:** test that an interview step with pending questions yields `ask_user`, not `approve_step_complete`.
- **Card rendering:** `ActivityThread` test asserting the result summary is the headline and scores are in the drawer; and that no result card renders while the step is pending.
- **Instructions:** snapshot/catalog test confirming Brainstorm step `completionPolicy` assignments and the presence of the fork clause.
- **Narration:** test that `tool_use` activity renders as plain-English actions.
- **Schema:** catalog/contracts test confirming Proposal has required `chosen_approach` and Done has the `artifacts` field.
- **Done persistence:** test that a single-workspace goal writes the spec to `.orca/specs/` and emits a `spec` artifact; that a multi-workspace goal pauses with an `ask_user` carrying no default option; and that completion produces a closing summary message.

## Non-Goals

- Rewriting instructions for non-Brainstorm workflows (Feature, Bug, Refactor, Initiative, Quality, Code Review). They inherit the engine/UI changes only.
- A visible gate node for the open-questions check — enforced as a completion invariant, not a graph node.
- Per-item agent classification of "blocking vs note" — the step's `completionPolicy` decides.
- Changing scoring math or the set of quality dimensions.
