# Stuck-Step Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a step whose worker is alive but not progressing detectable, automatically recoverable, and — when it cannot be recovered — visible as a cost to the step score.

**Architecture:** The liveness watchdog gains a second sensor: a stall clock that only accrues while Orca owes the next move, tripping into the same `failSession` → crash-retry ladder the dead-worker reap already uses. That ladder finally terminates the step run at its cap instead of leaving it `active` forever, which is what lets `aggregate.ts`'s existing (and until now always-empty) `hardFailedFinals` penalty fire. Rescued-then-passed step runs carry a fractional denominator cost. A deterministic `/stuck` chat command feeds the same ladder for the one case no sensor can observe.

**Tech Stack:** TypeScript (strict), Node, Fastify, better-sqlite3, Zod contracts (`@orca/contracts`), Vitest, React 18 + Testing Library (desktop), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-29-stuck-step-detection-design.md`

## Global Constraints

- Run tests from the package root: `pnpm --filter @orca/daemon test`, `pnpm --filter @orca/desktop test`, `pnpm --filter @orca/contracts test`. Single file: `pnpm --filter @orca/daemon exec vitest run src/path/to/file.test.ts`.
- TDD: every task writes the failing test first, watches it fail, then implements. Commit at the end of each task with a Conventional Commits subject.
- **Surgical changes** (CLAUDE.md §3): touch only what the task names. Do not reformat, rename, or "improve" adjacent code.
- **No jargon in user-visible copy.** `apps/desktop/src/metrics/no-jargon.test.tsx` enforces a banned-word scan on rendered metrics copy. Chat strings must read plainly: "hasn't made progress", never "stalled/reaped/vetoed".
- Scores recompute from persisted rows on every read. No backfill or data migration is ever needed for a scoring change.
- `STALL_WEIGHT = 0.5` and `ORCA_STALL_MS` default `600000` are the spec's designed values — use them exactly.
- Migration files are append-only and numbered; the next free number is `0064`. Every new migration must be added to the expected list in `apps/daemon/src/migrations.test.ts`.

---

## File Structure

**Daemon — sensor and recovery**
- Modify `apps/daemon/src/workflows/orchestrator/liveness-watchdog.ts` — add the stall sensor beside the dead-worker reap
- Modify `apps/daemon/src/workflows/orchestrator/liveness-watchdog.test.ts` — sensor tests
- Modify `apps/daemon/src/server.ts:1029-1041` — wire `ORCA_STALL_MS` and the shared progress map
- Modify `apps/daemon/src/workflows/orchestrator/service.ts:342-364` — rescue accounting, announcement, termination at cap

**Daemon — terminal facts**
- Create `apps/daemon/migrations/0064_step_run_stall_rescues.sql`
- Modify `apps/daemon/src/workflows/runs/usecases.ts` — close in-flight step runs on cancel
- Modify `apps/daemon/src/goals.ts:438` — same on goal archive

**Daemon — scoring**
- Modify `apps/daemon/src/metrics/fetch.ts:9-19,84-104` — carry `stallRescues`
- Modify `apps/daemon/src/metrics/aggregate.ts:347-357` — denominator weighting
- Modify `apps/daemon/src/metrics/aggregate.steps.test.ts` — scoring tests

**Daemon — command**
- Create `apps/daemon/src/commands/routes.ts` — `POST /v1/goals/:goalId/commands`
- Create `apps/daemon/src/commands/usecases.ts` — the `/stuck` handler
- Create `apps/daemon/src/commands/usecases.test.ts`
- Modify `packages/contracts/src/index.ts` — `SessionFailureReason` additions + command request/response shapes

**Desktop — command surface**
- Create `apps/desktop/src/orchestrator/slash-commands.ts` — the registry + parser
- Create `apps/desktop/src/orchestrator/slash-commands.test.ts`
- Modify `apps/desktop/src/orchestrator/OrcaChat.tsx:924-964` — intercept, autocomplete
- Modify `apps/desktop/src/api.ts` — `runGoalCommand`

---

### Task 1: System-turn stall sensor

**Files:**
- Modify: `packages/contracts/src/index.ts:569-576` (`SessionFailureReason`)
- Modify: `apps/daemon/src/workflows/orchestrator/liveness-watchdog.ts`
- Test: `apps/daemon/src/workflows/orchestrator/liveness-watchdog.test.ts`

**Interfaces:**
- Consumes: existing `WatchdogStepRow`, `LivenessWatchdogDeps`, `buildLivenessWatchdogDeps`, `livenessWatchdogTick`.
- Produces: `WatchdogStepRow` gains `outputSeq: number`, `activityAtMs: number | null`, `systemTurn: boolean`. `LivenessWatchdogDeps` gains `stallMs: number`, `progress: Map<string, ProgressMark>`, `reapStalled(row: WatchdogStepRow): void`. `buildLivenessWatchdogDeps` opts gain `stallMs: number` and `progress: Map<string, ProgressMark>`. New exported `export interface ProgressMark { outputSeq: number; activityAtMs: number | null; sinceMs: number }`. Task 2 consumes the `"worker_stalled"` failure reason.

**Background the implementer needs:** a worker can be alive and still make no progress (observed live: a Claude Code session parked in its rewind modal for 33 minutes). The existing tick only reaps when tmux is *gone*. Progress is "either `sessions.output_seq` advanced or the step's `activities.updated_at` advanced". The clock must run **only when Orca owes the next move** — if the user is being asked something, waiting is correct, not stuck.

The subtle part: `activities/store.ts:233` inserts every opened activity with `status = 'active'`, and only the explicit park paths (`question_pending`, `step_confirmation_pending`, `gate_decision_pending`, `mark_done_pending`, `provider_recovery_pending`) later flip it to `paused_for_input`. A **`permission_pending` activity keeps `status = 'active'`**. Checking status alone would reap a worker that is waiting for the user to approve a tool. Both conditions are required.

- [ ] **Step 1: Add the failure reasons to contracts**

In `packages/contracts/src/index.ts`, extend the existing enum:

```ts
export const SessionFailureReason = z.enum([
  "command_not_found",
  "workspace_unavailable",
  "spawn_failed",
  "daemon_restart",
  "internal_error",
  "worker_stalled",
  "user_declared_stuck"
]);
```

- [ ] **Step 2: Write the failing sensor tests**

Append to `apps/daemon/src/workflows/orchestrator/liveness-watchdog.test.ts`. Add these helpers above the `describe` block:

```ts
const STALL_MS = 600_000;
const T0 = Date.parse(NOW);

