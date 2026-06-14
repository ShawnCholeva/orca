# Provider Limit Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause quota-limited workflow steps for an explicit wait/retry or provider-switch decision while preserving the current session and displaying the provider reset time.

**Architecture:** Persist a typed provider-recovery checkpoint on the active workflow step run and expose it through the existing activity API. Provider adapters parse structured terminal failures and own provider-specific wait/resume terminal interactions; the orchestrator service owns the recovery state machine, readiness rechecks, session handoff, and idempotency. The desktop renders a dedicated recovery card and calls explicit recovery endpoints.

**Tech Stack:** TypeScript, Zod contracts, Fastify, SQLite/better-sqlite3 migrations, tmux worker sessions, React, Vitest, Testing Library.

---

## Execution Note

The current workspace already contains uncommitted provider-limit detection,
output-listener, worker-lifecycle, scoring-summary, and chat-confirmation
changes from the preceding debugging work. Preserve those changes and integrate
them into the tasks below. Use the exact `git add` paths in each task; do not
reset, clean, or stage unrelated files such as
`packages/contracts/tsconfig.tsbuildinfo`, `.superpowers/`, or the unrelated
Phase 3 design doc `docs/superpowers/specs/2026-06-12-feature-development-workflow-design.md`.

**Migration numbering:** migration `0029` is already taken by the shipped
`0029_workflow_graph_cursor.sql` (graph-authoritative routing). This plan's
recovery migration is therefore **`0030_provider_recovery.sql`**, registered
after `0029_workflow_graph_cursor.sql`. The exact migration-list assertions in
`migrations.test.ts`, `test/migrations-0006.test.ts`, and
`src/migrations/suggested-orchestration.test.ts` already include
`0029_workflow_graph_cursor.sql`; append `0030_provider_recovery.sql` after it.

## File Structure

**Create**

- `apps/daemon/migrations/0030_provider_recovery.sql` - persisted step-run recovery checkpoint.
- `apps/daemon/src/workflows/orchestrator/provider-recovery.ts` - checkpoint parsing, choice construction, reset labels, and switch handoff composition.
- `apps/daemon/src/workflows/orchestrator/provider-recovery.test.ts` - focused recovery helper tests.
- `apps/desktop/src/orchestrator/ProviderRecoveryCard.tsx` - recovery choice/wait/retry/switch UI.
- `apps/desktop/src/orchestrator/ProviderRecoveryCard.test.tsx` - component behavior tests.

**Modify**

- `packages/contracts/src/index.ts` - structured provider error, checkpoint, activity enrichment, and action request schemas.
- `packages/contracts/src/__tests__/orchestration-contracts.test.ts` - contract parsing tests.
- `apps/daemon/src/orchestrator-llm/providers/types.ts` - structured terminal parsing and provider wait/turn-start hooks.
- `apps/daemon/src/orchestrator-llm/providers/claude.ts` - Claude session-limit/reset parsing and wait interaction.
- `apps/daemon/src/orchestrator-llm/providers/codex.ts` - adapt existing errors to structured failures.
- `apps/daemon/src/orchestrator-llm/providers/antigravity.ts` - adapt existing errors to structured failures.
- `apps/daemon/src/orchestrator-llm/providers/registry.test.ts` - provider parsing tests.
- `apps/daemon/src/workflows/orchestrator/worker-session.ts` - provider wait action and retry-start observation support.
- `apps/daemon/src/workflows/orchestrator/worker-session.test.ts` - worker interaction tests.
- `apps/daemon/src/activities/store.ts` - pause/resume helpers for provider recovery.
- `apps/daemon/src/activities/store.test.ts` - activity state tests.
- `apps/daemon/src/activities/projection.ts` - attach persisted recovery data to activities.
- `apps/daemon/src/activities/projection.test.ts` - activity enrichment tests.
- `apps/daemon/src/workflows/orchestrator/service.ts` - detect, wait, retry, switch, refresh, and clear recovery checkpoints.
- `apps/daemon/src/workflows/operators/registry.ts` - connected-agent readiness filtering for recovery choices.
- `apps/daemon/src/workflows/operators/registry.test.ts` - filtered operator listing tests.
- `apps/daemon/src/workflows/orchestrator/session-tail.ts` - decode only output appended after a persisted sequence.
- `apps/daemon/src/workflows/orchestrator/session-tail.test.ts` - output-sequence boundary tests.
- `apps/daemon/src/workflows/orchestrator/agent-interview.test.ts` - limit detection integration tests.
- `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` - wait/retry/switch state-machine tests.
- `apps/daemon/src/workflows/reconcile.ts` - restore recovery activities after restart.
- `apps/daemon/src/workflows/reconcile.test.ts` - restart recovery tests.
- `apps/daemon/src/workflows/orchestrator/resume.ts` - avoid automatic respawn while a recovery decision is pending.
- `apps/daemon/src/workflows/orchestrator/resume.test.ts` - recovery-aware boot resume tests.
- `apps/daemon/src/server.ts` - wire worker controls and recovery endpoints.
- `apps/daemon/src/server.test.ts` - HTTP route tests.
- `apps/daemon/src/migrations.test.ts` - migration ordering/schema tests.
- `apps/daemon/test/migrations-0006.test.ts` - legacy upgrade migration list.
- `apps/daemon/src/migrations/suggested-orchestration.test.ts` - migration list.
- `apps/desktop/src/api.ts` - recovery action clients.
- `apps/desktop/src/api.test.ts` - endpoint/request tests.
- `apps/desktop/src/orchestrator/ActivityThread.tsx` - render recovery card in the live activity.
- `apps/desktop/src/orchestrator/ActivityThread.test.tsx` - recovery-card integration.
- `apps/desktop/src/orchestrator/OrcaChat.tsx` - handlers, refresh behavior, and thinking-state clearing.
- `apps/desktop/src/orchestrator/OrcaChat.test.tsx` - chat integration tests.
- `apps/desktop/src/orchestrator/orca-chat.css` - recovery card states, choices, and disabled reasons.

## Task 1: Add Typed Recovery Contracts And Persistence

**Files:**
- Create: `apps/daemon/migrations/0030_provider_recovery.sql`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/__tests__/orchestration-contracts.test.ts`
- Modify: `apps/daemon/src/migrations.test.ts`
- Modify: `apps/daemon/test/migrations-0006.test.ts`
- Modify: `apps/daemon/src/migrations/suggested-orchestration.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add contract tests that parse a recovery checkpoint with one selectable Codex
choice and one disabled Antigravity choice:

```ts
const recovery = ProviderRecoveryCheckpoint.parse({
  id: "recovery-1",
  mode: "choose",
  failureCode: "session_limit",
  message: "Claude Code session limit reached",
  currentSessionId: "session-1",
  currentAdapterId: "claude-code",
  currentProviderName: "Claude Code",
  resetTimeText: "4:20am (America/New_York)",
  resetAt: "2026-06-12T08:20:00.000Z",
  timezone: "America/New_York",
  detectedAt: "2026-06-12T05:00:00.000Z",
  retryOutputSeq: null,
  retryKind: "preserved_session",
  replacementSessionId: null,
  replacementOutputSeq: null,
  pendingGuidance: [],
  lastError: null,
  choices: [
    {
      adapterId: "codex",
      displayName: "Codex",
      modelId: "gpt-5.4-mini",
      enabled: true,
      reason: null,
    },
    {
      adapterId: "antigravity",
      displayName: "Antigravity",
      modelId: null,
      enabled: false,
      reason: "not configured for this step",
    },
  ],
});
expect(recovery.mode).toBe("choose");
```

