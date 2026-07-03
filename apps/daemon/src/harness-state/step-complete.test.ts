import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { HarnessTransition, StateDepsFacet } from "@orca/contracts";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { insertWorkspaceEntity, linkGoalWorkspace } from "../workspaces/projection.js";
import { insertTransition } from "../harness-transitions/projection.js";
import { buildStepCompleteStateFacet } from "./step-complete.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeDatabase();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

function setupDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-step-complete-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  db.pragma("foreign_keys = OFF");
  return db;
}

const NOW = "2026-06-26T00:00:00.000Z";
const noFiles = () => [];

function seedWorkspace(db: Database.Database, id: string, goalId: string, p: string, attachedAt = NOW): void {
  insertWorkspaceEntity(db, { id, path: p, name: id, description: "", createdAt: NOW, updatedAt: NOW });
  linkGoalWorkspace(db, goalId, id, attachedAt);
}

/** The step's session — its workspace_id is the authoritative target workspace. */
function seedSession(db: Database.Database, id: string, goalId: string, workspaceId: string): void {
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at) VALUES (?, ?, ?, 'claude-code', 't', 'running', ?)"
  ).run(id, goalId, workspaceId, NOW);
}

/** Seed the step_launch transition that recorded the launch-time version snapshot. */
function seedLaunch(db: Database.Database, goalId: string, stepRunId: string, versionDeps: StateDepsFacet["version_deps"]): void {
  const t: HarnessTransition = {
    id: `tx-launch-${stepRunId}`,
    goalId,
    workflowRunId: "run1",
    workflowStepRunId: stepRunId,
    boundary: "step_launch",
    risk: null,
    evidence: null,
    stateDeps: {
      read_set: [],
      write_set: [],
      assumptions: [],
      version_deps: versionDeps,
      conflict_policy: "escalate",
      conflicts: [],
    },
    telemetry: null,
    createdAt: NOW,
  };
  insertTransition(db, t);
}

const input = (goalId: string, stepRunId: string) => ({
  goalId,
  sessionId: "s1",
  thisStepRunId: stepRunId,
  assumptions: [] as string[],
  conflictPolicy: "escalate" as const,
});

describe("buildStepCompleteStateFacet belief-divergence", () => {
  it("fires belief_divergence when the live workspace version moved since launch", () => {
    const db = setupDb();
    seedWorkspace(db, "ws1", "g1", "/repo");
    seedSession(db, "s1", "g1", "ws1");
    seedLaunch(db, "g1", "sr1", [{ ref: "ws1", observed_version: "main:false" }]);

    // Workspace got dirty during the step: live probe now reports main:true.
    const facet = buildStepCompleteStateFacet(db, input("g1", "sr1"), noFiles, () => ({ branch: "main", dirty: true, commitHash: null }));

    const div = facet.conflicts.find((c) => c.kind === "belief_divergence");
    expect(div?.refs).toContain("ws1");
  });

  it("does not fire belief_divergence when the live workspace version is unchanged since launch", () => {
    const db = setupDb();
    seedWorkspace(db, "ws1", "g1", "/repo");
    seedSession(db, "s1", "g1", "ws1");
    seedLaunch(db, "g1", "sr1", [{ ref: "ws1", observed_version: "main:false" }]);

    const facet = buildStepCompleteStateFacet(db, input("g1", "sr1"), noFiles, () => ({ branch: "main", dirty: false, commitHash: null }));

    expect(facet.conflicts.some((c) => c.kind === "belief_divergence")).toBe(false);
  });

  it("stays inert when no launch snapshot exists (cannot fabricate divergence)", () => {
    const db = setupDb();
    seedWorkspace(db, "ws1", "g1", "/repo");
    seedSession(db, "s1", "g1", "ws1");
    // No step_launch transition seeded.

    const facet = buildStepCompleteStateFacet(db, input("g1", "sr1"), noFiles, () => ({ branch: "main", dirty: true, commitHash: null }));

    expect(facet.conflicts.some((c) => c.kind === "belief_divergence")).toBe(false);
  });
});

describe("buildStepCompleteStateFacet workspace selection (2.3)", () => {
  it("records the completing session's workspace, not the goal's first-attached one", () => {
    const db = setupDb();
    // ws1 is attached first (the [0] workspace); ws2 attached later.
    seedWorkspace(db, "ws1", "g1", "/repo/one", "2026-06-26T00:00:00.000Z");
    seedWorkspace(db, "ws2", "g1", "/repo/two", "2026-06-26T01:00:00.000Z");
    // The step's session targets ws2 (the non-[0] workspace).
    seedSession(db, "s2", "g1", "ws2");

    const facet = buildStepCompleteStateFacet(
      db,
      { goalId: "g1", sessionId: "s2", thisStepRunId: "sr1", assumptions: [], conflictPolicy: "escalate" },
      noFiles,
      () => ({ branch: "feature", dirty: false, commitHash: null })
    );

    const wsEntry = facet.read_set.find((e) => e.kind === "workspace_version");
    expect(wsEntry?.ref).toBe("ws2");
    expect(facet.version_deps).toContainEqual({ ref: "ws2", observed_version: "feature:false" });
  });
});