/** A tick clock: NOW + `offsetMs`, in the ISO form buildLivenessWatchdogDeps expects. */
function atOffset(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

/** Seed the live activity row for a step run. */
function seedActivity(
  db: Database.Database,
  opts: { goalId: string; runId: string; stepRunId: string; status: string; sourceKind: string; updatedAt: string }
): void {
  db.prepare(
    `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
       status, current_text, final_summary, source_kind, work_category, confidence, pending_question,
       created_at, updated_at, completed_at)
     VALUES ('act-1', ?, ?, ?, NULL, 0, ?, 'working', NULL, ?, NULL, NULL, NULL, ?, ?, NULL)`
  ).run(opts.goalId, opts.runId, opts.stepRunId, opts.status, opts.sourceKind, NOW, opts.updatedAt);
}

function setOutputSeq(db: Database.Database, sessionId: string, seq: number): void {
  db.prepare("UPDATE sessions SET output_seq = ? WHERE id = ?").run(seq, sessionId);
}
```

Then the tests:

```ts
describe("livenessWatchdogTick — stall sensor", () => {
  it("reaps a live-but-idle worker after the stall window (system's turn)", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, stepRunId } = seedRunningWorkerStep(db);
    const launch: WorkflowSessionLauncher["launch"] = vi.fn(async () => ({ sessionId: "respawn-1" }));
    const { completions } = makeServiceWithSubscriber(db, bus, idFactory, launch);

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true,
      now: () => clock,
      graceMs: GRACE_MS,
      stallMs: STALL_MS,
      progress,
    });

    await livenessWatchdogTick(deps);          // baseline mark
    clock = atOffset(STALL_MS + 1);            // no output, no activity movement
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(sessionStatus(db, sessionId)).toBe("failed");
    const reason = (
      db.prepare("SELECT failure_reason AS r FROM sessions WHERE id = ?").get(sessionId) as { r: string }
    ).r;
    expect(reason).toBe("worker_stalled");
    expect(crashRetries(db, stepRunId)).toBe(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("does not reap while output_seq keeps advancing", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    setOutputSeq(db, sessionId, 42);
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS + 2);
    await livenessWatchdogTick(deps);          // only 1ms since the reset

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("does not reap while the step's activity keeps updating (hook progress)", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));
    seedActivity(db, { goalId, runId, stepRunId, status: "active", sourceKind: "tool_use", updatedAt: NOW });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    db.prepare("UPDATE activities SET updated_at = ? WHERE id = 'act-1'").run(atOffset(1000));
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS + 2);
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("never reaps while paused_for_input, however long the wait", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));
    seedActivity(db, { goalId, runId, stepRunId, status: "paused_for_input", sourceKind: "question_pending", updatedAt: NOW });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 100);
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("never reaps a worker awaiting permission approval, despite its active status", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));
    // openActivity inserts status='active' for EVERY source kind — permission_pending
    // is never flipped to paused_for_input, so status alone is not enough.
    seedActivity(db, { goalId, runId, stepRunId, status: "active", sourceKind: "permission_pending", updatedAt: NOW });

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS * 100);
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("forgets accumulated idle time when the turn passes to the user", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, progress,
    });

    await livenessWatchdogTick(deps);                     // system turn, clock starts
    clock = atOffset(STALL_MS - 1000);
    seedActivity(db, { goalId, runId, stepRunId, status: "paused_for_input", sourceKind: "question_pending", updatedAt: NOW });
    await livenessWatchdogTick(deps);                     // user's turn → mark dropped
    expect(progress.has(stepRunId)).toBe(false);

    db.prepare("UPDATE activities SET status = 'completed', completed_at = ? WHERE id = 'act-1'").run(NOW);
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);                     // system turn again: re-baseline, no reap
    expect(sessionStatus(db, sessionId)).toBe("running");
  });

  it("still reaps a dead worker immediately, without waiting for the stall window", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => false, now: () => NOW, graceMs: GRACE_MS,
      stallMs: STALL_MS, progress: new Map<string, ProgressMark>(),
    });
    await livenessWatchdogTick(deps);

    expect(sessionStatus(db, sessionId)).toBe("failed");
    const reason = (
      db.prepare("SELECT failure_reason AS r FROM sessions WHERE id = ?").get(sessionId) as { r: string }
    ).r;
    expect(reason).toBe("worker_exited_no_signal");
  });
});
```

Add `ProgressMark` to the existing import from `./liveness-watchdog.js`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/liveness-watchdog.test.ts`
Expected: FAIL — `stallMs`/`progress` are not valid options, `ProgressMark` is not exported.

- [ ] **Step 4: Extend the watchdog types**

In `liveness-watchdog.ts`, add to `WatchdogStepRow`:

```ts
  /** Monotonic PTY output counter for the worker session. */
  outputSeq: number;
  /** Latest hook-driven activity update for this step run, epoch ms; null if none. */
  activityAtMs: number | null;
  /** True when Orca owes the next move (nothing is waiting on the user). */
  systemTurn: boolean;
```

Add the mark type and the new deps:

```ts
/** Last observed progress for a step run, carried across ticks. */
export interface ProgressMark {
  outputSeq: number;
  activityAtMs: number | null;
  /** When this mark was taken, epoch ms — the start of the current idle stretch. */
  sinceMs: number;
}
```

and inside `LivenessWatchdogDeps`:

```ts
  /** System-turn idle time (ms) tolerated before a live worker is reaped. */
  stallMs: number;
  /** Progress marks by step run; owned by the caller so state survives ticks. */
  progress: Map<string, ProgressMark>;
  /** Emit the terminal failure signal for a live-but-idle worker. */
  reapStalled(row: WatchdogStepRow): void;
```

- [ ] **Step 5: Add the sensor to the tick**

Replace the alive check at the end of the loop body in `livenessWatchdogTick`:

```ts
      // Dead worker: the original backstop, reaped immediately.
      if (!(await deps.isTmuxAlive(row.sessionId))) {
        deps.progress.delete(row.stepRunId);
        deps.reap(row);
        continue;
      }
      // Alive. Only time where ORCA owes the next move counts as a stall — a worker
      // waiting on the user is behaving correctly, however long that takes, so any
      // accumulated idle time is forgotten rather than banked.
      if (!row.systemTurn) {
        deps.progress.delete(row.stepRunId);
        continue;
      }
      const mark = deps.progress.get(row.stepRunId);
      if (
        mark === undefined ||
        mark.outputSeq !== row.outputSeq ||
        mark.activityAtMs !== row.activityAtMs
      ) {
        // First sighting, or real progress since the last tick: re-baseline.
        deps.progress.set(row.stepRunId, {
          outputSeq: row.outputSeq,
          activityAtMs: row.activityAtMs,
          sinceMs: now,
        });
        continue;
      }
      if (now - mark.sinceMs < deps.stallMs) continue;
      deps.progress.delete(row.stepRunId);
      deps.reapStalled(row);
```

Update the doc comment above the function to name the second sensor.

- [ ] **Step 6: Extend the query and the built deps**

In `buildLivenessWatchdogDeps`, widen the `opts` type with `stallMs: number` and `progress: Map<string, ProgressMark>`, then pass them straight through (`stallMs: opts.stallMs, progress: opts.progress`).

Extend the SQL — add the session counter and a join to the live activity row (the unique partial index `idx_activities_one_live_per_step` guarantees at most one):