Also assert:

```ts
expect(Activity.parse({
  ...activityFixture,
  sourceKind: "provider_recovery_pending",
  providerRecovery: recovery,
})).toBeDefined();

expect(ProviderRecoverySwitchRequest.parse({
  checkpointId: "recovery-1",
  adapterId: "codex",
})).toEqual({
  checkpointId: "recovery-1",
  adapterId: "codex",
});
```

- [ ] **Step 2: Run contract tests to verify RED**

Run:

```bash
pnpm --filter @orca/contracts test -- src/__tests__/orchestration-contracts.test.ts
```

Expected: FAIL because the recovery schemas and activity fields do not exist.

- [ ] **Step 3: Add the contract schemas**

In `packages/contracts/src/index.ts`, add:

```ts
export const ProviderTerminalFailureCode = z.enum([
  "session_limit",
  "usage_limit",
  "authentication_required",
  "provider_unavailable",
]);
export type ProviderTerminalFailureCode = z.infer<typeof ProviderTerminalFailureCode>;

export const ProviderRecoveryMode = z.enum([
  "choose",
  "waiting",
  "retrying",
  "switching",
]);
export type ProviderRecoveryMode = z.infer<typeof ProviderRecoveryMode>;

export const ProviderRecoveryRetryKind = z.enum([
  "preserved_session",
  "fresh_session",
]);
export type ProviderRecoveryRetryKind = z.infer<typeof ProviderRecoveryRetryKind>;

export const ProviderRecoveryChoice = z.object({
  adapterId: AdapterId,
  displayName: z.string().min(1).max(120),
  modelId: z.string().min(1).max(80).nullable(),
  enabled: z.boolean(),
  reason: z.string().max(512).nullable(),
}).strict();
export type ProviderRecoveryChoice = z.infer<typeof ProviderRecoveryChoice>;

export const ProviderRecoveryCheckpoint = z.object({
  id: z.string().min(1).max(100),
  mode: ProviderRecoveryMode,
  failureCode: ProviderTerminalFailureCode,
  message: z.string().min(1).max(512),
  currentSessionId: z.string().min(1),
  currentAdapterId: AdapterId,
  currentProviderName: z.string().min(1).max(120),
  resetTimeText: z.string().max(160).nullable(),
  resetAt: z.string().datetime().nullable(),
  timezone: z.string().max(100).nullable(),
  detectedAt: z.string().datetime(),
  retryOutputSeq: z.number().int().nonnegative().nullable(),
  retryKind: ProviderRecoveryRetryKind,
  replacementSessionId: z.string().min(1).nullable(),
  replacementOutputSeq: z.number().int().nonnegative().nullable(),
  pendingGuidance: z.array(z.string().min(1).max(4000)).max(20),
  lastError: z.string().max(512).nullable(),
  choices: z.array(ProviderRecoveryChoice).max(8),
}).strict();
export type ProviderRecoveryCheckpoint = z.infer<typeof ProviderRecoveryCheckpoint>;

export const ProviderRecoveryActionRequest = z.object({
  checkpointId: z.string().min(1).max(100),
}).strict();
export type ProviderRecoveryActionRequest = z.infer<
  typeof ProviderRecoveryActionRequest
>;

export const ProviderRecoverySwitchRequest = ProviderRecoveryActionRequest.extend({
  adapterId: AdapterId,
}).strict();
export type ProviderRecoverySwitchRequest = z.infer<
  typeof ProviderRecoverySwitchRequest
>;
```

Add `"provider_recovery_pending"` to `ActivitySourceKind` and add:

```ts
providerRecovery: ProviderRecoveryCheckpoint.optional(),
```

to `Activity`.

- [ ] **Step 4: Add the migration and migration assertions**

Create `apps/daemon/migrations/0030_provider_recovery.sql`:

```sql
-- Recoverable provider-limit state for an active workflow step.
-- NULL when the step is not awaiting a wait/retry/switch decision.
ALTER TABLE workflow_step_runs
  ADD COLUMN pending_provider_recovery_json TEXT;
```

Append `"0030_provider_recovery.sql"` to every exact migration list in:

- `apps/daemon/src/migrations.test.ts`
- `apps/daemon/test/migrations-0006.test.ts`
- `apps/daemon/src/migrations/suggested-orchestration.test.ts`

Add a schema assertion:

```ts
const columns = db.prepare("PRAGMA table_info(workflow_step_runs)").all() as Array<{ name: string }>;
expect(columns.map((column) => column.name)).toContain("pending_provider_recovery_json");
```

- [ ] **Step 5: Run contracts and migration tests**

Run:

```bash
pnpm --filter @orca/contracts test -- src/__tests__/orchestration-contracts.test.ts
pnpm --filter @orca/daemon test -- src/migrations.test.ts test/migrations-0006.test.ts src/migrations/suggested-orchestration.test.ts
pnpm --filter @orca/contracts typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/__tests__/orchestration-contracts.test.ts apps/daemon/migrations/0030_provider_recovery.sql apps/daemon/src/migrations.test.ts apps/daemon/test/migrations-0006.test.ts apps/daemon/src/migrations/suggested-orchestration.test.ts
git commit -m "feat(contracts): add provider recovery state"
```

## Task 2: Parse Structured Provider Limits And Reset Times

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/providers/types.ts`
- Modify: `apps/daemon/src/orchestrator-llm/providers/claude.ts`
- Modify: `apps/daemon/src/orchestrator-llm/providers/codex.ts`
- Modify: `apps/daemon/src/orchestrator-llm/providers/antigravity.ts`
- Modify: `apps/daemon/src/orchestrator-llm/providers/registry.test.ts`

- [ ] **Step 1: Write failing parser tests**

Add tests for the exact Claude message:

```ts
const failure = resolveShadowProvider("claude-code")
  .turnParser()
  .detectError?.(
    "You've hit your session limit · resets 4:20am (America/New_York)\n" +
    "/upgrade to increase your usage limit.",
    new Date("2026-06-12T05:00:00.000Z"),
  );

expect(failure).toMatchObject({
  code: "session_limit",
  message: "Claude Code session limit reached",
  resetTimeText: "4:20am (America/New_York)",
  timezone: "America/New_York",
  resetAt: "2026-06-12T08:20:00.000Z",
});
```

Add tests for:

- `resets 4:20am` without a timezone: preserve `resetTimeText`, set
  `resetAt`/`timezone` to `null`.
- a limit message without reset text: all reset fields are `null`.
- existing Codex and Antigravity terminal errors returning structured codes.

- [ ] **Step 2: Run parser tests to verify RED**

Run:

```bash
pnpm --filter @orca/daemon test -- src/orchestrator-llm/providers/registry.test.ts
```

Expected: FAIL because `detectError` returns `Error` and accepts no clock.

- [ ] **Step 3: Replace `Error` with a structured provider failure**

In `providers/types.ts`, define:

```ts
import type { ProviderTerminalFailureCode } from "@orca/contracts";

