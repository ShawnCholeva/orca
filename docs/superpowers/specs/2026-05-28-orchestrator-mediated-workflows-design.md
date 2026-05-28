# Orchestrator-Mediated Workflow Runs — Design

**Date:** 2026-05-28
**Status:** Approved design, pre-implementation.
**Scope:** Restructure workflow execution so a user-selected orchestrator-LLM mediates every interaction between the chat surface and per-step agents. Every step spawns an agent; orchestrator-LLM judges step satisfaction; the run is autonomous up to a single yield point at run completion.
**Supersedes (in part):** `2026-05-27-instruction-driven-workflow-steps-phase2-design.md` operator-routing semantics. Phase 1+2 transport (`one_shot`, `hidden_interactive` / shadow session) and the agent step lifecycle are retained and reframed under the new model.

## Context

Today the orchestrator picks one operator per step (model OR agent kind) via an LLM selector, and either runs the step inline as an LLM call (`run_step_skill`) or hands the step to a PTY agent that produces structured output via parse-then-synthesize. The user has no consistent conversational partner: model-path steps surface `request_user_input` cards; agent-path steps run in their own terminal; cross-step continuity comes from artifacts but the user-facing voice changes per step.

The user wants a different shape: one persistent orchestrator-LLM (whichever model/provider they chose at goal creation) is *the* point of interaction. It mediates every message between the user and the per-step agents it spawns. The user yields only at run completion.

## Goals

- A user-selected orchestrator-LLM is the sole conversational partner in the chat surface for a goal/run.
- Every workflow step spawns an agent. The orchestrator-LLM mediates messages; the agent does the step work.
- Step completion is gated by a hybrid check: the agent proposes a structured output, the engine validates against `outputSchema`, the orchestrator-LLM judges satisfaction.
- The orchestrator drives the workflow autonomously from goal-create through all steps; the only user yield point is the final mark-done confirm.
- Adapter execution-mode capability is declared in code and runtime-toggled via DB-backed config. Flipping a mode for any adapter is a one-row edit.
- Orchestrator-LLM dispatch and per-step agent dispatch use the same adapter layer (unified billing/mode semantics).

## Non-Goals

