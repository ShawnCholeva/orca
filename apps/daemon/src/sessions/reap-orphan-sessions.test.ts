import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import type { TmuxRunner } from "../tmux/runner.js";
import { reapOrphanTmuxSessions, workerSessionIdsForRun } from "./reap-orphan-sessions.js";

const tempDirs: string[] = [];
const NOW = "2026-01-10T12:00:00.000Z";

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-reap-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedTemplate(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at) VALUES (?, 'T', 'd', 1, 1, 1, '[]', '[]', NULL, ?, ?)"
  ).run(id, NOW, NOW);
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, 'G', '', 'active', 1, ?, ?, null)"
  ).run(id, NOW, NOW);
  db.prepare(
    "INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, 'ws', '', ?, ?)"
  ).run(`ws-${id}`, `/tmp/${id}`, NOW, NOW);
  db.prepare("INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)").run(id, `ws-${id}`, NOW);
}

function seedRun(db: Database.Database, id: string, goalId: string, status: string): void {
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?, ?, 'tpl', 1, ?, ?)"
  ).run(id, goalId, status, NOW);
}

function seedStepRun(db: Database.Database, id: string, runId: string, goalId: string): void {
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, status, fingerprint) VALUES (?, ?, ?, 'step', 0, 'active', 'fp')"
  ).run(id, goalId, runId);
}

function seedSession(
  db: Database.Database,
  id: string,
  goalId: string,
  status: string,
  stepRunId: string | null
): void {
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, workflow_step_run_id, created_at) VALUES (?, ?, ?, 'claude-code', 'S', ?, ?, ?)"
  ).run(id, goalId, `ws-${goalId}`, status, stepRunId, NOW);
}

const OWNER = "/data/orca";