export interface ProviderTerminalFailure {
  code: ProviderTerminalFailureCode;
  message: string;
  resetTimeText: string | null;
  resetAt: string | null;
  timezone: string | null;
}

export interface ShadowTurnParse {
  parseAction(turnText: string): string | null;
  detectError?(
    turnText: string,
    detectedAt?: Date,
  ): ProviderTerminalFailure | null;
  detectTurnStarted?(turnText: string): boolean;
}
```

Add an optional provider terminal action:

```ts
waitForLimitReset?(ctx: {
  tmux: TmuxRunner;
  sessionName: string;
  dbg: (msg: string) => void;
}): Promise<void>;
```

- [ ] **Step 4: Implement Claude reset parsing**

Use a bounded parser in `claude.ts`:

```ts
const CLAUDE_RESET =
  /resets\s+(\d{1,2}:\d{2}\s*(?:am|pm))(?:\s*\(([^)]+)\))?/i;

function parseClaudeSessionLimit(text: string, detectedAt = new Date()): ProviderTerminalFailure | null {
  if (!CLAUDE_SESSION_LIMIT.test(text)) return null;
  const match = text.match(CLAUDE_RESET);
  const clockText = match?.[1]?.replace(/\s+/g, "") ?? null;
  const timezone = match?.[2] ?? null;
  const resetTimeText = match
    ? `${match[1]}${timezone ? ` (${timezone})` : ""}`.slice(0, 160)
    : null;
  return {
    code: "session_limit",
    message: "Claude Code session limit reached",
    resetTimeText,
    resetAt: clockText && timezone
      ? resolveNextZonedTime(clockText, timezone, detectedAt)
      : null,
    timezone,
  };
}
```

Implement `resolveNextZonedTime` with `Intl.DateTimeFormat`, validating the IANA
timezone and selecting the next occurrence after `detectedAt`. Do not add a date
library:

```ts
function resolveNextZonedTime(
  clockText: string,
  timezone: string,
  detectedAt: Date,
): string | null {
  const match = clockText.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!match) return null;
  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const targetHour =
    (hour12 % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
  let candidateMs =
    Math.floor(detectedAt.getTime() / 60_000) * 60_000 + 60_000;
  for (let offsetMinutes = 0; offsetMinutes < 48 * 60; offsetMinutes += 1) {
    const candidate = new Date(candidateMs + offsetMinutes * 60_000);
    const parts = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    if (Number(parts.hour) % 24 === targetHour && Number(parts.minute) === minute) {
      return candidate.toISOString();
    }
  }
  return null;
}
```

Return `detectTurnStarted: (text) => /esc to interrupt/i.test(text)`.

Implement Claude waiting:

```ts
async waitForLimitReset(ctx) {
  await ctx.tmux.run(["send-keys", "-t", ctx.sessionName, "Enter"]);
  ctx.dbg("claude session-limit wait selected");
}
```

Convert Codex/Antigravity errors to the same shape with null reset fields and
provider-specific codes. Keep their existing user-facing messages. Add
provider-specific turn-start evidence:

```ts
// Codex
detectTurnStarted: (text) => /esc to interrupt|working/i.test(text)

// Antigravity
detectTurnStarted: (text) => /esc to cancel|running/i.test(text)
```

Codex and Antigravity `waitForLimitReset` implementations are no-ops because
their limit output does not require choosing Claude's terminal menu; they still
preserve the existing tmux session.

- [ ] **Step 5: Run provider tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/orchestrator-llm/providers/registry.test.ts src/orchestrator-llm/providers/antigravity.test.ts
pnpm --filter @orca/daemon typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/providers/types.ts apps/daemon/src/orchestrator-llm/providers/claude.ts apps/daemon/src/orchestrator-llm/providers/codex.ts apps/daemon/src/orchestrator-llm/providers/antigravity.ts apps/daemon/src/orchestrator-llm/providers/registry.test.ts
git commit -m "feat(daemon): parse provider reset limits"
```

## Task 3: Add Recovery Choice And Handoff Helpers

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/provider-recovery.ts`
- Create: `apps/daemon/src/workflows/orchestrator/provider-recovery.test.ts`
- Modify: `apps/daemon/src/workflows/operators/registry.ts`
- Modify: `apps/daemon/src/workflows/operators/registry.test.ts`

- [ ] **Step 1: Write failing helper tests**

Cover:

```ts
const choices = await buildProviderRecoveryChoices({
  currentAdapterId: "claude-code",
  connectedAdapterIds: ["claude-code", "codex", "antigravity"],
  stepPreferences: [
    { adapterId: "claude-code", modelId: "claude-sonnet-4-6" },
    { adapterId: "codex", modelId: "gpt-5.4-mini" },
  ],
  operators: [
    agent("claude-code", true),
    agent("codex", true),
    agent("antigravity", false, "authentication required"),
  ],
  supportsModel: (adapterId, modelId) =>
    adapterId === "codex" && modelId === "gpt-5.4-mini",
});

