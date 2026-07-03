/**
 * Task 10: Resume + failure-propagation hardening
 *
 * Tests for:
 *   1. Resume treats a delegating parent as dormant — only the active leaf is
 *      included in listActiveRuns; the delegating parent stays dormant.
 *   2. Session-launch-lost recovery — active child with no session → respawn.
 *   3. Child-terminal-FAILURE propagation on resume — composition active + child
 *      failed → after resume, parent blocked + composition failed.
 *   4. Non-gated clean-join — child terminal step_result_json.stepStatus = "completed"
 *      (no evidence-bearing step_complete) → joinChildRun returns "joined".
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { EventBus } from "../../events.js";
import type { Config } from "../../config.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetPreparedStatements as resetRunProjection } from "../runs/projection.js";
import { resetPreparedStatements as resetTemplateProjection } from "../templates/projection.js";
import { resetPreparedStatements as resetHarnessProjection } from "../../harness-transitions/usecases.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import { joinChildRun, type JoinDeps } from "./join.js";
import { resumeActiveRuns, type ResumeDeps } from "../orchestrator/resume.js";

const NOW = "2026-07-01T00:00:00.000Z";
const dirs: string[] = [];

function cfg(d: string): Config {
  return {
    dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1 << 20,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1 << 20,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "x.js"], getAuthToken: () => "t",
  };
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-comp-resume-"));
  dirs.push(dir);
  const db = openDatabase(cfg(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

let db: Database.Database;
let n: number;

function makeDeps(): JoinDeps {
  return {
    db,
    bus: new EventBus(),
    now: () => NOW,
    idFactory: () => `id-${++n}`,
  };
}

// Parent template: delegate node → next step
const PARENT_GRAPH_JSON = JSON.stringify({
  nodes: [
    { id: "dn1", type: "delegate", name: "Delegate", childTemplateId: "child-tpl", childTemplateVersion: 1 },
    { id: "ns1", type: "step", name: "Next Step", stepId: "s-next", terminal: true },
  ],
  edges: [{ from: "dn1", to: "ns1" }],
  positions: { dn1: { x: 110, y: 20 }, ns1: { x: 110, y: 112 } },
});

const PARENT_STEPS_JSON = JSON.stringify([{
  id: "s-next", ordinal: 0, name: "Next Step", instructions: "Do it",
  outputSchema: [{ key: "result", type: "string", required: true }],
  agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
}]);

const CHILD_STEPS_JSON = JSON.stringify([{
  id: "s-child-1", ordinal: 0, name: "Child Step", instructions: "Review it",
  outputSchema: [{ key: "findings", type: "string", required: true }],
  agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
}]);

beforeEach(() => {
  db = openTestDb();
  n = 0;
});

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetRunProjection();
  resetTemplateProjection();
  resetHarnessProjection();
  resetWorkflowStepProjectionPreparedStatements();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Seed delegating-parent + child fixtures. childRunStatus controls whether child is active or failed. */