// `owners` says which data dir each session was created for; a name absent
// from it is untagged (predates the tag, or was created by hand).
function fakeTmux(sessionNames: string[], owners: Record<string, string> = Object.fromEntries(sessionNames.map((n) => [n, OWNER]))): TmuxRunner & { killed: string[] } {
  const killed: string[] = [];
  return {
    killed,
    run: async (args: string[]) => {
      if (args[0] === "list-sessions") return { stdout: sessionNames.join("\n") + "\n", stderr: "", code: 0 };
      if (args[0] === "kill-session") { killed.push(args[2]); return { stdout: "", stderr: "", code: 0 }; }
      if (args[0] === "show-environment") {
        const o = owners[args[2]];
        return o === undefined ? { stdout: "-ORCA_OWNER\n", stderr: "", code: 0 } : { stdout: `ORCA_OWNER=${o}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  } as TmuxRunner & { killed: string[] };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reapOrphanTmuxSessions", () => {
  it("reaps orphaned worker + shadow sessions but keeps those of active runs/goals", async () => {
    const db = freshDb();
    seedTemplate(db, "tpl");
    seedGoal(db, "g-active");
    seedGoal(db, "g-done");
    // Active run for g-active with a live worker session → keep.
    seedRun(db, "run-active", "g-active", "active");
    seedStepRun(db, "sr-active", "run-active", "g-active");
    seedSession(db, "sess-active", "g-active", "running", "sr-active");
    // Completed run for g-done whose worker session row is still marked running → reap.
    seedRun(db, "run-done", "g-done", "completed");
    seedStepRun(db, "sr-done", "run-done", "g-done");
    seedSession(db, "sess-done", "g-done", "running", "sr-done");

    const tmux = fakeTmux([
      "orca-worker-sess-active", // keep — session of an active run
      "orca-worker-sess-done", // reap — run completed
      "orca-worker-ghost", // reap — no session row at all
      "orca-shadow-g-active", // keep — goal has an active run
      "orca-shadow-g-active__refute", // keep
      "orca-shadow-g-done", // reap — no active run
      "orca-shadow-g-done__refute", // reap
      "some-unrelated-session", // ignore — not an orca session
    ]);

    const reaped = await reapOrphanTmuxSessions(tmux, db, OWNER);

    expect([...reaped].sort()).toEqual([
      "orca-shadow-g-done",
      "orca-shadow-g-done__refute",
      "orca-worker-ghost",
      "orca-worker-sess-done",
    ]);
    expect([...tmux.killed].sort()).toEqual([...reaped].sort());
    expect(tmux.killed).not.toContain("some-unrelated-session");
    expect(tmux.killed).not.toContain("orca-worker-sess-active");
    expect(tmux.killed).not.toContain("orca-shadow-g-active");
  });

  it("never kills a session owned by another daemon, or an untagged one", async () => {
    // A test that boots startDaemon() against a temp data dir runs this reaper
    // with an empty database: everything on the shared tmux server looks
    // orphaned to it. It killed every live worker on the developer's machine,
    // twice per suite run, and every one of those deaths was recorded as a
    // crash against the agent.
    const db = freshDb();
    const tmux = fakeTmux(
      ["orca-worker-real-1", "orca-shadow-goal-real", "orca-worker-old-untagged", "orca-worker-mine"],
      { "orca-worker-real-1": "/Users/dev/.orca", "orca-shadow-goal-real": "/Users/dev/.orca", "orca-worker-mine": OWNER },
    );
    const reaped = await reapOrphanTmuxSessions(tmux, db, OWNER);
    expect(reaped).toEqual(["orca-worker-mine"]);
    expect(tmux.killed).toEqual(["orca-worker-mine"]);
  });

  it("reaps nothing when there are no orca tmux sessions", async () => {
    const db = freshDb();
    const tmux = fakeTmux(["random-shell", "vim"]);
    expect(await reapOrphanTmuxSessions(tmux, db, OWNER)).toEqual([]);
    expect(tmux.killed).toEqual([]);
  });
});

describe("reapOrphanTmuxSessions — freshly-spawned workers", () => {
  it("keeps a worker still at 'created', the status it holds for the whole of spawn()", async () => {
    // The live defect: sessions INSERT as 'created' and only reach 'running'
    // after markRunning, which spawn() calls AFTER newSession/pipePane/startTail.
    // The old allow-list ('running','starting') therefore reaped a healthy
    // worker mid-turn if a boot reap landed inside that window — the worker died
    // with no exit code or signal and the run blocked as worker_exited_no_signal.
    const db = freshDb();
    seedTemplate(db, "tpl");
    seedGoal(db, "g1");
    seedRun(db, "run1", "g1", "active");
    seedStepRun(db, "sr1", "run1", "g1");
    seedSession(db, "sess-created", "g1", "created", "sr1");

    const killed: string[] = [];
    const tmux: TmuxRunner = {
      run: async (args) => {
        if (args[0] === "list-sessions") return { stdout: "orca-worker-sess-created\n", stderr: "", code: 0 };
        if (args[0] === "kill-session") killed.push(args[2]);
        return { stdout: "", stderr: "", code: 0 };
      },
    };

    expect(await reapOrphanTmuxSessions(tmux, db, OWNER)).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("still reaps a worker whose session reached a terminal status", async () => {
    const db = freshDb();
    seedTemplate(db, "tpl");
    seedGoal(db, "g1");
    seedRun(db, "run1", "g1", "active");
    seedStepRun(db, "sr1", "run1", "g1");
    seedSession(db, "sess-failed", "g1", "failed", "sr1");

    const killed: string[] = [];
    const tmux: TmuxRunner = {
      run: async (args) => {
        if (args[0] === "list-sessions") return { stdout: "orca-worker-sess-failed\n", stderr: "", code: 0 };
        if (args[0] === "show-environment") return { stdout: `ORCA_OWNER=${OWNER}\n`, stderr: "", code: 0 };
        if (args[0] === "kill-session") killed.push(args[2]);
        return { stdout: "", stderr: "", code: 0 };
      },
    };

    expect(await reapOrphanTmuxSessions(tmux, db, OWNER)).toEqual(["orca-worker-sess-failed"]);
    expect(killed).toEqual(["orca-worker-sess-failed"]);
  });
});

describe("workerSessionIdsForRun", () => {
  it("returns only the run's still-running worker sessions", async () => {
    const db = freshDb();
    seedTemplate(db, "tpl");
    seedGoal(db, "g1");
    seedRun(db, "run1", "g1", "cancelled");
    seedStepRun(db, "sr1", "run1", "g1");
    seedSession(db, "sess-running", "g1", "running", "sr1");
    seedSession(db, "sess-starting", "g1", "starting", "sr1");
    seedSession(db, "sess-exited", "g1", "exited", "sr1"); // already gone → excluded
    seedSession(db, "sess-nostep", "g1", "running", null); // not a step session → excluded

    expect(workerSessionIdsForRun(db, "run1").sort()).toEqual(["sess-running", "sess-starting"]);
  });

  it("includes a worker still at 'created' so a blocked run's leaked pane is torn down", async () => {
    // Twin of the keep-set defect, opposite direction: this teardown could not
    // see a worker mid-spawn, so a run that blocked while one was starting left
    // its tmux pane running forever.
    const db = freshDb();
    seedTemplate(db, "tpl");
    seedGoal(db, "g1");
    seedRun(db, "run1", "g1", "blocked");
    seedStepRun(db, "sr1", "run1", "g1");
    seedSession(db, "sess-created", "g1", "created", "sr1");
    seedSession(db, "sess-exited", "g1", "exited", "sr1");

    expect(workerSessionIdsForRun(db, "run1")).toEqual(["sess-created"]);
  });
});