expect(choices).toEqual([
  {
    adapterId: "codex",
    displayName: "Codex",
    modelId: "gpt-5.4-mini",
    enabled: true,
    reason: null,
  },
  {
    adapterId: "antigravity",
    displayName: "Antigravity",
    modelId: null,
    enabled: false,
    reason: "not configured for this step",
  },
]);
```

Also test:

- only the current connected provider produces `[]`;
- a configured but not-ready provider is disabled with its readiness reason;
- `OperatorRegistry.list(goalId, { agentIds: ["codex"], includeNonAgents: false })` checks and returns
  Codex without probing Claude Code or Antigravity;
- `composeProviderSwitchPrompt` contains the original objective plus a bounded
  interrupted-session tail and never exceeds the chosen byte cap.

- [ ] **Step 2: Run helper tests to verify RED**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/orchestrator/provider-recovery.test.ts src/workflows/operators/registry.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement focused helper functions**

First extend `OperatorRegistry.list` without changing existing callers:

```ts
async list(
  goalId: string,
  options: {
    agentIds?: string[];
    includeNonAgents?: boolean;
  } = {},
): Promise<OperatorDescriptor[]> {
  void goalId;
  const allowedAgents = options.agentIds
    ? new Set(options.agentIds)
    : null;
  const adapters = this.adapters
    .listAgentAdapters()
    .filter((adapter) => allowedAgents?.has(adapter.id) ?? true);
  // Keep the existing readiness construction for `adapters`.
  // Add model and human descriptors only when options.includeNonAgents !== false.
}
```

The recovery caller uses `includeNonAgents: false`. Selector callers omit
options and retain the current full operator list.

Create:

```ts
export function buildProviderRecoveryChoices(input: {
  currentAdapterId: string;
  connectedAdapterIds: string[];
  stepPreferences: StepAgentChoice[];
  operators: OperatorDescriptor[];
  supportsModel(adapterId: string, modelId: string): boolean;
}): ProviderRecoveryChoice[] {
  const preferenceByAdapter = new Map(
    input.stepPreferences.map((preference) => [preference.adapterId, preference]),
  );
  const connected = new Set(input.connectedAdapterIds);
  return input.operators
    .filter((operator) => operator.kind === "agent")
    .filter((operator) => connected.has(operator.id.slice("agent:".length)))
    .filter((operator) => operator.id !== `agent:${input.currentAdapterId}`)
    .map((operator) => {
      const adapterId = operator.id.slice("agent:".length);
      const preference = preferenceByAdapter.get(adapterId);
      if (!preference) {
        return {
          adapterId,
          displayName: operator.displayName,
          modelId: null,
          enabled: false,
          reason: "not configured for this step",
        };
      }
      if (!input.supportsModel(adapterId, preference.modelId)) {
        return {
          adapterId,
          displayName: operator.displayName,
          modelId: preference.modelId,
          enabled: false,
          reason: "configured model is not supported",
        };
      }
      return {
        adapterId,
        displayName: operator.displayName,
        modelId: preference.modelId,
        enabled: operator.ready,
        reason: operator.ready ? null : operator.notReadyReason ?? "provider unavailable",
      };
    });
}
```

Add `composeProviderSwitchPrompt` using `composeAgentInitialPrompt` and a final
bounded section:

```text
# Interrupted session handoff
The previous provider stopped because its usage limit was reached.
Continue the same step using this bounded transcript:
${interruptedTail}
```

Use `ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES` as the hard cap.

- [ ] **Step 4: Run helper tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/orchestrator/provider-recovery.test.ts src/workflows/operators/registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/provider-recovery.ts apps/daemon/src/workflows/orchestrator/provider-recovery.test.ts apps/daemon/src/workflows/operators/registry.ts apps/daemon/src/workflows/operators/registry.test.ts
git commit -m "feat(daemon): build provider recovery choices"
```

## Task 4: Persist Recovery And Pause The Activity

**Files:**
- Modify: `apps/daemon/src/activities/store.ts`
- Modify: `apps/daemon/src/activities/store.test.ts`
- Modify: `apps/daemon/src/activities/projection.ts`
- Modify: `apps/daemon/src/activities/projection.test.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/agent-interview.test.ts`

- [ ] **Step 1: Replace the current blocking test with a failing pause test**

Update the session-limit integration expectation:

```ts
expect(
  db.prepare("SELECT status, blocked_reason FROM workflow_runs WHERE id = ?").get(runId),
).toEqual({ status: "active", blocked_reason: null });

expect(
  db.prepare(
    "SELECT status, failure_reason FROM sessions WHERE id = ?",
  ).get(sessionId),
).toEqual({ status: "running", failure_reason: null });

const recovery = JSON.parse(
  (db.prepare(
    "SELECT pending_provider_recovery_json AS recovery FROM workflow_step_runs WHERE id = ?",
  ).get(stepRunId) as { recovery: string }).recovery,
);
expect(recovery).toMatchObject({
  mode: "choose",
  currentSessionId: sessionId,
  currentAdapterId: "claude-code",
  resetTimeText: "1:20am (America/Los_Angeles)",
});

expect(
  db.prepare("SELECT status, source_kind FROM activities WHERE id = 'activity-limit'").get(),
).toEqual({
  status: "paused_for_input",
  source_kind: "provider_recovery_pending",
});
expect(terminate).not.toHaveBeenCalled();
```

Add a second invocation and assert the same checkpoint ID and one activity row.
Run the same detection with supervision mode `unsupervised` and assert Orca
still creates the checkpoint and does not spawn or select another provider.

- [ ] **Step 2: Write failing activity store/projection tests**

Add:

```ts
const paused = pauseForProviderRecovery(ctx, {
  stepRunId,
  summary: "Claude Code is available again at 4:20am America/New_York.",
});
expect(paused?.sourceKind).toBe("provider_recovery_pending");
expect(paused?.status).toBe("paused_for_input");
```

In projection tests, persist `pending_provider_recovery_json` and assert
`listActivitiesByGoal` returns `providerRecovery`.

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
pnpm --filter @orca/daemon test -- src/activities/store.test.ts src/activities/projection.test.ts src/workflows/orchestrator/agent-interview.test.ts
```

Expected: FAIL because provider recovery still blocks/fails/terminates.

- [ ] **Step 4: Add activity pause/resume helpers**

In `activities/store.ts`, add:

```ts
export function pauseForProviderRecovery(
  ctx: ActivityStoreCtx,
  input: { stepRunId: string; summary: string },
): ActivityT | undefined {
  return updateLivePause(ctx, {
    stepRunId: input.stepRunId,
    currentText: input.summary,
    sourceKind: "provider_recovery_pending",
  });
}