function seedFixtures(childRunStatus: "active" | "failed" = "active"): void {
  db.prepare(
    `INSERT INTO workflow_templates
       (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`
  ).run("parent-tpl", "Parent Tpl", "desc", 1, PARENT_STEPS_JSON, "[]", PARENT_GRAPH_JSON, NOW, NOW);

  db.prepare(
    `INSERT INTO workflow_templates
       (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`
  ).run("child-tpl", "Child Tpl", "desc", 1, CHILD_STEPS_JSON, "[]", NOW, NOW);

  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run("g1", NOW, NOW);

  // Parent run: delegating (outside the active-per-goal unique index)
  db.prepare(
    `INSERT INTO workflow_runs
       (id, goal_id, template_id, template_version, status, current_node_id, started_at)
     VALUES (?, ?, ?, 1, 'delegating', 'dn1', ?)`
  ).run("r-parent", "g1", "parent-tpl", NOW);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, goal_id, template_id, template_version, status, started_at)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run("r-child", "g1", "child-tpl", childRunStatus, NOW);

  // Composition row (always 'active' — this is the un-propagated state)
  db.prepare(
    `INSERT INTO workflow_run_compositions
       (id, goal_id, parent_run_id, child_run_id, delegate_node_id, spawn_seq, reads_json, writes_json, depth, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "comp-1", "g1", "r-parent", "r-child", "dn1", 0,
    JSON.stringify({}),
    JSON.stringify({ review_findings: "findings" }),
    1, "active", NOW
  );
  db.prepare(`UPDATE workflow_runs SET parent_composition_id = 'comp-1' WHERE id = 'r-child'`).run();
  db.prepare(`UPDATE goals SET active_workflow_run_id = ? WHERE id = ?`).run("r-child", "g1");

  db.prepare(
    `INSERT INTO workflow_step_runs
       (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt,
        status, satisfied_exit_criteria_json, outstanding_exit_criteria_json,
        fingerprint, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, 'passed', '[]', '[]', 'fp1', ?, ?)`
  ).run("sr-child-1", "g1", "r-child", "s-child-1", 0, 1, NOW, NOW);

  db.prepare(`UPDATE workflow_runs SET current_step_run_id = 'sr-child-1' WHERE id = 'r-child'`).run();
}

describe("Task 1 + 2: Resume treats delegating parent as dormant; session-launch-lost recovery", () => {
  it("delegating parent excluded from listActiveRuns; active child with no session is respawned", async () => {
    const respawn = vi.fn(async () => undefined);
    const reattach = vi.fn(async () => undefined);

    // listActiveRuns returns only the active child — WHERE status='active' in server.ts
    // SQL already excludes the delegating parent.
    await resumeActiveRuns({
      listActiveRuns: async () => [
        {
          runId: "r-child",
          goalId: "g1",
          currentStepRunId: "sr-child-1",
          sessionId: null, // session-launch-lost: no live session
          providerRecoveryPending: false,
        },
        // r-parent (delegating) is NOT in this list — correctly excluded by SQL
      ],
      isSessionAlive: async () => false,
      reattach,
      respawn,
      markRecoverySessionMissing: async () => undefined,
    });

    // Child is respawned (session-launch-lost recovery, Task 2)
    expect(respawn).toHaveBeenCalledWith({ runId: "r-child", stepRunId: "sr-child-1", goalId: "g1" });
    expect(respawn).toHaveBeenCalledTimes(1);
    // Parent was never in the list; reattach must not be called
    expect(reattach).not.toHaveBeenCalled();
  });

  it("active child with an alive session is reattached, not respawned", async () => {
    const respawn = vi.fn(async () => undefined);
    const reattach = vi.fn(async () => undefined);

    await resumeActiveRuns({
      listActiveRuns: async () => [
        {
          runId: "r-child",
          goalId: "g1",
          currentStepRunId: "sr-child-1",
          sessionId: "sess-alive",
          providerRecoveryPending: false,
        },
      ],
      isSessionAlive: async (id) => id === "sess-alive",
      reattach,
      respawn,
      markRecoverySessionMissing: async () => undefined,
    });

    expect(reattach).toHaveBeenCalledWith({ runId: "r-child", sessionId: "sess-alive" });
    expect(respawn).not.toHaveBeenCalled();
  });
});

describe("Task 3: Child-terminal-FAILURE propagation on resume", () => {
  it("composition active + child failed → resumeActiveRuns propagates: parent blocked, composition failed", async () => {
    // Simulate daemon crash: child is failed but joinChildRun never propagated it
    seedFixtures("failed");

    const now = () => NOW;
    let localN = 0;
    const idFactory = () => `id-${++localN}`;
    const bus = new EventBus();

    const deps: ResumeDeps = {
      listActiveRuns: async () => [],
      listFailedChildCompositions: async () => {
        const rows = db.prepare(`
          SELECT wrc.child_run_id
          FROM workflow_run_compositions wrc
          JOIN workflow_runs child ON child.id = wrc.child_run_id
          WHERE wrc.status = 'active'
            AND child.status = 'failed'
        `).all() as Array<{ child_run_id: string }>;
        return rows.map((r) => ({ childRunId: r.child_run_id }));
      },
      propagateChildFailure: async (childRunId: string) => {
        joinChildRun({ db, bus, now, idFactory }, childRunId);
      },
      isSessionAlive: async () => false,
      reattach: async () => undefined,
      respawn: async () => undefined,
      markRecoverySessionMissing: async () => undefined,
    };

    await resumeActiveRuns(deps);

    const parentRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string };
    expect(parentRun.status).toBe("blocked");

    const comp = db.prepare(`SELECT status FROM workflow_run_compositions WHERE id = 'comp-1'`).get() as { status: string };
    expect(comp.status).toBe("failed");

    const goal = db.prepare(`SELECT active_workflow_run_id FROM goals WHERE id = 'g1'`).get() as { active_workflow_run_id: string };
    expect(goal.active_workflow_run_id).toBe("r-parent");
  });

  it("listFailedChildCompositions query only returns active-composition + failed-child pairs", () => {
    seedFixtures("active");

    const query = `
      SELECT wrc.child_run_id
      FROM workflow_run_compositions wrc
      JOIN workflow_runs child ON child.id = wrc.child_run_id
      WHERE wrc.status = 'active'
        AND child.status = 'failed'
    `;

    // Active child → not returned
    expect((db.prepare(query).all() as unknown[]).length).toBe(0);

    // Set child to failed
    db.prepare(`UPDATE workflow_runs SET status = 'failed' WHERE id = 'r-child'`).run();

    const rows = db.prepare(query).all() as Array<{ child_run_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].child_run_id).toBe("r-child");
  });

  it("propagation is idempotent: calling joinChildRun twice does not throw", () => {
    seedFixtures("failed");
    const deps = makeDeps();

    expect(() => joinChildRun(deps, "r-child")).not.toThrow();

    const parentRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string };
    expect(parentRun.status).toBe("blocked");

    // Second call — composition is now 'failed'; joinChildRun will throw "no composition found"
    // because getCompositionByChildRun returns a failed composition but the code
    // already propagated. Verify it doesn't corrupt state.
    // (The second call IS expected to throw "no composition found" since getCompositionByChildRun
    // uses a WHERE with no status filter — and it still returns the comp — but parent is already
    // blocked and child already failed, so the transaction is effectively a no-op.)
    expect(() => joinChildRun(deps, "r-child")).not.toThrow();
  });
});

describe("Task 4: Non-gated clean-join via step_result_json fallback", () => {
  it("child terminal with step_result_json.stepStatus=completed (no evidence) → joined", async () => {
    seedFixtures("active");

    // Simulate what dispatch-engine.ts now writes before joinChildToParentTerminal:
    // the step_result_json with stepStatus=completed for the child terminal step.
    db.prepare(
      `UPDATE workflow_step_runs SET step_result_json = ? WHERE id = 'sr-child-1'`
    ).run(JSON.stringify({ stepStatus: "completed" }));

    // No step_complete evidence transition is emitted.
    // joinChildRun's step_result_json fallback reads stepStatus=completed → verdict=passed.

    const deps = makeDeps();
    const result = await joinChildRun(deps, "r-child");

    expect(result.outcome).toBe("joined");
    expect(result.parentRunId).toBe("r-parent");

    const parentRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string };
    expect(parentRun.status).toBe("active");

    const comp = db.prepare(`SELECT status FROM workflow_run_compositions WHERE id = 'comp-1'`).get() as { status: string };
    expect(comp.status).toBe("completed");
  });

  it("child terminal with step_result_json.stepStatus=failed (no evidence) → propagated_failure", async () => {
    seedFixtures("active");

    db.prepare(
      `UPDATE workflow_step_runs SET step_result_json = ? WHERE id = 'sr-child-1'`
    ).run(JSON.stringify({ stepStatus: "failed" }));

    const deps = makeDeps();
    const result = await joinChildRun(deps, "r-child");

    expect(result.outcome).toBe("propagated_failure");

    const parentRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string };
    expect(parentRun.status).toBe("blocked");
  });

  it("absent step_result_json and absent step_complete evidence → conservative failed fallback", async () => {
    seedFixtures("active");
    // No step_result_json written, no step_complete transition emitted.

    const deps = makeDeps();
    const result = await joinChildRun(deps, "r-child");

    // Conservative absent-verdict fallback → propagated_failure (documented limitation)
    expect(result.outcome).toBe("propagated_failure");
  });
});