```sql
           SELECT s.id AS session_id, wsr.goal_id AS goal_id, wsr.id AS step_run_id,
                  s.started_at AS started_at, s.output_seq AS output_seq,
                  a.status AS activity_status, a.source_kind AS activity_source_kind,
                  a.updated_at AS activity_updated_at
           FROM sessions s
           JOIN workflow_step_runs wsr ON wsr.id = s.workflow_step_run_id AND wsr.goal_id = s.goal_id
           JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
           LEFT JOIN activities a
             ON a.step_run_id = wsr.id AND a.status IN ('active','paused_for_input')
           WHERE ...unchanged...
```

Widen the row cast with `output_seq: number; activity_status: string | null; activity_source_kind: string | null; activity_updated_at: string | null`, and map:

```ts
      return rows.map((r) => ({
        sessionId: r.session_id,
        goalId: r.goal_id,
        stepRunId: r.step_run_id,
        startedAtMs: r.started_at ? Date.parse(r.started_at) : null,
        outputSeq: r.output_seq,
        activityAtMs: r.activity_updated_at ? Date.parse(r.activity_updated_at) : null,
        // `permission_pending` is the exception that makes this two conditions rather
        // than one: openActivity inserts EVERY activity as 'active', and only the park
        // paths flip the status, so a worker awaiting tool approval reads as active.
        systemTurn:
          r.activity_status !== "paused_for_input" && r.activity_source_kind !== "permission_pending",
      }));
```

Add the stalled reap beside the existing one:

```ts
    reapStalled: (row) =>
      failSession(db, bus, row.sessionId, row.goalId, "worker_stalled", opts.now()),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/liveness-watchdog.test.ts`
Expected: PASS — all seven stall tests plus the six pre-existing ones.

- [ ] **Step 8: Wire the daemon**

In `apps/daemon/src/server.ts` at the watchdog setup (~line 1029), add the knob and the shared map:

```ts
    const stallMs = Number(process.env["ORCA_STALL_MS"] ?? 600000);
    const watchdogProgress = new Map<string, ProgressMark>();
    const watchdogDeps = buildLivenessWatchdogDeps(db, eventBus, {
      isTmuxAlive,
      now,
      graceMs: watchdogGraceMs,
      stallMs,
      progress: watchdogProgress,
    });
```

Match the existing call's argument names (read the surrounding lines first — `isTmuxAlive`/`now` are already in scope there). Import `ProgressMark` alongside the existing watchdog imports.

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm --filter @orca/daemon exec tsc --noEmit` and `pnpm --filter @orca/contracts test`
Expected: both clean.

```bash
git add packages/contracts/src/index.ts apps/daemon/src/workflows/orchestrator/liveness-watchdog.ts apps/daemon/src/workflows/orchestrator/liveness-watchdog.test.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): detect workers that are alive but not progressing"
```

---

### Task 2: Rescue accounting and termination at the cap

**Files:**
- Create: `apps/daemon/migrations/0064_step_run_stall_rescues.sql`
- Modify: `apps/daemon/src/migrations.test.ts:191`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts:342-364`
- Test: `apps/daemon/src/workflows/orchestrator/liveness-watchdog.test.ts`

**Interfaces:**
- Consumes: `"worker_stalled"` from Task 1; existing `incrementCrashRetry`, `CRASH_RETRY_CAP`, `postOrchestratorMessage(db, now, goalId, body, options)`.
- Produces: `workflow_step_runs.stall_rescues` (read by Task 5); a `blocked` terminal step run at the cap (read by Tasks 3 and 5).

**Background:** `session.failed` already routes into `onWorkflowSessionCompleted`'s crash branch (`service.ts:342`): bump `crash_retries`, respawn under `CRASH_RETRY_CAP` (3), and at the cap post *"Manual intervention needed"* — leaving the step run `active` forever. That last part is the bug: nothing in the daemon ever writes a terminal step-run status, which is why `aggregate.ts`'s hard-fail penalty has never fired. `markStepBlocked(db, now, stepRunId, reason)` (`workflows/steps/usecases.ts:428`) and `markWorkflowRunBlocked(ctx, runId, reason)` (`workflows/runs/usecases.ts:301`) both exist and are unused here. `blocked` is recoverable — `resume` asserts `["paused","blocked"]`.

- [ ] **Step 1: Write the migration**

`apps/daemon/migrations/0064_step_run_stall_rescues.sql`:

```sql
-- 0064_step_run_stall_rescues.sql
-- Counts rescues caused by a worker that stopped making progress (or by the user
-- saying so), as distinct from crash_retries, which counts workers that died.
-- Both share the CRASH_RETRY_CAP budget; only this one costs the step score.
ALTER TABLE workflow_step_runs ADD COLUMN stall_rescues INTEGER NOT NULL DEFAULT 0;
```

Add `"0064_step_run_stall_rescues.sql"` to the end of the expected list in `apps/daemon/src/migrations.test.ts:191`.

- [ ] **Step 2: Write the failing tests**

Append to `apps/daemon/src/workflows/orchestrator/liveness-watchdog.test.ts`:

```ts
function stallRescues(db: Database.Database, stepRunId: string): number {
  return (
    db.prepare("SELECT stall_rescues AS c FROM workflow_step_runs WHERE id = ?").get(stepRunId) as {
      c: number;
    }
  ).c;
}

describe("stall recovery accounting", () => {
  it("counts a stall rescue separately from a crash retry and says so in the chat", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId, stepRunId } = seedRunningWorkerStep(db);
    const { completions } = makeServiceWithSubscriber(
      db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" }))
    );

    const progress = new Map<string, ProgressMark>();
    let clock = NOW;
    const deps = buildLivenessWatchdogDeps(db, bus, {
      isTmuxAlive: async () => true, now: () => clock, graceMs: GRACE_MS, stallMs: STALL_MS, progress,
    });
    await livenessWatchdogTick(deps);
    clock = atOffset(STALL_MS + 1);
    await livenessWatchdogTick(deps);
    await Promise.all(completions);

    expect(stallRescues(db, stepRunId)).toBe(1);
    expect(crashRetries(db, stepRunId)).toBe(1);
    const body = (
      db.prepare(
        "SELECT body AS b FROM orchestrator_messages WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(goalId) as { b: string }
    ).b;
    expect(body).toContain("hasn't made progress");
    expect(body).toContain("2 of 3");
  });

  it("at the cap, blocks the step run and the workflow run instead of leaving it active", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId, runId, stepRunId } = seedRunningWorkerStep(db, {
      crashRetries: CRASH_RETRY_CAP - 1,
    });
    const { completions } = makeServiceWithSubscriber(
      db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" }))
    );

    failSession(db, bus, sessionId, goalId, "worker_stalled", NOW);
    await Promise.all(completions);

    const stepRun = db
      .prepare("SELECT status, finished_at, blocked_reason FROM workflow_step_runs WHERE id = ?")
      .get(stepRunId) as { status: string; finished_at: string | null; blocked_reason: string | null };
    expect(stepRun.status).toBe("blocked");
    expect(stepRun.finished_at).not.toBeNull();
    const run = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(runId) as { status: string };
    expect(run.status).toBe("blocked");
  });
});
```