export function resumeFromProviderRecovery(
  ctx: ActivityStoreCtx,
  input: {
    stepRunId: string;
    agentSessionId: string;
    summary: string;
  },
): ActivityT | undefined {
  return resumePausedLive(ctx, {
    stepRunId: input.stepRunId,
    expectedSourceKind: "provider_recovery_pending",
    agentSessionId: input.agentSessionId,
    currentText: input.summary,
  });
}
```

`resumePausedLive` must update `agent_session_id` so a successful switch rebinds
the live activity to the replacement session. Reuse the existing
transaction/event pattern; do not duplicate event insertion.

In `activities/projection.ts`, enrich only recovery activities:

```ts
function enrichProviderRecovery(db: Database.Database, activity: ActivityT): ActivityT {
  if (activity.sourceKind !== "provider_recovery_pending") return activity;
  const row = db.prepare(
    "SELECT pending_provider_recovery_json AS recovery FROM workflow_step_runs WHERE id = ?",
  ).get(activity.stepRunId) as { recovery: string | null } | undefined;
  if (!row?.recovery) return activity;
  return Activity.parse({
    ...activity,
    providerRecovery: ProviderRecoveryCheckpoint.parse(JSON.parse(row.recovery)),
  });
}
```

- [ ] **Step 5: Change limit detection into checkpoint creation**

In `onSessionOutputChunk`:

1. Parse the structured failure with `new Date(now())`.
2. Return early if an existing valid checkpoint already exists.
3. Compute:

   ```ts
   const connectedAdapterIds = listAgents(db)
     .filter((agent) => agent.connected)
     .map((agent) => agent.id);
   const operatorDescriptors = await this.operators.list(run.goalId, {
     agentIds: connectedAdapterIds,
     includeNonAgents: false,
   });
   ```

   Pass `connectedAdapterIds` and `operatorDescriptors` to the choice builder;
   registered but disconnected adapters must never be probed or create switch
   controls.
4. Persist `ProviderRecoveryCheckpoint` in
   `pending_provider_recovery_json`.
5. Pause the activity with reset-time-aware text.
6. Do not call `blockRun`, `failSession`, or `workerTerminate`.

Use:

```ts
const checkpoint = ProviderRecoveryCheckpoint.parse({
  id: options.idFactory?.() ?? randomUUID(),
  mode: "choose",
  failureCode: providerFailure.code,
  message: providerFailure.message,
  currentSessionId: args.sessionId,
  currentAdapterId: sess.adapter_id,
  currentProviderName: resolveShadowProvider(sess.adapter_id as ShadowAdapterId).displayName,
  resetTimeText: providerFailure.resetTimeText,
  resetAt: providerFailure.resetAt,
  timezone: providerFailure.timezone,
  detectedAt,
  retryOutputSeq: null,
  retryKind: "preserved_session",
  replacementSessionId: null,
  replacementOutputSeq: null,
  pendingGuidance: [],
  lastError: null,
  choices,
});
```

The summary is:

```ts
providerFailure.resetTimeText
  ? `${provider.displayName} reached its session limit. Available again at ${providerFailure.resetTimeText}.`
  : `${provider.displayName} reached its session limit. Reset time unavailable.`;
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/activities/store.test.ts src/activities/projection.test.ts src/workflows/orchestrator/agent-interview.test.ts
pnpm --filter @orca/daemon typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/activities/store.ts apps/daemon/src/activities/store.test.ts apps/daemon/src/activities/projection.ts apps/daemon/src/activities/projection.test.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/agent-interview.test.ts
git commit -m "feat(daemon): pause on provider limits"
```

## Task 5: Implement Wait, Retry, Refresh, And Switch Actions

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/worker-session.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/worker-session.test.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/session-tail.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/session-tail.test.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

- [ ] **Step 1: Write failing worker wait tests**

Add:

```ts
await mgr.waitForProviderReset("sess-1", "claude-code");
expect(tmux.calls).toContainEqual([
  "send-keys",
  "-t",
  "orca-worker-sess-1",
  "Enter",
]);
```

Also assert an unregistered but live deterministic session name can be
controlled after daemon restart.

- [ ] **Step 2: Write failing service action tests**

Add tests for:

- `waitForProvider` changes mode from `choose` to `waiting`, preserves the
  session row/status, and calls worker wait.
- `retryProvider` stores the session's current `output_seq`, changes mode to
  `retrying`, and delivers `Continue the previous step request.` to the same
  session.
- when a restart changed `retryKind` to `fresh_session`, `retryProvider`
  launches the same adapter with bounded handoff context instead of claiming
  that the missing native session was preserved.
- a preserved-session Retry before a known future `resetAt` is rejected without
  delivering input; unknown reset times remain manually retryable.
- a user chat message while recovery is pending is appended to bounded
  `pendingGuidance`, produces an Orca acknowledgement, and is not sent to the
  limited worker.
- provider output matching `detectTurnStarted` after the stored output sequence
  sends any pending guidance to the preserved session, then clears the
  checkpoint and resumes the activity.
- the same limit appearing while retrying returns to `waiting` and refreshes the
  reset data.
- `refreshProviderRecovery` rebuilds choices but preserves checkpoint identity
  and mode.
- `switchProvider` rejects stale IDs, current adapter IDs, disabled choices,
  and providers that become unavailable.
- successful switch creates a new session with handoff context, commits the new
  selected operator/model only after started output, includes pending guidance
  in the handoff, clears recovery, resumes activity, then terminates the old
  session.
- failed switch startup keeps the old session and checkpoint in `choose` mode.
- superseded or failed replacement session rows receive terminal DB status
  without publishing `session.stopped`/`session.failed`, so the normal workflow
  terminal subscriber cannot block or crash-retry the still-active step.
- old turn-start text in chunks before `retryOutputSeq` does not clear a new
  retry checkpoint.

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/orchestrator/worker-session.test.ts src/workflows/orchestrator/service.agent-step.test.ts
```

Expected: FAIL because recovery action methods do not exist.

- [ ] **Step 4: Add worker wait control**

Track adapter IDs in the manager:

```ts
interface WorkerSession {
  name: string;
  adapterId: string;
  ready: Promise<void>;
}
```

Add:

```ts
async waitForProviderReset(sessionId: string, adapterId: string): Promise<void> {
  const name = this.sessions.get(sessionId)?.name ?? this.name(sessionId);
  const provider = this.deps.resolveProvider(adapterId);
  if (!provider.waitForLimitReset) {
    throw new Error(`${provider.displayName} does not support preserving a limited session`);
  }
  await provider.waitForLimitReset({
    tmux: this.tmux,
    sessionName: name,
    dbg: (message) => console.debug(`[worker-session] ${message}`),
  });
}
```

- [ ] **Step 5: Add orchestrator recovery methods**

Add public methods with checkpoint ID validation:

```ts
async waitForProvider(
  db: Database.Database,
  now: () => string,
  runId: string,
  checkpointId: string,
  options: RequestNextDecisionOptions = {},
): Promise<void>

async retryProvider(
  db: Database.Database,
  now: () => string,
  runId: string,
  checkpointId: string,
  options: RequestNextDecisionOptions = {},
): Promise<void>

async refreshProviderRecovery(
  db: Database.Database,
  now: () => string,
  runId: string,
  checkpointId: string,
  options: RequestNextDecisionOptions = {},
): Promise<void>

async switchProvider(
  db: Database.Database,
  now: () => string,
  runId: string,
  checkpointId: string,
  adapterId: string,
  options: RequestNextDecisionOptions = {},
): Promise<void>
```

Use one private loader:

```ts
private loadProviderRecoveryContext(
  db: Database.Database,
  runId: string,
  checkpointId: string,
): ProviderRecoveryContext
```

It must validate:

- run/step remain active;
- current step matches the checkpoint step;
- checkpoint parses;
- checkpoint ID matches;
- current session still belongs to the step.

Enforce this transition table:

| Action | Allowed modes |
|---|---|
| Wait | `choose` |
| Retry | `waiting` |
| Refresh | `choose`, `waiting` |
| Switch | `choose`, `waiting` |

Reject actions during `retrying` or `switching` with the typed
invalid-transition error.

For `retryKind: "preserved_session"`, reject Retry while
`resetAt !== null && Date.parse(resetAt) > Date.parse(now())`. Return a typed
invalid-transition error so the HTTP route responds `409`.

Persist each mode transition before invoking external worker operations, and
clear `lastError` when starting it. Restore `choose`/`waiting` and persist a
bounded `lastError` if the operation fails.

Branch retry behavior on `checkpoint.retryKind`:

```ts
if (checkpoint.retryKind === "preserved_session") {
  await this.workerDeliver?.(
    checkpoint.currentSessionId,
    "Continue the previous step request.",
  );
} else {
  await this.startRecoveryReplacementSession(
    db,
    now,
    context,
    checkpoint.currentAdapterId,
    checkpoint,
    options,
  );
}
```

In the existing user-message path, check
`pending_provider_recovery_json` before invoking the orchestrator mediator or
`workerDeliver`. Append the raw user body to `pendingGuidance`, retaining the
newest 20 messages and enforcing the contract's 4000-character item bound.
Return an Orca reply such as:

