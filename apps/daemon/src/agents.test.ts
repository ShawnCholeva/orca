import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { AgentReadinessReport } from "@orca/contracts";

import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import {
  AgentNotFoundError,
  hasConnectedAgents,
  listAgents,
  persistReadiness,
  seedAgents,
  setAgentConnected,
} from "./agents.js";

const tempDirs: string[] = [];

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
    getAuthToken: () => "test-token",
  };
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-agents-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agents", () => {
  it("seeds the built-in agent catalogue exactly once", () => {
    const db = setup();
    seedAgents(db);
    const first = listAgents(db);
    expect(first.length).toBe(2);
    const ids = first.map((a) => a.id).sort();
    expect(ids).toEqual(["claude-code", "codex"]);

    // Run seed again — count should not change.
    seedAgents(db);
    const second = listAgents(db);
    expect(second.length).toBe(first.length);
  });

  it("prunes obsolete agents that were seeded by prior releases", () => {
    const db = setup();
    seedAgents(db);
    // Simulate a leftover row from an older catalogue.
    db.prepare(
      `INSERT INTO agents (id, name, short_label, description, swatch, recommended, connected, sort_order, created_at, updated_at)
       VALUES (?, 'Cursor', 'Cursor · Editor', 'old', '#000', 0, 1, 99, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run("cursor");
    expect(listAgents(db).map((a) => a.id)).toContain("cursor");

    seedAgents(db);
    expect(listAgents(db).map((a) => a.id)).not.toContain("cursor");
  });

  it("marks claude-code and codex as recommended", () => {
    const db = setup();
    seedAgents(db);
    const agents = listAgents(db);
    const recommendedIds = agents.filter((a) => a.recommended).map((a) => a.id).sort();
    expect(recommendedIds).toEqual(["claude-code", "codex"]);
  });

  it("setAgentConnected toggles connected and preserves through reseed", () => {
    const db = setup();
    seedAgents(db);
    const before = listAgents(db).find((a) => a.id === "claude-code")!;
    expect(before.connected).toBe(false);

    const updated = setAgentConnected(db, "claude-code", true);
    expect(updated.connected).toBe(true);

    // Re-seed must not clobber user's `connected` choice.
    seedAgents(db);
    const after = listAgents(db).find((a) => a.id === "claude-code")!;
    expect(after.connected).toBe(true);
  });

  it("setAgentConnected throws AgentNotFoundError for unknown id", () => {
    const db = setup();
    seedAgents(db);
    expect(() => setAgentConnected(db, "nope", true)).toThrow(AgentNotFoundError);
  });

  it("hasConnectedAgents reflects current state", () => {
    const db = setup();
    seedAgents(db);
    expect(hasConnectedAgents(db)).toBe(false);
    setAgentConnected(db, "codex", true);
    expect(hasConnectedAgents(db)).toBe(true);
    setAgentConnected(db, "codex", false);
    expect(hasConnectedAgents(db)).toBe(false);
  });
});

describe("agents readiness columns", () => {
  function setup() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-agents-"));
    tempDirs.push(dir);
    const db = openDatabase(createConfig(dir));
    runMigrations(db, defaultMigrationsDir());
    seedAgents(db);
    return { db };
  }

  it("listAgents surfaces readiness as null when never checked", () => {
    const { db } = setup(); // setup helper used elsewhere in this file
    const agents = listAgents(db);
    for (const a of agents) {
      expect(a.readiness).toBeNull();
    }
  });

  it("persistReadiness writes and listAgents reads back the full report", () => {
    const { db } = setup();
    const report: AgentReadinessReport = {
      agentId: "claude-code",
      status: "ready",
      steps: [
        { name: "installed", ok: true, command: "claude --version" },
        { name: "authenticated", ok: true, authStatus: "ready", command: "claude auth status --json" },
      ],
      checkedAt: "2026-05-22T00:00:00.000Z",
      version: "1.2.3",
    };
    persistReadiness(db, report);
    const row = listAgents(db).find((a) => a.id === "claude-code")!;
    expect(row.readiness).toEqual(report);
  });

  it("persistReadiness overwrites a prior report", () => {
    const { db } = setup();
    persistReadiness(db, {
      agentId: "claude-code",
      status: "ready",
      steps: [{ name: "installed", ok: true, command: "claude --version" }],
      checkedAt: "2026-05-22T00:00:00.000Z",
    });
    persistReadiness(db, {
      agentId: "claude-code",
      status: "needs_auth",
      steps: [
        { name: "installed", ok: true, command: "claude --version" },
        { name: "authenticated", ok: false, authStatus: "needs_auth", command: "claude auth status --json" },
      ],
      repair: { kind: "run_command", command: "claude auth login", label: "Sign in to Claude Code" },
      checkedAt: "2026-05-22T00:01:00.000Z",
    });
    const row = listAgents(db).find((a) => a.id === "claude-code")!;
    expect(row.readiness?.status).toBe("needs_auth");
    expect(row.readiness?.repair?.command).toBe("claude auth login");
  });
});