Import `failSession` from `../../sessions/runtime.js` and `CRASH_RETRY_CAP` from `./crash-retry.js`. If `orchestrator_messages` is not the table name `postOrchestratorMessage` writes to, read `apps/daemon/src/workflows/orchestrator/orchestrator-message.ts` and assert against the table it actually uses.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/liveness-watchdog.test.ts -t "stall recovery accounting"`
Expected: FAIL — no `stall_rescues` column / step run still `active`.

- [ ] **Step 4: Implement the crash-branch changes**

In `service.ts`, replace the body of the `if (sess.status === "failed")` branch:

```ts
    if (sess.status === "failed") {
      // A worker that stopped making progress (or that the user declared stuck) is a
      // different fact from one that died: both consume the same rescue budget, but
      // only this one is counted against the step's score.
      const stalled =
        sess.failure_reason === "worker_stalled" || sess.failure_reason === "user_declared_stuck";
      const counter = incrementCrashRetry(stepRun.crash_retries ?? 0);
      db.prepare("UPDATE workflow_step_runs SET crash_retries = ? WHERE id = ?").run(
        counter.nextAttempt,
        stepRun.id
      );
      if (stalled) {
        db.prepare(
          "UPDATE workflow_step_runs SET stall_rescues = stall_rescues + 1 WHERE id = ?"
        ).run(stepRun.id);
      }
      if (counter.capReached) {
        const reason = stalled
          ? `no progress after ${CRASH_RETRY_CAP} restarts`
          : `crashed ${CRASH_RETRY_CAP} times${sess.failure_reason ? ` (${sess.failure_reason})` : ""}`;
        postOrchestratorMessage(
          db,
          now,
          run.goalId,
          `"${stepTpl.name}" ${stalled ? `hasn't made progress after ${CRASH_RETRY_CAP} restarts` : `crashed ${CRASH_RETRY_CAP} times`}. I've stopped the run here — pick it back up when you're ready.`,
          options
        );
        markStepBlocked(db, now, stepRun.id, reason, options);
        markWorkflowRunBlocked({ db, bus: options.bus, idFactory: options.idFactory }, run.id, reason);
      } else {
        if (stalled) {
          postOrchestratorMessage(
            db,
            now,
            run.goalId,
            `"${stepTpl.name}" hasn't made progress in a while — restarting it (attempt ${counter.nextAttempt + 1} of ${CRASH_RETRY_CAP}).`,
            options
          );
        }
        await this.engine.spawnStepAgent(
          db,
          now,
          { run, stepRun, stepTpl, template, goal },
          options
        );
      }
      return;
    }
```

Import `markStepBlocked` from `../steps/usecases.js` and `markWorkflowRunBlocked` from `../runs/usecases.js`. Read `markWorkflowRunBlocked`'s `WorkflowRunUsecaseCtx` shape (`workflows/runs/usecases.ts`) and construct it from what `onWorkflowSessionCompleted` already has in scope — do not invent fields.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/liveness-watchdog.test.ts`
Expected: PASS. The pre-existing `"at CRASH_RETRY_CAP → escalates to a human instead of spinning"` test asserts on the old message text — update its expected string to the new copy in the same commit; that is a deliberate copy change, not an unrelated edit.