```text
Saved this guidance. It will be sent when the current provider is retried or
included in the replacement provider handoff.
```

- [ ] **Step 6: Detect retry and switch startup progress**

Add a sequence-bounded decoder in `session-tail.ts`:

```ts
function decodeChunks(
  chunks: SessionOutputSnapshot["chunks"],
  maxBytes: number,
): string {
  const ordered = [...chunks].sort((left, right) => left.seq - right.seq);
  const buffer = Buffer.concat(
    ordered.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
  const bounded =
    buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes) : buffer;
  return bounded.toString("utf8");
}

export function decodeSessionTailFromSeq(
  snapshot: SessionOutputSnapshot,
  firstSeq: number,
  maxBytes: number = ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
): string {
  return decodeChunks(
    snapshot.chunks.filter((chunk) => chunk.seq >= firstSeq),
    maxBytes,
  );
}
```

Refactor `decodeSessionTail` to use the same private `decodeChunks` helper and
test that chunks before `firstSeq` are excluded.

Reorder `onSessionOutputChunk` after loading the step and tail:

1. Parse any existing provider-recovery checkpoint.
2. Handle `retrying`/`switching` output first.
3. For `choose`/`waiting`, update reset details if another matching limit frame
   arrives, then return without creating duplicates.
4. Only create a new checkpoint when none exists.
5. Run normal `[orca:ask]` handling only when no recovery checkpoint exists.

Use this retry branch:

```ts
if (checkpoint?.mode === "retrying") {
  const recoverySessionId =
    checkpoint.retryKind === "preserved_session"
      ? checkpoint.currentSessionId
      : checkpoint.replacementSessionId;
  const firstSeq =
    checkpoint.retryKind === "preserved_session"
      ? checkpoint.retryOutputSeq
      : checkpoint.replacementOutputSeq;
  if (!recoverySessionId || args.sessionId !== recoverySessionId || firstSeq === null) return;
  const snapshot = this.sessionOutputStore.readTail(args.sessionId);
  if (snapshot.nextSeq <= firstSeq) return;
  const retryTail = decodeSessionTailFromSeq(snapshot, firstSeq);
  const retryFailure = provider.turnParser().detectError?.(retryTail, new Date(now()));
  if (retryFailure) {
    const newResetFields = {
      message: retryFailure.message,
      resetTimeText: retryFailure.resetTimeText,
      resetAt: retryFailure.resetAt,
      timezone: retryFailure.timezone,
      detectedAt: now(),
      retryOutputSeq: null,
      replacementSessionId: null,
      replacementOutputSeq: null,
    };
    updateCheckpoint({ ...checkpoint, mode: "waiting", ...newResetFields });
    return;
  }
  if (provider.turnParser().detectTurnStarted?.(retryTail)) {
    if (
      checkpoint.retryKind === "preserved_session" &&
      checkpoint.pendingGuidance.length > 0
    ) {
      const guidance = checkpoint.pendingGuidance.join("\n\n");
      const delivered = await this.workerDeliver?.(recoverySessionId, guidance);
      if (delivered !== "delivered") {
        updateCheckpoint({
          ...checkpoint,
          lastError: "The provider resumed, but pending guidance could not be delivered.",
        });
        return;
      }
    }
    clearCheckpoint();
    resumeFromProviderRecovery(activityCtx, {
      stepRunId: stepRun.id,
      agentSessionId: recoverySessionId,
      summary:
        checkpoint.retryKind === "preserved_session"
          ? `Retrying ${checkpoint.currentProviderName} in the preserved session…`
          : `Continuing ${checkpoint.currentProviderName} in a fresh session…`,
    });
    if (
      checkpoint.retryKind === "fresh_session" &&
      checkpoint.currentSessionId !== recoverySessionId
    ) {
      setSessionStatus(db, checkpoint.currentSessionId, "stopped", {
        failureReason: "provider_session_replaced",
        exitedAt: now(),
      });
      await this.workerTerminate?.(checkpoint.currentSessionId).catch(() => {});
    }
  }
  return;
}
```

Use a separate switching branch:

```ts
if (
  checkpoint?.mode === "switching" &&
  checkpoint.replacementSessionId === args.sessionId &&
  checkpoint.replacementOutputSeq !== null
) {
  const snapshot = this.sessionOutputStore.readTail(args.sessionId);
  if (snapshot.nextSeq <= checkpoint.replacementOutputSeq) return;
  const switchTail = decodeSessionTailFromSeq(
    snapshot,
    checkpoint.replacementOutputSeq,
  );
  const replacementFailure = provider
    .turnParser()
    .detectError?.(switchTail, new Date(now()));
  if (replacementFailure) {
    setSessionStatus(db, args.sessionId, "failed", {
      failureReason: "provider_recovery_start_failed",
      exitedAt: now(),
    });
    await this.workerTerminate?.(args.sessionId).catch(() => {});
    updateCheckpoint({
      ...checkpoint,
      mode: "choose",
      replacementSessionId: null,
      replacementOutputSeq: null,
      lastError: replacementFailure.message,
    });
    return;
  }
  if (provider.turnParser().detectTurnStarted?.(switchTail)) {
    const choice = checkpoint.choices.find(
      (candidate) => candidate.adapterId === sess.adapter_id && candidate.enabled,
    );
    if (!choice?.modelId) return;
    const mode = this.stepDispatch!.resolveMode(choice.adapterId);
    this.commitDeterministicStepSelection(
      db,
      now,
      { run, stepRun, stepTpl, template, goal },
      {
        adapterId: choice.adapterId,
        modelId: choice.modelId,
        executionMode: mode.mode,
        fallbackModes: mode.fallbacks,
      },
      options,
    );
    clearCheckpoint();
    resumeFromProviderRecovery(activityCtx, {
      stepRunId: stepRun.id,
      agentSessionId: args.sessionId,
      summary: `Continuing with ${choice.displayName}…`,
    });
    setSessionStatus(db, checkpoint.currentSessionId, "stopped", {
      failureReason: "provider_switched",
      exitedAt: now(),
    });
    await this.workerTerminate?.(checkpoint.currentSessionId).catch(() => {});
  }
  return;
}
```

`startRecoveryReplacementSession` must persist both `replacementSessionId` and
that session's pre-delivery `output_seq` as `replacementOutputSeq`. Commit
selection and retire the old session only in the successful switching branch.
These direct status updates intentionally do not publish terminal session
events; add assertions that no `session.stopped` or `session.failed` event is
inserted for recovery cleanup.