- Memory engine integration. Context assembly leaves a hook for future memory items; no implementation of extraction/promotion in this design.
- Orchestrator-LLM tool-call freedom (the LLM doesn't spawn agents directly via tool calls; engine drives deterministic lifecycle).
- LLM-based per-step agent kind selection. Agent preference is template-declarative (an evolution path is recorded; not built now).
- Adapter implementations beyond claude-code. codex/opencode/etc. land later; their adapter-config rows are seeded for forward compatibility.
- Full autonomous run completion (Level 5). The mark-done yield point is retained.

## Concepts

- **Orchestrator-LLM**: the user-selected LLM (model + provider) attached to a goal at goal-create. Persistent conversational partner across the run; mediates every user/agent message; judges step satisfaction. Goal-scoped session lifecycle.
- **Per-step agent**: an agent session spawned at the start of each workflow step, terminated when the step completes. Does the step's work (interview, edits, validation). Receives messages from orchestrator-LLM; emits responses through its native "response-done" hook.
- **Adapter**: the unified dispatch layer. Both orchestrator-LLM and per-step agents route through adapters. Adapter capability declared in code; runtime mode config stored in DB.
- **Execution mode**: how an adapter dispatches a turn. Either `shadow_session` (long-lived PTY, hook-based response detection) or `one_shot` (single request/response per turn).
- **Internal-thought row**: a chat-surface element styled distinctly from messages. Conveys orchestrator/engine state (step transitions, thinking, retries, validation results) without occupying the conversational channel.

## Architecture changes

### Adapter execution-mode configuration

Each adapter declares its technical capability in code:

```ts
// adapter manifest
{
  id: "claude-code",
  supportedExecutionModes: ["shadow_session", "one_shot"],
  // ...other capability fields
}
```

Runtime configuration lives in the DB:

```sql
CREATE TABLE adapter_execution_modes (
  adapter_id           TEXT PRIMARY KEY,
  enabled_modes_json   TEXT NOT NULL,   -- [{mode: ExecutionMode, preferred?: boolean}]
  disabled_modes_json  TEXT NOT NULL,   -- [{mode: ExecutionMode, reason: string}]
  updated_at           TEXT NOT NULL,
  updated_by           TEXT             -- nullable: "system_seed" | "user" | "settings_api"
);
```

Schema invariants (validated on every mutation):

- Exactly one entry in `enabled_modes_json` has `preferred: true`.
- `enabled ∩ disabled = ∅`.
- `enabled_modes_json` non-empty.
- Every mode referenced in either array must appear in the adapter's code-declared `supportedExecutionModes`.

Seed on daemon boot: for each registered adapter, `INSERT OR IGNORE` a row using adapter-declared defaults. Future adapter capability changes ship in code; the row's enabled/disabled split is migrated separately (admin tool or migration).

Toggling: mutation API validates invariants, updates the row, appends an `adapter.execution_modes.changed` event for audit. UI/CLI surfaces wrap the same API.

MVP defaults (initial seed values):

```ts
// claude-code
{
  enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
  disabledExecutionModes: [
    { mode: "one_shot",
      reason: "post 2026-06-15 the -p flag bills against API budget; shadow_session uses interactive subscription" }
  ]
}
// codex
{
  enabledExecutionModes: [
    { mode: "one_shot", preferred: true },
    { mode: "shadow_session" }
  ],
  disabledExecutionModes: []
}
// opencode
{
  enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
  disabledExecutionModes: [{ mode: "one_shot", reason: "adapter does not implement one-shot yet" }]
}
```

Dispatcher uses the preferred enabled mode; on failure tries other enabled modes in declared order; never attempts disabled modes.

### Session topology per run

- **One orchestrator-LLM session per goal/run**. Spawned at goal-create (after the run starts). Goal-scoped; reused across every step. Mode selected by orchestrator adapter's preferred enabled mode.
- **One per-step agent session per step**. Spawned at step start, terminated at step satisfaction (or hard failure). Not reused across steps. Mode selected by per-step adapter's preferred enabled mode.

Both are full sessions in the daemon's session manager; both register adapter-specific response-done hook callbacks at spawn.

### Workflow step lifecycle

Deterministic engine drives lifecycle. Orchestrator-LLM owns judgement.

```
step N start (engine, deterministic)
  resolve agent + model:
    walk template.agentPreference[]
    pick first entry where adapter is ready AND adapter supports entry.modelId
  resolve execution mode:
    pick adapter's preferred enabled mode
  spawn per-step agent session (or one_shot dispatcher)
  compose initial agent prompt:
    step.instructions + step.outputSchema
    + bounded prior-step artifacts (one per prior step, only the validated output JSON)
    + the orca-output / orca:step-complete emission convention
  register response-done hook callback for this session
  emit internal-thought row: "step N start, spawning <adapter>"

loop until step satisfied:

  on agent response-done hook fires:
    engine reads response payload from hook (adapter-normalized; transcript path for CC, SDK return for others)
    invoke orchestrator-LLM via the goal's orchestrator session, with context:
      goal metadata, run metadata, current step metadata,
      conversation (chat + current step agent turns),
      prior-step artifacts (validated outputs only, bounded)
    orchestrator-LLM outputs:
      - paraphrased message for chat
      - if agent emitted <orca:step-complete>{...}: a judgement (approve | revise(feedback))
    engine:
      post paraphrased message to chat (with collapsible raw transcript link)
      if step-complete proposed:
        validate JSON against outputSchema (deterministic)
          invalid: synthesize validator-error feedback, increment revise counter, send to agent (N=3 cap)
          valid:
            orchestrator-LLM judgement applied:
              approve: persist step_output artifact (source: agent), terminate session, advance step
              revise: send feedback to agent, increment counter (N=3 cap)
      else: agent continues working (no completion proposed)

  on user message arriving in chat:
    queue the message (concurrent-input policy)
    invoke orchestrator-LLM with updated conversation
    orchestrator-LLM outputs one of:
      - "forward to agent" with translation: engine writes to per-step session stdin (shadow)
        or composes the next one_shot turn for the agent
      - "answer directly in chat": engine posts orchestrator's chat message; no agent dispatch
      - "request scope change" (e.g. mid-run new ask): orchestrator-LLM may produce a yield-style
        chat message offering options to the user; this is an LLM judgement, not an engine yield

  on agent crash / session exit unexpectedly:
    engine logs; emits internal-thought row
    invoke orchestrator-LLM with context + crash details
    LLM picks: respawn fresh attempt (engine resets per-step session, attempt counter ++)
               or escalate to user (post chat message describing failure + asking for guidance)
    cap at 3 fresh attempts before forced escalation

  on response-done hook silent (no hook fired within 90s of last output activity):
    engine idle-timeout: read session PTY tail directly, synthesize a pseudo-response payload,
    proceed as if a hook had fired

step satisfied -> step N+1 start (engine deterministic transition)

after final step:
  approval_mark_done guardrail active -> orchestrator-LLM composes a run-complete summary
  engine surfaces the inline chat confirm with "Confirm done" / "Not yet" buttons
  on Confirm: engine marks run complete, terminates orchestrator-LLM session
```

### Orchestrator-LLM context envelope

```ts
type OrchestratorInvocationContext = {
  goal: { id: string; title: string; description: string; attachedWorkspaces: WorkspaceRef[] };
  workflowRun: { templateId: string; templateVersion: number; ordinal: number; status: WorkflowRunStatus };
  currentStep: {
    id: string;
    instructions: string;
    outputSchema: WorkflowStepOutputSchema;
    agentAdapterId: string;
    executionMode: ExecutionMode;
  };
  conversation: {
    chatMessages: Array<{
      role: "user" | "orchestrator" | "agent_paraphrased";
      body: string;
      ts: string;
      stepRunId?: string;
    }>;
    currentStepAgentTurns: Array<{
      role: "agent" | "user_via_orchestrator";
      body: string;
      ts: string;
    }>;
  };
  priorStepArtifacts: Array<{ stepId: string; outputJson: unknown }>;
  // Reserved for future memory engine integration:
  // memoryItems?: Array<DecisionRecord | ConstraintRecord | OpenQuestionRecord | ...>;
};
```

Bounded to the orchestration request payload limit (~64 KiB). Truncation order when over budget: oldest `currentStepAgentTurns` first; then trim `priorStepArtifacts` from earliest steps; never truncate `currentStep` or `goal` metadata.

### Workflow template additions

Add to `WorkflowStepTemplate`:

```ts
type StepAgentChoice = {
  adapterId: string;
  modelId: string;                  // adapter-validated; the agent runs against this model
  providerId?: ModelProviderId;     // optional; adapter may infer when unambiguous
};

agentPreference: StepAgentChoice[];  // ordered; resolver picks first whose adapter is ready
                                     // AND supports the modelId. Required, min length 1.
```

No `executionMode` field on the template; the adapter's runtime config decides transport.

Per-step model lets template authors match model weight to workload (cheap conversational models for interview/QA, heavier reasoning models for synthesis/review/execution) while the goal-scoped orchestrator-LLM remains a separate, user-selected concern.

Resolution semantics:

- Walk `agentPreference[]` in order.
- For each entry, check (a) adapter is registered and ready, (b) adapter declares the `modelId` is supported.
- First entry satisfying both is chosen. Adapter execution mode is then resolved from the adapter's DB-backed config (preferred enabled mode; fallbacks on dispatch failure).
- If no entry satisfies, the run is blocked with `no ready agent for step X (preferences: [...])`.

`orca/engineering` bumps to v4 with the following per-step defaults (claude-code adapter; tune freely as adapter/model coverage grows):

| Step | adapterId | modelId | Rationale |
|---|---|---|---|
| Intake | `claude-code` | `claude-haiku-4-5` | Cheap conversational interview |
| Research | `claude-code` | `claude-opus-4-7` | Deep reasoning over codebase; plan quality compounds downstream |
| PRD | `claude-code` | `claude-opus-4-7` | Synthesis with high judgment cost; defines the destination |
| Issue Breakdown | `claude-code` | `claude-opus-4-7` | Decomposition shapes all execution work; worth the heavier model |
| Execution | `claude-code` | `claude-sonnet-4-6` | Mechanical once plan is good; sonnet handles edits + tool use well |
| QA | `claude-code` | `claude-sonnet-4-6` | Acceptance walk-through with judgment over PRD signals |
| Review | `claude-code` | `claude-opus-4-7` | Fresh-context deep review |
| Done | `claude-code` | `claude-haiku-4-5` | Finalize, capture memory items |

Fallback usage example: `[{claude-code, claude-opus-4-7}, {claude-code, claude-sonnet-4-6}]` — if opus is unavailable (creds missing / not enabled for that adapter), the step degrades to sonnet rather than blocking.

### Workflow contract changes summary

```ts
// packages/contracts/src/workflows/index.ts

WorkflowStepTemplate += {
  agentPreference: StepAgentChoice[]  // min length 1; ordered fallback
}
// StepAgentChoice = { adapterId: string; modelId: string; providerId?: ModelProviderId }

// Removed (orchestrator no longer routes by operator kind selection):
// - per-step operator selection via LLM
// - StepSkillProposal-driven model path (replaced by orchestrator-LLM mediation + agent step output)

// Existing kept:
// - WorkflowStepOutputSchema, WorkflowArtifact, WorkflowDecisionTrace, WorkflowRecommendation
// - launch_workflow_session recommendation type (now produced only when adapter dispatch fails
//   into a user-needed manual relaunch — rare path)
```

### Removed concepts and surfaces

- LLM-based per-step operator selector (`commitOperatorSelectionForSkill`). Replaced by deterministic template→adapter→mode resolution.
- `approval_launch_agent` guardrail. Orchestrator owns launches; no per-launch yield.
- `request_user_input` decision surfaced as a separate recommendation card with a textarea. Questions are first-class chat messages now; user answers via the normal chat composer.
- `Workflow recommendations (N)` rendered list in `OrcaChat`. The only remaining surfaced recommendation, `mark_run_complete`, becomes an inline chat-native confirm card.
- `WorkflowBanner` durable element in chat. Step status, transitions, artifact count surface as persistent-styled internal-thought rows.
- `SystemCard "No pending workflow recommendations"`. Vestigial.

### Retained guardrails

- `approval_mark_done`: the single user yield. Surfaces as the inline chat confirm at run end.
- `validation_required` (execution step): orchestrator-LLM treats validation failure as revise feedback for the agent.
- `cost_speed_preference`, `concurrency_one`, `context_summary`: operational constraints, unchanged.

### Chat UI

Three element kinds:

1. **User message** — what the user typed.
2. **Orchestrator-paraphrased agent response** — orchestrator-LLM's voice; raw agent transcript collapsed behind a `▸ Show raw agent transcript` expander; an `ⓘ Why?` expander reveals the orchestrator's decision reason for that turn.
3. **Persistent styled internal-thought row** — muted/italic, distinct from messages. Conveys: step transitions, "thinking…", agent invocations, schema validation results, retries/revisions, agent crashes, "ready to mark done" handoff. Persists in scrollback (later: optionally collapse, not in MVP).

The mark-done confirm at run end is the only interactive non-message element (inline `[Confirm done]` / `[Not yet]` buttons embedded in an orchestrator message).

Existing decision-trace ("Why this action?") concept moves into the `ⓘ Why?` expander on each orchestrator-touched element (paraphrased messages and internal-thought rows).

### Concurrency

User can send multiple messages while the orchestrator-LLM is mid-call or while an agent is responding. New messages queue; orchestrator processes the queue after its current cycle settles. UI shows a typing-style indicator while the orchestrator is busy. New messages feed into the orchestrator's next invocation context naturally.

### Resume after daemon restart

On daemon boot, for each active run:

- Reattach any surviving PTY sessions (orchestrator-LLM session and per-step agent session). Reattach is the happy path; many node-pty configurations survive parent restarts.
- For sessions that died with the daemon, mark them as crashed; on the next engine tick, spawn fresh attempts. Orchestrator-LLM state is rebuilt from event store + artifacts on next invocation.
- Daemon restart introduces no new user yield. Behavior is the same as a transient session crash mid-run, recovered automatically.

## Failure handling

| Failure | Behavior |
|---|---|
| Agent response-done hook silent | 90s idle timeout → engine reads PTY tail → treats as agent response payload |
| Agent emits malformed step-complete JSON | engine produces validator-error feedback, sends to agent, retries up to N=3 → escalate to user |
| Agent emits step-complete but orchestrator-LLM says revise | LLM-produced feedback sent to agent, retries up to N=3 → escalate to user |
| Agent crashes / session exits unexpectedly | engine logs; orchestrator-LLM decides retry vs escalate; cap 3 fresh attempts before forced escalation |
| Orchestrator-LLM call fails (provider error) | exponential backoff retry; persistent failure → "orchestrator unavailable" chat banner; run pauses; resumes on next successful call |
| Validation guardrail fails (execution step tests red) | same as malformed step-complete — orchestrator pushes agent to fix |
| No ready adapter from template `agentPreference[]` | block run with "no ready agent for step X (preferences: [...])" |
| User declines mark-done at run end | chat returns to active state; user can ask orchestrator to continue work or open new asks; run stays `active` until either marked done or explicitly abandoned |

## Telemetry / observability

Existing event-store coverage continues:

- `workflow.session.started` / `workflow.session.completed` (already present).
- `workflow.operator.selected` repurposed: emit once per step at deterministic adapter resolution, carrying `{adapterId, executionMode, source: "deterministic"}`. No LLM-selector source value emitted under the new model.
- `workflow.decision.requested` / `workflow.decision.recorded` retained.
- New: `adapter.execution_modes.changed` for adapter config mutations.

Daemon logs (`apps/daemon/src/log.ts`) gain structured fields per orchestrator-LLM invocation: `goalId`, `runId`, `stepRunId`, `triggerKind` (`user_message` | `agent_response` | `crash_retry` | `idle_timeout`), `tokensIn`, `tokensOut`, `latencyMs`.

## Implementation surface (rough)

Daemon:

- `apps/daemon/src/workflows/orchestrator/service.ts` — rewrite `commitSkillStepDecision` and adjacent step-dispatch code. Remove `commitOperatorSelectionForSkill`. Replace with deterministic `resolveStepDispatch(template, registry)` returning `{adapterId, executionMode}`. Add `OrchestratorMediator` that runs the orchestrator-LLM invocation on each trigger (user msg, agent response hook, crash, idle timeout) and produces the paraphrase + judgement + (optional) agent dispatch.
- `apps/daemon/src/workflows/operators/adapter-config.ts` (new) — `getAdapterExecutionModeConfig(adapterId)`, mutation API with invariant validation, audit event emission, on-boot seeding from adapter-declared defaults.
- New DB migration: `adapter_execution_modes` table + seed.
- `apps/daemon/src/orchestrator-llm/session.ts` (new) — manage the goal-scoped orchestrator-LLM session lifecycle (spawn, hook registration, send, terminate, reattach).
- Agent adapter interface — add `supportedExecutionModes` capability declaration; add `supportedModels: string[]` (or equivalent capability query like `supportsModel(modelId)`) so the resolver can validate `StepAgentChoice.modelId`; add a `composeInitialPrompt(input)` helper that wraps step instructions with the step-complete emission convention; add `parseResponseHookPayload(...)` for adapter-specific normalization.
- HTTP/IPC endpoint for response-done callbacks at `/v1/agent-hooks/response-done`. Adapter wires its native hook (Claude Code `Stop` hook, etc.) to call this endpoint on spawn.
- `bootstrap-route.ts` — drop the single `requestNextDecision` call after run creation. Run progression is event-driven from this point: engine reacts to user messages, agent hooks, crashes, timeouts.

Contracts:

- `packages/contracts/src/workflows/index.ts` — `WorkflowStepTemplate.agentPreference: string[]`. Bump engineering template to v4.
- `packages/contracts/src/adapters/execution-modes.ts` (new or co-located) — `ExecutionMode`, `AdapterExecutionModeConfig`, mutation request/response shapes.

Desktop:

- `apps/desktop/src/orchestrator/OrcaChat.tsx` — remove `WorkflowBanner`, `Workflow recommendations` list, `restoredPendingInput` textarea card, `SystemCard "No pending workflow recommendations"`. Introduce `InternalThoughtRow` component, `AgentParaphrasedMessage` component (with collapsible raw transcript + ⓘ Why? expander), `MarkDoneConfirmCard` inline component.
- `apps/desktop/src/api.ts` — add settings-API client calls for adapter execution-mode mutations.
- New settings/admin UI surface for adapter mode config (low priority for MVP; CLI/API sufficient initially).

## Out of scope (deferred to later)

- Memory engine integration. Context envelope reserves a `memoryItems` slot for future injection.
- Orchestrator-LLM tool-call freedom (the LLM doesn't issue `spawn_agent`, `advance_step` tool calls; engine drives lifecycle). Evolution path: introduce tools incrementally for judgement decisions only, never for deterministic transitions.
- LLM-based per-step agent kind selection. `agentPreference` is template-declarative; an evolution path replaces it with an LLM selector at the resolver layer, with no contract change needed.
- Adapters beyond claude-code. codex/opencode adapter implementations land in their own work; their `adapter_execution_modes` rows are seeded once those adapters register at boot.
- Internal-thought row collapsing in chat scrollback. Deferred until volume becomes a problem.
- Power-user "Sessions" debug drawer (read-only PTY view). Useful for early development; defer to a follow-up.

## Worked example

User: orchestrator-LLM = Claude Haiku (via claude-code adapter, shadow mode enabled+preferred). Workspace: `/home/shawn/projects/orca`. Goal: "Update the goals panel text color to be lighter."

1. Goal created; run created. Engine spawns orchestrator-LLM shadow session `orchsess-G1`. Spawns step-1 (Intake) agent session `stepsess-G1-intake`. Posts internal-thought rows: "starting workflow run · 8 steps" and "step 1/8 Intake · spawning claude-code agent · thinking…".
2. Intake agent emits a question turn (which goals panel? which color value?). Stop hook fires. Engine reads payload, invokes orchestrator-LLM, paraphrases to chat with recommended answers, attaches `▸ Show raw agent transcript` and `ⓘ Why?` expanders.
3. User types: `left sidebar list. and yes text-slate-400 works`. Engine appends user message, invokes orchestrator-LLM, which forwards a contextualized translation to the agent's stdin. Internal-thought row "forwarded to claude-code · thinking…".
4. Agent emits `<orca:step-complete>{problem, success_outcome, constraints, relevant_workspaces, open_questions}`. Engine validates against intake schema (valid). Orchestrator-LLM judges (approve). Engine persists `step_output` artifact, terminates step session, advances. Internal-thought row "step 1 complete · advancing to step 2/8 Research".
5. Steps 2–7 (Research, PRD, Issue Breakdown, Execution, QA, Review) follow the same pattern. Execution's `validation_required` guardrail is encoded in the schema check (validation.ran && validation.passed); on failure the orchestrator-LLM treats it as revise feedback. QA is conversational; agent paraphrases acceptance signals into chat, user answers.
6. Step 8 (Done) emits a final step-complete with `memory_items`. Engine validates, orchestrator approves, marks step done. `approval_mark_done` guardrail kicks in: orchestrator-LLM composes a run-complete summary; engine surfaces an inline `[Confirm done] [Not yet]` card embedded in an orchestrator message.
7. User clicks `Confirm done`. Engine marks run `complete`, terminates `orchsess-G1`. Final internal-thought row "run complete · 8 steps · 1 file changed".

Failure detours (illustrative, not happy-path):

- Agent emits malformed step-complete → engine validator error → orchestrator-LLM composes "add the missing field X" feedback → agent revises → up to N=3 before escalation.
- Hook silent for 90s → engine idle-timeout reads PTY tail → proceeds.
- Agent crashes mid-Execution → session-exit event → orchestrator-LLM picks retry → fresh agent session spawned (attempt 2 of 3). At 3rd crash, orchestrator-LLM posts an escalation chat message; user replies and a fresh attempt continues or the user marks the run blocked manually.
- User changes scope mid-run ("also bump spacing") → orchestrator-LLM judges scope creep → posts an options message: continue current run vs loop back to PRD update. This is an LLM judgement (Q25 hybrid), not an engine yield point.

## Open questions

- Mid-step "transcript handoff" details: when an agent session crashes mid-step and we spawn a fresh attempt, do we replay the prior agent turns into the new session's initial prompt, or start fresh with only the orchestrator's accumulated paraphrase + the step's own instructions and outputSchema? Default for the initial implementation: start fresh; orchestrator's accumulated paraphrase already informs the new agent via the prompt-composition path. Revisit if step quality regresses.
- Per-adapter response-done payload normalization: claude-code uses the `Stop` hook + transcript path; codex SDK returns final assistant message directly; opencode TBD. Adapter-specific implementation; design supports all three via a common `parseResponseHookPayload(...)` interface.
- Settings UI for adapter mode config: shape and surface TBD. CLI/API mutation sufficient for MVP.
- Internal-thought row "Why?" content: free-form orchestrator-LLM rationale vs structured `WorkflowDecisionTrace.reason`. Initial implementation: orchestrator-LLM rationale (free-form short text) attached to each invocation result; existing structured decision trace continues to record alongside for audit.
- Mark-done "Not yet" semantics: does it return to an indefinitely-active run (LLM keeps mediating user messages with no current step) or auto-spawn a new follow-up step? Initial implementation: indefinite-active; user can ask the orchestrator anything; orchestrator may suggest a new run/goal but does not auto-spawn workflow steps after the template is exhausted.

## Recommended decomposition at plan time

Likely sub-plans (ordered):

1. **Adapter execution-mode config** (DB migration, seed, mutation API, audit event, code-declared capability on adapter manifests). Standalone, testable in isolation.
2. **Unified adapter dispatch** (collapse orchestrator-LLM and agent dispatch onto one adapter layer; introduce dispatcher that resolves mode per adapter config; thread through existing one_shot and shadow_session transports). Depends on (1).
3. **Orchestrator-LLM session + mediator** (goal-scoped session lifecycle, mediator that runs on each trigger, prompt composition for orchestrator invocations). Depends on (2).
4. **Deterministic per-step agent dispatch** (remove operator-selection LLM call; add `agentPreference` to template; engine resolves agent + mode deterministically at step start). Depends on (2).
5. **Step-complete judgement loop** (engine validates schema; orchestrator-LLM judges approve/revise; agent revise messaging; N=3 cap; failure escalation). Depends on (3, 4).
6. **Engineering template v4** (add `agentPreference` per step). Depends on (4).
7. **Bootstrap + event-driven progression** (drop single `requestNextDecision` call; engine reacts to user messages, agent hooks, crashes, timeouts). Depends on (5).
8. **Chat UI overhaul** (remove banner/recs panel/pending-input card/SystemCard; add internal-thought row, paraphrased agent message, mark-done inline confirm). Depends on (3, 5); can land incrementally against a feature flag.
9. **Failure handling polish** (idle timeout, crash retry budget, escalation chat messages). Depends on (5, 7).
10. **Resume after daemon restart** (reattach surviving PTYs; fresh attempt on dead sessions; rebuild orchestrator state from events). Depends on (3, 7).

Each sub-plan should produce working, testable software on its own.