- [ ] **Step 6: Run the full daemon suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS. `migrations.test.ts` covers the new file; fix the expected-list entry if it fails.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/migrations/0064_step_run_stall_rescues.sql apps/daemon/src/migrations.test.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/liveness-watchdog.test.ts
git commit -m "feat(daemon): stop a step that cannot be restarted back to life"
```

---

### Task 3: Resuming a blocked run opens a new attempt

**Files:**
- Test: `apps/daemon/src/workflows/runs/usecases.test.ts` (or the resume test file that already exists — check `apps/daemon/src/workflows/orchestrator/resume.test.ts` first)
- Modify: whichever resume path the test proves wrong (likely `apps/daemon/src/workflows/runs/usecases.ts` `resumeWorkflowRun`)

**Interfaces:**
- Consumes: the `blocked` step run + `blocked` run produced by Task 2.
- Produces: no new exports. Guarantees that a resumed run has an `active` step run for the same `step_template_id` with `attempt = previous + 1`.

**Background — this is the one identified risk in the spec.** Task 2 makes `markStepBlocked` set `finished_at`, so the step run is terminal. Before Task 2 nothing ever blocked a step run, so the resume path has never faced this state. If resume tries to revive the terminal row, the run comes back broken. Prove the behavior before assuming it.

- [ ] **Step 1: Write the failing test**

```ts
it("resuming a blocked run starts a fresh attempt of the same step", () => {
  const { db, bus, idFactory } = setupHarness();
  const { runId, stepRunId } = seedRunningWorkerStep(db);

  markStepBlocked(db, () => NOW, stepRunId, "no progress after 3 restarts");
  markWorkflowRunBlocked({ db, bus, idFactory }, runId, "no progress after 3 restarts");

  resumeWorkflowRun({ db, bus, idFactory }, runId);

  const run = db.prepare("SELECT status, current_step_run_id FROM workflow_runs WHERE id = ?")
    .get(runId) as { status: string; current_step_run_id: string | null };
  expect(run.status).toBe("active");
  expect(run.current_step_run_id).not.toBe(stepRunId);

  const fresh = db.prepare("SELECT attempt, status, step_template_id FROM workflow_step_runs WHERE id = ?")
    .get(run.current_step_run_id) as { attempt: number; status: string; step_template_id: string };
  expect(fresh.status).toBe("active");
  expect(fresh.attempt).toBe(2);

  const old = db.prepare("SELECT status FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as { status: string };
  expect(old.status).toBe("blocked");
});
```

Reuse the seeding style of the file you put this in; if `seedRunningWorkerStep` is not importable there, copy the minimal seed (goal, workspace, template, run, step run) from `liveness-watchdog.test.ts`.

- [ ] **Step 2: Run it to see what actually happens**

Run: `pnpm --filter @orca/daemon exec vitest run <the test file> -t "resuming a blocked run"`
Expected: FAIL. **Read the failure before writing any code** — it tells you which of two worlds you're in:
- resume leaves `current_step_run_id` pointing at the terminal row → implement Step 3
- resume already opens a new attempt → the test passes after a trivial adjustment and Step 3 is a no-op; say so in the commit message rather than inventing work

- [ ] **Step 3: Implement only what the failure proves is missing**

If a new attempt is not created, in `resumeWorkflowRun` — after the status flip to `active` — open a fresh step run when the current one is terminal:

```ts
    // A run blocked at the rescue cap has a TERMINAL step run (finished_at set), so
    // resuming has to open the next attempt rather than revive a finished row.
    const current = ctx.db
      .prepare("SELECT id, step_template_id, ordinal, attempt, status FROM workflow_step_runs WHERE id = ?")
      .get(run.currentStepRunId) as
      | { id: string; step_template_id: string; ordinal: number; attempt: number; status: string }
      | undefined;
    if (current && current.status !== "active") {
      // insertStep() computes the fingerprint from (runId, templateStepId, attempt),
      // so a bumped attempt is what keeps the new row distinct from the blocked one.
      const next = insertStep(
        ctx.db, /* …its exact parameter order — read the signature */
        current.attempt + 1
      );
      ctx.db
        .prepare("UPDATE workflow_runs SET current_step_run_id = ? WHERE id = ?")
        .run(next.id, runId);
    }
```

The helper is `insertStep` at `apps/daemon/src/workflows/steps/usecases.ts:182` — module-private, so export it (a one-word change) rather than hand-rolling a second `INSERT INTO workflow_step_runs`. Read its full signature and pass the goal id, run id, `step_template_id`, and `ordinal` from the `current` row; it sets `status = 'active'`, `finished_at = NULL`, and the fingerprint itself. Match the surrounding transaction and event-emission conventions.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run <the test file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add <the test file> <any modified source>
git commit -m "fix(daemon): resuming a blocked run opens the next attempt"
```

---

### Task 4: Cancel and archive close the in-flight step run

**Files:**
- Modify: `apps/daemon/src/workflows/runs/usecases.ts:209-265` (`cancelWorkflowRun`)
- Modify: `apps/daemon/src/goals.ts:438` (`archiveGoal`)
- Test: `apps/daemon/src/workflows/runs/usecases.test.ts`

**Interfaces:**
- Consumes: `markStepBlocked(db, now, stepRunId, reason, eventOptions?)`.
- Produces: terminal step runs for abandoned work, read by Task 5's scoring.

**Background:** `cancelWorkflowRun` sets the run `cancelled` and clears the goal's pointer, but never touches the in-flight step run — it stays `active` with `finished_at = NULL` forever. That is how giving up on a stuck step currently disappears from the score entirely. Same for archiving a goal.

- [ ] **Step 1: Write the failing tests**

```ts
it("cancelling a run closes the step that was in flight", () => {
  const { db, bus, idFactory } = setupHarness();
  const { runId, stepRunId } = seedActiveRunOnStep(db);

  cancelWorkflowRun({ db, bus, idFactory }, runId);

  const stepRun = db
    .prepare("SELECT status, finished_at, blocked_reason FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as { status: string; finished_at: string | null; blocked_reason: string | null };
  expect(stepRun.status).toBe("blocked");
  expect(stepRun.finished_at).not.toBeNull();
  expect(stepRun.blocked_reason).toBe("run_cancelled");
});

it("cancelling leaves already-finished step runs untouched", () => {
  const { db, bus, idFactory } = setupHarness();
  const { runId, stepRunId } = seedActiveRunOnStep(db);
  db.prepare("UPDATE workflow_step_runs SET status = 'passed', finished_at = ? WHERE id = ?")
    .run(NOW, stepRunId);

  cancelWorkflowRun({ db, bus, idFactory }, runId);

  const stepRun = db.prepare("SELECT status FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as { status: string };
  expect(stepRun.status).toBe("passed");
});

it("archiving a goal closes the step that was in flight", () => {
  const { db } = setupHarness();
  const { goalId, stepRunId } = seedActiveRunOnStep(db);

  archiveGoal(goalId);

  const stepRun = db.prepare("SELECT status, blocked_reason FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as { status: string; blocked_reason: string | null };
  expect(stepRun.status).toBe("blocked");
  expect(stepRun.blocked_reason).toBe("goal_archived");
});
```

`seedActiveRunOnStep` is the same seed as `seedRunningWorkerStep` minus the session row; if the file has an equivalent helper, use it rather than adding one.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/runs/usecases.test.ts`
Expected: FAIL — status is still `active`.

- [ ] **Step 3: Close the step run on cancel**

Inside `cancelWorkflowRun`'s transaction, after the descendant cascade and before the goal-pointer clear:

```ts
    // Abandoning a run must leave a terminal fact behind: an in-flight step run left
    // `active` forever is invisible to scoring, so giving up on a stuck step would
    // cost nothing.
    const inFlight = ctx.db
      .prepare(
        `SELECT id FROM workflow_step_runs
         WHERE workflow_run_id IN (${cancelledSet.map(() => "?").join(",")}) AND status = 'active'`
      )
      .all(...cancelledSet) as { id: string }[];
    for (const s of inFlight) {
      markStepBlocked(ctx.db, () => now, s.id, "run_cancelled");
    }
```

`markStepBlocked` opens its own transaction; better-sqlite3 does not nest transactions, so if this throws at runtime, hoist the loop to run immediately **after** the outer transaction commits (before `publishStagedWorkflowEvents`) and note why in a comment.

- [ ] **Step 4: Close the step run on archive**

In `goals.ts` `archiveGoal`, alongside the existing status update:

```ts
  const inFlight = db
    .prepare(
      `SELECT wsr.id AS id FROM workflow_step_runs wsr
       WHERE wsr.goal_id = ? AND wsr.status = 'active'`
    )
    .all(id) as { id: string }[];
  for (const s of inFlight) {
    markStepBlocked(db, () => timestamp, s.id, "goal_archived");
  }
```

Use the module's existing db handle and timestamp variables — read the surrounding function rather than introducing new ones.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/runs/usecases.ts apps/daemon/src/goals.ts apps/daemon/src/workflows/runs/usecases.test.ts
git commit -m "fix(daemon): abandoning a run closes the step that was in flight"
```

---

### Task 5: Rescued steps cost the score

**Files:**
- Modify: `apps/daemon/src/metrics/fetch.ts:9-19,84-104`
- Modify: `apps/daemon/src/metrics/aggregate.ts:347-357`
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts`, `apps/daemon/src/metrics/fetch.test.ts`

**Interfaces:**
- Consumes: `workflow_step_runs.stall_rescues` (Task 2), `blocked` finals (Tasks 2 and 4).
- Produces: `TemplateStepRun.stallRescues: number`; `STALL_WEIGHT` exported from `aggregate.ts`.

**Background:** `scoreOver` (`aggregate.ts:352`) computes `Σ contribution(conclusive) / (conclusive.length + hardFails)`. `hardFailedFinals` already counts `failed`/`blocked` finals as 0 — until this branch, nothing ever wrote those statuses, so that penalty never fired. Two additions: those rows now exist (nothing to change), and a step run that was rescued and *then* passed carries a fractional cost. `listStepRunsByTemplate` returns **every** attempt, so a rescued-then-passed run is visible even though `finalAttempts` collapses to the last one.

- [ ] **Step 1: Write the failing scoring tests**

In `aggregate.steps.test.ts`:

```ts
describe("rescued steps cost the score", () => {
  const sr = (runId: string, over: Partial<TemplateStepRun> = {}): TemplateStepRun => ({
    workflowRunId: runId, stepTemplateId: "s", attempt: 1, status: "passed",
    startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z",
    blockedReason: null, templateVersion: 1, stallRescues: 0, ...over,
  });

  it("a step that needed one rescue scores below three clean passes", () => {
    const ts = [
      sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z"),
      sc("b", "r2", "s", "passed", true, "2026-05-01T01:00:00.000Z"),
      sc("c", "r3", "s", "passed", true, "2026-05-01T02:00:00.000Z"),
    ];
    const clean = computeStepMetrics({
      transitions: ts, stepRuns: [sr("r1"), sr("r2"), sr("r3")],
      stepNames: names, nowIso, period: "30d",
    })[0]!;
    const rescued = computeStepMetrics({
      transitions: ts, stepRuns: [sr("r1"), sr("r2"), sr("r3", { stallRescues: 1 })],
      stepNames: names, nowIso, period: "30d",
    })[0]!;

    expect(clean.verification.score).toBe(1);
    // n = 3 + 0.5 → 3.0 / 3.5
    expect(rescued.verification.score).toBeCloseTo(3 / 3.5, 6);
    expect(rescued.verification.score!).toBeLessThan(clean.verification.score!);
  });

  it("counts rescues from every attempt, not just the final one", () => {
    const ts = [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")];
    const step = computeStepMetrics({
      transitions: ts,
      stepRuns: [
        sr("r1", { attempt: 1, status: "blocked", stallRescues: 2, blockedReason: "no progress" }),
        sr("r1", { attempt: 2, status: "passed", stallRescues: 0 }),
      ],
      stepNames: names, nowIso, period: "30d",
    })[0]!;
    // one conclusive pass, two rescues → 1.0 / (1 + 1.0)
    expect(step.verification.score).toBeCloseTo(0.5, 6);
  });

  it("a blocked final with no completion is a hard zero", () => {
    const step = computeStepMetrics({
      transitions: [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")],
      stepRuns: [
        sr("r1"),
        sr("r2", { status: "blocked", blockedReason: "run_cancelled", finishedAt: "2026-05-01T01:00:00.000Z" }),
      ],
      stepNames: names, nowIso, period: "30d",
    })[0]!;
    expect(step.verification.score).toBeCloseTo(0.5, 6);
  });
});
```

Every other `TemplateStepRun` literal in the metrics tests now needs `stallRescues: 0` — the type is required, so `tsc` will point at each one.

In `fetch.test.ts`, extend the existing `listStepRunsByTemplate` test (or add one) asserting `stallRescues` comes back from the column, defaulting to `0`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/metrics/aggregate.steps.test.ts -t "rescued steps"`
Expected: FAIL — `stallRescues` is not a property of `TemplateStepRun`.

- [ ] **Step 3: Carry the column through fetch**

In `fetch.ts`, add `stallRescues: number;` to `TemplateStepRun`, add `wsr.stall_rescues` to the SELECT list, add `stall_rescues: number` to the row cast, and map `stallRescues: r.stall_rescues`.

- [ ] **Step 4: Weight the denominator**

In `aggregate.ts`, beside the other scoring constants:

```ts
/**
 * What one rescue costs, relative to a whole completion, in the score denominator.
 * A step the system had to restart to get through is less trustworthy than one that
 * ran clean — but it did deliver, so it is not a whole failure either.
 */
export const STALL_WEIGHT = 0.5;
```

Then in the per-step block, next to `hardFailedFinals`:

```ts
    // Rescues are counted across EVERY attempt, not just finals: a run that stalled
    // twice and then passed still cost two rescues, and `finalAttempts` would hide them.
    const rescueCount = stepRuns.reduce((acc, r) => acc + (r.stallRescues ?? 0), 0);
```

and change `scoreOver` to carry the weight:

```ts
    const scoreOver = (
      completes: typeof finalStepCompletes,
      hardFails: number,
      rescues: number
    ): { n: number; value: number | null } => {
      const conc = completes.filter(isConclusive);
      const n = conc.length + hardFails + STALL_WEIGHT * rescues;
      return n === 0 ? { n, value: null } : { n, value: conc.reduce((acc, t) => acc + contribution(t), 0) / n };
    };
    const headline = scoreOver(finalStepCompletes, hardFailedFinals.length, rescueCount);
```

Update the other `scoreOver` call sites (the per-version delta block near line 377) — pass the rescue count filtered to that version's step runs, mirroring how `hardFailedFinals` is filtered there. `scoredSampleSize` derives from `headline.n`; leave that untouched.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/metrics/`
Expected: PASS, including the fixture updates from Step 1.

- [ ] **Step 6: Full suite and typecheck**

Run: `pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/metrics/
git commit -m "feat(daemon): steps the system had to rescue score below clean ones"
```

---

### Task 6: The `/stuck` command endpoint

**Files:**
- Create: `apps/daemon/src/commands/usecases.ts`, `apps/daemon/src/commands/routes.ts`, `apps/daemon/src/commands/usecases.test.ts`
- Modify: `packages/contracts/src/index.ts` (request/response shapes)
- Modify: `apps/daemon/src/server.ts` (register the routes)

**Interfaces:**
- Consumes: `failSession(db, bus, sessionId, goalId, failureReason, now)`, `postOrchestratorMessage(...)`, the `"user_declared_stuck"` reason (Task 1), the ladder from Task 2.
- Produces: `POST /v1/goals/:goalId/commands` with `RunGoalCommandRequest { command: string; args?: string }` → `RunGoalCommandResponse { ok: true; message: string }`; consumed by Task 7.

**Background:** this is the last-resort path for what no sensor can see — an agent producing output while going in circles. It must be **deterministic**: a command that reaches the orchestrator LLM could be reinterpreted, which defeats the point. The handler records the user's message in the thread (so the log stays honest), stores the reason on the session, and reaps into the same ladder.

- [ ] **Step 1: Add the contract shapes**

In `packages/contracts/src/index.ts`, near the other request/response schemas:

```ts
export const RunGoalCommandRequest = z.object({
  command: z.string().min(1),
  args: z.string().optional(),
});
export type RunGoalCommandRequest = z.infer<typeof RunGoalCommandRequest>;

export const RunGoalCommandResponse = z.object({
  ok: z.literal(true),
  message: z.string(),
});
export type RunGoalCommandResponse = z.infer<typeof RunGoalCommandResponse>;
```

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/commands/usecases.test.ts`. `seedRunningWorkerStep` and `makeServiceWithSubscriber` are file-private to `liveness-watchdog.test.ts` — copy both into this file (the shared harness `apps/daemon/src/workflows/orchestrator/skill-step-test-helpers.ts` provides `setupHarness`, `cleanupHarness`, `NOW`, `makeStep`, `fakeRegistry`, `fakeStepDispatch`, which they build on). Copy the `afterEach` reset block too, or the prepared-statement caches leak between files.

```ts
describe("runGoalCommand", () => {
  it("/stuck fails the live worker with the user's reason and restarts it", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId, sessionId, stepRunId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    const result = await runGoalCommand(
      { db, bus, now: () => NOW, idFactory },
      goalId,
      { command: "stuck", args: "it keeps re-reading the same files" }
    );

    expect(result.ok).toBe(true);
    const sess = db
      .prepare("SELECT status, failure_reason, failure_detail FROM sessions WHERE id = ?")
      .get(sessionId) as { status: string; failure_reason: string; failure_detail: string | null };
    expect(sess.status).toBe("failed");
    expect(sess.failure_reason).toBe("user_declared_stuck");
    expect(sess.failure_detail).toBe("it keeps re-reading the same files");
    expect(
      (db.prepare("SELECT stall_rescues AS c FROM workflow_step_runs WHERE id = ?").get(stepRunId) as { c: number }).c
    ).toBe(1);
  });

  it("/stuck records what the user said in the chat thread", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId } = seedRunningWorkerStep(db);
    makeServiceWithSubscriber(db, bus, idFactory, vi.fn(async () => ({ sessionId: "respawn-1" })));

    await runGoalCommand({ db, bus, now: () => NOW, idFactory }, goalId, {
      command: "stuck", args: "going in circles",
    });

    const bodies = db
      .prepare("SELECT body AS b FROM orchestrator_messages WHERE goal_id = ?")
      .all(goalId) as { b: string }[];
    expect(bodies.some((r) => r.b.includes("going in circles"))).toBe(true);
  });

  it("rejects an unknown command without touching the run", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId, sessionId } = seedRunningWorkerStep(db);

    await expect(
      runGoalCommand({ db, bus, now: () => NOW, idFactory }, goalId, { command: "nope" })
    ).rejects.toBeInstanceOf(UnknownCommandError);

    const sess = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string };
    expect(sess.status).toBe("running");
  });

  it("/stuck with no live worker is a clear no-op, not a crash", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { goalId, sessionId } = seedRunningWorkerStep(db);
    db.prepare("UPDATE sessions SET status = 'exited' WHERE id = ?").run(sessionId);

    const result = await runGoalCommand({ db, bus, now: () => NOW, idFactory }, goalId, { command: "stuck" });
    expect(result.message).toContain("no agent running");
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/commands/usecases.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the handler**

`apps/daemon/src/commands/usecases.ts`:

```ts
import type Database from "better-sqlite3";
import type { RunGoalCommandRequest, RunGoalCommandResponse } from "@orca/contracts";

import type { EventBus } from "../events.js";
import { failSession } from "../sessions/runtime.js";
import { postOrchestratorMessage } from "../workflows/orchestrator/orchestrator-message.js";

export class UnknownCommandError extends Error {
  readonly code = "unknown_command";
  constructor(name: string) {
    super(`Unknown command: /${name}`);
  }
}

export interface GoalCommandCtx {
  db: Database.Database;
  bus: EventBus;
  now: () => string;
  idFactory?: () => string;
}

/** The live worker session for a goal's current step, if there is one. */
function liveWorkerSession(
  db: Database.Database,
  goalId: string
): { id: string; stepRunId: string } | null {
  const row = db
    .prepare(
      `SELECT s.id AS id, wsr.id AS step_run_id
       FROM sessions s
       JOIN workflow_step_runs wsr ON wsr.id = s.workflow_step_run_id AND wsr.goal_id = s.goal_id
       JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
       WHERE s.goal_id = ? AND s.status = 'running' AND wr.status = 'active' AND wsr.status = 'active'
       LIMIT 1`
    )
    .get(goalId) as { id: string; step_run_id: string } | undefined;
  return row ? { id: row.id, stepRunId: row.step_run_id } : null;
}

export async function runGoalCommand(
  ctx: GoalCommandCtx,
  goalId: string,
  input: RunGoalCommandRequest
): Promise<RunGoalCommandResponse> {
  if (input.command !== "stuck") throw new UnknownCommandError(input.command);

  const now = ctx.now();
  const reason = input.args?.trim() ?? "";
  // Record what the user said before acting on it: the thread is the audit trail.
  postOrchestratorMessage(
    ctx.db,
    ctx.now,
    goalId,
    reason ? `I'm stuck: ${reason}` : "I'm stuck.",
    { bus: ctx.bus, idFactory: ctx.idFactory },
    "user"
  );

  const session = liveWorkerSession(ctx.db, goalId);
  if (!session) {
    return { ok: true, message: "There's no agent running on this goal right now." };
  }

  if (reason) {
    ctx.db.prepare("UPDATE sessions SET failure_detail = ? WHERE id = ?").run(reason, session.id);
  }
  // Same path the stall sensor uses: restart under the cap, stop the run at it.
  failSession(ctx.db, ctx.bus, session.id, goalId, "user_declared_stuck", now);
  return { ok: true, message: "Thanks — restarting the agent on this step." };
}
```

Verify `postOrchestratorMessage`'s `options` parameter type (`RequestNextDecisionOptions`) and pass exactly the fields it needs; read `orchestrator-message.ts` before finalizing. `failSession` writes `failure_reason`, so set `failure_detail` **before** it.

- [ ] **Step 5: Add the route**

`apps/daemon/src/commands/routes.ts` — mirror `apps/daemon/src/orchestrator-chat/routes.ts` exactly (same `apiError` shape, same `safeParse` → 400, same `registerXRoutes(server, deps)` signature):

```ts
export function registerGoalCommandRoutes(server: FastifyInstance, deps: GoalCommandRouteDeps): void {
  server.post("/v1/goals/:goalId/commands", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = RunGoalCommandRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    try {
      const response = await runGoalCommand(
        { db: deps.db, bus: deps.bus, now: deps.now ?? (() => new Date().toISOString()), idFactory: deps.idFactory },
        goalId,
        parsed.data
      );
      return RunGoalCommandResponse.parse(response);
    } catch (error) {
      if (error instanceof UnknownCommandError) {
        reply.status(400);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });
}
```

Register it in `server.ts` next to the other `register*Routes` calls.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon test && pnpm --filter @orca/contracts test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/commands/ packages/contracts/src/index.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): /stuck command hands a stuck step back to the system"
```

---

### Task 7: `/stuck` in the chat input

**Files:**
- Create: `apps/desktop/src/orchestrator/slash-commands.ts`, `apps/desktop/src/orchestrator/slash-commands.test.ts`
- Modify: `apps/desktop/src/api.ts` (add `runGoalCommand`)
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx:924-964,1255-1290`
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Interfaces:**
- Consumes: `POST /v1/goals/:goalId/commands` (Task 6).
- Produces: `parseSlashCommand(draft: string): { command: string; args: string } | null`, `SLASH_COMMANDS: { name: string; args: string; describe: string }[]`, `matchSlashCommands(draft: string): typeof SLASH_COMMANDS`.

**Background:** the chat currently posts every draft to `createOrchestratorMessage`, which reaches the orchestrator LLM. A command must not be interpretable, so the input intercepts a leading `/` and routes elsewhere. Keep the registry to one entry (CLAUDE.md §2) — the shape makes adding a second trivial, but nothing speculative ships.

- [ ] **Step 1: Write the failing parser tests**

`apps/desktop/src/orchestrator/slash-commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchSlashCommands, parseSlashCommand, SLASH_COMMANDS } from "./slash-commands";