- [ ] **Step 7: Run state-machine tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/orchestrator/worker-session.test.ts src/workflows/orchestrator/session-tail.test.ts src/workflows/orchestrator/service.agent-step.test.ts src/workflows/orchestrator/agent-interview.test.ts
pnpm --filter @orca/daemon typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/worker-session.ts apps/daemon/src/workflows/orchestrator/worker-session.test.ts apps/daemon/src/workflows/orchestrator/session-tail.ts apps/daemon/src/workflows/orchestrator/session-tail.test.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts apps/daemon/src/workflows/orchestrator/agent-interview.test.ts packages/contracts/src/index.ts packages/contracts/src/__tests__/orchestration-contracts.test.ts
git commit -m "feat(daemon): recover limited provider sessions"
```

## Task 6: Restore Recovery On Boot And Expose HTTP Actions

**Files:**
- Modify: `apps/daemon/src/workflows/reconcile.ts`
- Modify: `apps/daemon/src/workflows/reconcile.test.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/resume.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/resume.test.ts`
- Modify: `apps/daemon/src/server.ts`
- Modify: `apps/daemon/src/server.test.ts`

- [ ] **Step 1: Write failing restart tests**

Persist a waiting checkpoint with no activity and assert reconciliation creates:

```ts
expect(activity).toMatchObject({
  status: "paused_for_input",
  source_kind: "provider_recovery_pending",
});
```

Add a missing-worker case through the boot resume seam:

- preserve the checkpoint;
- change `retryKind` to `fresh_session`;
- make the activity explain that the preserved native session is gone and the
  current-provider action will restart the same step in a fresh session;
- keep alternative switch choices.

Add a `resumeActiveRuns` unit test proving a pending recovery with a missing
worker calls `markRecoverySessionMissing` and never calls normal `respawn`.

- [ ] **Step 2: Write failing route tests**

Add authenticated route tests:

```ts
POST /v1/workflows/runs/run-1/provider-recovery/wait
POST /v1/workflows/runs/run-1/provider-recovery/retry
POST /v1/workflows/runs/run-1/provider-recovery/refresh
POST /v1/workflows/runs/run-1/provider-recovery/switch
```

Assert:

- valid requests return `202`;
- malformed bodies return `400`;
- stale checkpoint IDs return `409`;
- unavailable switch targets return `409`;
- unknown runs return `404`.

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/reconcile.test.ts src/workflows/orchestrator/resume.test.ts src/server.test.ts -t "provider recovery"
```

Expected: FAIL because reconciliation/routes do not exist.

- [ ] **Step 4: Reconcile provider recovery activities**

After supervised checkpoint reconciliation, query:

```sql
SELECT id AS step_run_id,
       workflow_run_id,
       goal_id,
       pending_provider_recovery_json AS recovery
FROM workflow_step_runs
WHERE pending_provider_recovery_json IS NOT NULL
  AND finished_at IS NULL
```

For each valid checkpoint:

1. `openOrUpdateLive` using the preserved session ID.
2. `pauseForProviderRecovery`.
3. Keep malformed checkpoints from crashing boot; clear only malformed JSON and
   post a bounded diagnostic event.

- [ ] **Step 5: Make boot resume recovery-aware**

Extend `ResumeRunRow`:

```ts
interface ResumeRunRow {
  runId: string;
  goalId: string;
  currentStepRunId: string;
  sessionId: string | null;
  providerRecoveryPending: boolean;
}
```

Extend dependencies:

```ts
markRecoverySessionMissing(args: {
  runId: string;
  stepRunId: string;
  sessionId: string | null;
}): Promise<void>;
```

Use:

```ts
if (r.providerRecoveryPending) {
  if (r.sessionId && await deps.isSessionAlive(r.sessionId)) {
    await deps.reattach({ runId: r.runId, sessionId: r.sessionId });
  } else {
    await deps.markRecoverySessionMissing({
      runId: r.runId,
      stepRunId: r.currentStepRunId,
      sessionId: r.sessionId,
    });
  }
  continue;
}
```

In server boot wiring, select
`pending_provider_recovery_json IS NOT NULL AS provider_recovery_pending`.
`markRecoverySessionMissing` updates the checkpoint to
`retryKind: "fresh_session"` and republishes the recovery activity; it must not
call `respawnStepAgent`.

- [ ] **Step 6: Wire worker controls and routes**

Pass a worker wait callback beside spawn/deliver/terminate:

```ts
(sessionId, adapterId) => workerSessions.waitForProviderReset(sessionId, adapterId)
```

Add strict Zod-validated route bodies using the Task 1 schemas. Map domain
errors:

- missing run/checkpoint: `404`;
- stale checkpoint or invalid transition: `409`;
- invalid body: `400`.

- [ ] **Step 7: Run daemon route/restart tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/reconcile.test.ts src/workflows/orchestrator/resume.test.ts src/server.test.ts
pnpm --filter @orca/daemon typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/workflows/reconcile.ts apps/daemon/src/workflows/reconcile.test.ts apps/daemon/src/workflows/orchestrator/resume.ts apps/daemon/src/workflows/orchestrator/resume.test.ts apps/daemon/src/server.ts apps/daemon/src/server.test.ts
git commit -m "feat(daemon): expose provider recovery actions"
```

## Task 7: Add Desktop API And Recovery Card

**Files:**
- Create: `apps/desktop/src/orchestrator/ProviderRecoveryCard.tsx`
- Create: `apps/desktop/src/orchestrator/ProviderRecoveryCard.test.tsx`
- Modify: `apps/desktop/src/api.ts`
- Modify: `apps/desktop/src/api.test.ts`
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx`
- Modify: `apps/desktop/src/orchestrator/ActivityThread.test.tsx`
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Modify: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`
- Modify: `apps/desktop/src/orchestrator/orca-chat.css`

- [ ] **Step 1: Write failing API tests**

Assert the exact calls:

```ts
await waitForProviderRecovery("run-1", { checkpointId: "recovery-1" });
expect(fetchMock).toHaveBeenCalledWith(
  expect.stringContaining("/v1/workflows/runs/run-1/provider-recovery/wait"),
  expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ checkpointId: "recovery-1" }),
  }),
);
```

Repeat for retry, refresh, and switch.

- [ ] **Step 2: Write failing component tests**

Render a recovery checkpoint and assert:

- reset label:
  `Available again at 4:20am (America/New_York)`;
- fallback label: `Reset time unavailable`;
- only Wait/Retry when `choices` is empty;
- enabled Codex switch button;
- disabled Antigravity button with reason;
- Refresh providers calls the refresh endpoint and reloads the activity;
- waiting mode preserves and displays the current session message;
- a known future `resetAt` disables Retry until the browser clock reaches it;
- an unknown reset time keeps manual Retry enabled;
- `retryKind: "fresh_session"` changes the action label to
  `Restart <provider> session` and explains that native context could not be
  preserved;
- retrying/switching modes disable duplicate actions;
- action failures restore buttons and render the error.
- persisted `lastError` renders after an SSE refresh.

- [ ] **Step 3: Run desktop tests to verify RED**

Run:

```bash
pnpm --filter @orca/desktop test -- src/api.test.ts src/orchestrator/ProviderRecoveryCard.test.tsx
```

Expected: FAIL because the API functions/component do not exist.

- [ ] **Step 4: Implement desktop API functions**

Add:

```ts
export async function waitForProviderRecovery(
  runId: string,
  body: ProviderRecoveryActionRequest,
): Promise<void>