describe("parseSlashCommand", () => {
  it("parses a bare command", () => {
    expect(parseSlashCommand("/stuck")).toEqual({ command: "stuck", args: "" });
  });
  it("parses a command with a reason", () => {
    expect(parseSlashCommand("/stuck going in circles")).toEqual({
      command: "stuck", args: "going in circles",
    });
  });
  it("returns null for ordinary messages", () => {
    expect(parseSlashCommand("what is the status?")).toBeNull();
    expect(parseSlashCommand("use the /v1 endpoint")).toBeNull();
  });
  it("returns null for an unknown command so it is sent as a normal message", () => {
    expect(parseSlashCommand("/nope")).toBeNull();
  });
  it("ignores leading whitespace", () => {
    expect(parseSlashCommand("  /stuck ")).toEqual({ command: "stuck", args: "" });
  });
});

describe("matchSlashCommands", () => {
  it("offers every command for a bare slash", () => {
    expect(matchSlashCommands("/")).toEqual(SLASH_COMMANDS);
  });
  it("filters by prefix", () => {
    expect(matchSlashCommands("/st").map((c) => c.name)).toEqual(["stuck"]);
    expect(matchSlashCommands("/zz")).toEqual([]);
  });
  it("offers nothing once the command has arguments", () => {
    expect(matchSlashCommands("/stuck going in circles")).toEqual([]);
  });
  it("offers nothing for ordinary text", () => {
    expect(matchSlashCommands("hello")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/slash-commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry and parser**

`apps/desktop/src/orchestrator/slash-commands.ts`:

```ts
export interface SlashCommand {
  name: string;
  args: string;
  describe: string;
}

/** One entry today. Adding another is one object — no framework needed. */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "stuck",
    args: "[what's happening]",
    describe: "Tell Orca this step isn't going anywhere so it can restart the agent.",
  },
];

/** A known command and its argument text, or null if this is an ordinary message. */
export function parseSlashCommand(draft: string): { command: string; args: string } | null {
  const trimmed = draft.trim();
  if (!trimmed.startsWith("/")) return null;
  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!word) return null;
  if (!SLASH_COMMANDS.some((c) => c.name === word)) return null;
  return { command: word, args: rest.join(" ").trim() };
}

/** Commands to offer for the current draft — only while the name is still being typed. */
export function matchSlashCommands(draft: string): SlashCommand[] {
  const trimmed = draft.trim();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return [];
  const prefix = trimmed.slice(1);
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/slash-commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the API client function**

In `apps/desktop/src/api.ts`, mirroring `createOrchestratorMessage` (`:1157`):

```ts
export async function runGoalCommand(
  goalId: string,
  body: RunGoalCommandRequest,
): Promise<RunGoalCommandResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/commands`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(body),
    },
    RunGoalCommandResponse,
  );
}
```

Match the exact `requestJson` signature and schema-validation convention used by the neighbouring functions — read `createOrchestratorMessage` in full first.

- [ ] **Step 6: Write the failing chat test**

In `apps/desktop/src/orchestrator/OrcaChat.test.tsx`, add `runGoalCommandMock` to the mock list alongside `createOrchestratorMessageMock`, wire it into the existing `vi.mock("../api", ...)` factory, then:

```ts
it("sends /stuck as a command instead of a chat message", async () => {
  runGoalCommandMock.mockResolvedValue({ ok: true, message: "Thanks — restarting the agent on this step." });
  renderChat();                                  // use the file's existing render helper

  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "/stuck going in circles" } });
  fireEvent.submit(input.closest("form")!);

  await waitFor(() => expect(runGoalCommandMock).toHaveBeenCalledWith("goal-1", {
    command: "stuck",
    args: "going in circles",
  }));
  expect(createOrchestratorMessageMock).not.toHaveBeenCalled();
});

it("sends an unknown slash command as an ordinary message", async () => {
  renderChat();
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "/nope" } });
  fireEvent.submit(input.closest("form")!);

  await waitFor(() => expect(createOrchestratorMessageMock).toHaveBeenCalled());
  expect(runGoalCommandMock).not.toHaveBeenCalled();
});
```

Use the goal id and render helper the file already defines rather than inventing new ones.

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx -t "slash"`
Expected: FAIL — `runGoalCommand` is never called.

- [ ] **Step 8: Intercept in `handleSendMessage`**

In `OrcaChat.tsx`, immediately after the `pendingRevisionRunId` branch returns (so a revision draft still wins) and before the `createOrchestratorMessage` call:

```ts
    const command = parseSlashCommand(body);
    if (command) {
      setSendingMessage(true);
      setMessageError(null);
      try {
        await runGoalCommand(selectedGoalId, command);
        setMessageDraft("");
      } catch (err) {
        setMessageError(toErrorMessage(err, "Failed to run that command."));
      } finally {
        setSendingMessage(false);
      }
      return;
    }
```

- [ ] **Step 9: Add the autocomplete list**

Above the `<textarea>` in the input form, render suggestions from `matchSlashCommands(messageDraft)`:

```tsx
            {matchSlashCommands(messageDraft).length > 0 && (
              <ul className="orca-chat-command-list" role="listbox" aria-label="Commands">
                {matchSlashCommands(messageDraft).map((c) => (
                  <li key={c.name}>
                    <button
                      type="button"
                      onClick={() => setMessageDraft(`/${c.name} `)}
                    >
                      <span>/{c.name} {c.args}</span>
                      <span>{c.describe}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
```

Style it with the file's existing chat CSS conventions — reuse an existing popover/list class if one is present rather than adding new styles.

- [ ] **Step 10: Run the desktop suite**

Run: `pnpm --filter @orca/desktop test`
Expected: PASS, including `no-jargon.test.tsx`.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/orchestrator/slash-commands.ts apps/desktop/src/orchestrator/slash-commands.test.ts apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx apps/desktop/src/api.ts
git commit -m "feat(desktop): /stuck in the chat input"
```

---

## Final verification

- [ ] **Full suites:** `pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test`
- [ ] **Typecheck:** `pnpm --filter @orca/daemon exec tsc --noEmit && pnpm --filter @orca/desktop exec tsc --noEmit`
- [ ] **Live check** (per CLAUDE.md's browser-driving section): restart the daemon, run `pnpm dev:browser`, and on a goal with a live worker:
  - confirm a worker parked awaiting a permission approval is **never** restarted, however long it waits
  - set `ORCA_STALL_MS=60000`, park a worker, and confirm the chat reports the restart and the step score for that step drops on the Metrics tab
  - type `/stuck` and confirm the autocomplete appears and the agent restarts
- [ ] **Update `ORCA.md`** — the harness-axes section describes the liveness watchdog; add the stall sensor and the score consequence so the durable doc matches the code.