export async function retryProviderRecovery(
  runId: string,
  body: ProviderRecoveryActionRequest,
): Promise<void>

export async function refreshProviderRecovery(
  runId: string,
  body: ProviderRecoveryActionRequest,
): Promise<void>

export async function switchProviderRecovery(
  runId: string,
  body: ProviderRecoverySwitchRequest,
): Promise<void>
```

All use `requestVoid`, authenticated JSON headers, and action-specific error
messages.

- [ ] **Step 5: Implement `ProviderRecoveryCard`**

Use props:

```ts
interface ProviderRecoveryCardProps {
  runId: string;
  recovery: ProviderRecoveryCheckpoint;
  onChanged(): void;
}
```

Render:

```tsx
<section
  className="provider-recovery-card"
  aria-label="Provider recovery"
  data-mode={recovery.mode}
>
  <h3>{recovery.currentProviderName} reached its session limit</h3>
  <p>
    {recovery.resetTimeText
      ? `Available again at ${recovery.resetTimeText}`
      : "Reset time unavailable"}
  </p>
  <p>The existing agent session and context will be preserved while waiting.</p>
  {recovery.lastError ? (
    <p role="alert" className="provider-recovery-error">{recovery.lastError}</p>
  ) : null}
  <button
    type="button"
    disabled={submitting || retryLocked}
    onClick={() => void handleCurrentProvider()}
  >
    {currentProviderActionLabel}
  </button>
  {recovery.choices.length > 0 ? (
    <>
      <ul className="provider-recovery-choices">
        {recovery.choices.map((choice) => (
          <li key={choice.adapterId}>
            <button
              type="button"
              disabled={submitting || !choice.enabled}
              onClick={() => void handleSwitch(choice.adapterId)}
            >
              Switch to {choice.displayName}
            </button>
            {!choice.enabled && choice.reason ? (
              <span className="provider-recovery-choice-reason">{choice.reason}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={submitting}
        onClick={() => void handleRefresh()}
      >
        Refresh providers
      </button>
    </>
  ) : null}
</section>
```

Disabled choices must remain visible with:

```tsx
<span className="provider-recovery-choice-reason">{choice.reason}</span>
```

Use local `submitting`/`error` state only for transient request state. The
checkpoint remains server-owned.

`currentProviderActionLabel` is:

- `Wait for <provider>` in `choose`;
- `Retry <provider>` in `waiting` with `preserved_session`;
- `Restart <provider> session` in `waiting` with `fresh_session`;
- `Retrying <provider>…` in `retrying`;
- `Starting replacement provider…` in `switching`.

For a known future `resetAt`, maintain a local `clockReady` boolean and schedule
one timeout capped at `2_147_483_647` milliseconds; reschedule until the reset
instant when the interval exceeds that cap. This timer only enables the button.
The daemon remains authoritative and rejects an early Retry.

- [ ] **Step 6: Add scoped recovery-card styles**

Add styles under `.provider-recovery-card` in `orca-chat.css` for:

- title and reset-time text;
- vertical action layout matching existing chat cards;
- enabled primary action;
- disabled provider rows with a visible reason;
- inline error text;
- `data-mode="retrying"` and `data-mode="switching"` busy states.

Reuse existing CSS variables and button typography. Do not restyle general chat
buttons or activity bubbles.

- [ ] **Step 7: Integrate with activity/chat**

Extend `LiveActivity` props:

```ts
renderProviderRecovery?: ComponentType<{
  runId: string;
  recovery: NonNullable<Activity["providerRecovery"]>;
}>;
```

Render the card only when:

```ts
activity.status === "paused_for_input" &&
activity.sourceKind === "provider_recovery_pending" &&
activity.providerRecovery
```

In `OrcaChat`:

- clear `awaitingReply` for provider recovery, as already done for confirmation;
- call `setRefreshNonce` after every action;
- keep the normal composer visible;
- do not synthesize a second generic thinking bubble.

- [ ] **Step 8: Run desktop tests**

Run:

```bash
pnpm --filter @orca/desktop test -- src/api.test.ts src/orchestrator/ProviderRecoveryCard.test.tsx src/orchestrator/ActivityThread.test.tsx src/orchestrator/OrcaChat.test.tsx
pnpm --filter @orca/desktop typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.test.ts apps/desktop/src/orchestrator/ProviderRecoveryCard.tsx apps/desktop/src/orchestrator/ProviderRecoveryCard.test.tsx apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/ActivityThread.test.tsx apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx apps/desktop/src/orchestrator/orca-chat.css
git commit -m "feat(desktop): add provider recovery card"
```

## Task 8: End-To-End Verification And Cleanup

**Files:**
- Modify only files required by failures found in this task.

- [ ] **Step 1: Run focused contract and daemon suites**

Run:

```bash
pnpm --filter @orca/contracts test
pnpm --filter @orca/daemon test -- src/orchestrator-llm/providers/registry.test.ts src/workflows/orchestrator/provider-recovery.test.ts src/workflows/orchestrator/agent-interview.test.ts src/workflows/orchestrator/service.agent-step.test.ts src/workflows/orchestrator/worker-session.test.ts src/workflows/reconcile.test.ts src/server.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused desktop suites**

Run:

```bash
pnpm --filter @orca/desktop test -- src/api.test.ts src/orchestrator/ProviderRecoveryCard.test.tsx src/orchestrator/ActivityThread.test.tsx src/orchestrator/OrcaChat.test.tsx
```

Expected: PASS without new React `act(...)` warnings in the added tests.

- [ ] **Step 3: Run typechecks and diff validation**

Run:

```bash
pnpm --filter @orca/contracts typecheck
pnpm --filter @orca/daemon typecheck
pnpm --filter @orca/desktop typecheck
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 4: Run full affected package tests**

Run:

```bash
pnpm --filter @orca/daemon test
pnpm --filter @orca/desktop test
```

Expected: PASS. If the known `http-surface` 5-second timeout appears only under
parallel full-suite load, rerun that test alone and report both results rather
than changing production code.

- [ ] **Step 5: Manual live proof**

Using a test goal with Claude Code and Codex connected:

1. Trigger the exact Claude message:

   ```text
   You've hit your session limit · resets 4:20am (America/New_York)
   /upgrade to increase your usage limit.
   ```

2. Verify the workflow and step remain active.
3. Verify the recovery card shows the exact reset time and timezone.
4. Choose Wait and verify the same session ID remains attached.
5. Choose Retry before quota reset and verify the card returns to waiting.
6. With only Claude connected, verify no switch section appears.
7. With Claude and Codex connected, switch to Codex and verify:
   - explicit confirmation is required in Auto-run;
   - the new session receives bounded handoff context;
   - the old session remains until Codex starts;
   - the same step continues and the checkpoint clears.

- [ ] **Step 6: Commit any verification fixes in their owning task**

Run:

```bash
git status --short
```

Expected: no uncommitted files from this plan. If verification exposed a bug,
return to the task that owns that file, add a failing regression test, implement
the minimal correction, rerun that task's verification command, and commit it
with that task's commit message scope. Do not create a miscellaneous cleanup
commit.
