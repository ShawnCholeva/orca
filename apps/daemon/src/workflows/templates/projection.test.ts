import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { getTemplateById, listTemplates, resetPreparedStatements } from "./projection.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-template-proj-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedTemplate(
  db: Database.Database,
  row: {
    id: string;
    name: string;
    isBuiltIn: boolean;
    isLocked: boolean;
    scope?: string;
    scopeName?: string;
    graphJson?: string | null;
  }
): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at, scope, scope_name, graph_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    row.id,
    row.name,
    "desc",
    1,
    row.isBuiltIn ? 1 : 0,
    row.isLocked ? 1 : 0,
    JSON.stringify([
      {
        id: "step-1",
        ordinal: 0,
        name: "Step 1",
        instructions: "Produce the goal brief.",
        outputSchema: [{ key: "goal_brief", type: "string", required: true }],
        agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
      },
    ]),
    JSON.stringify([]),
    NOW,
    NOW,
    row.scope ?? "global",
    row.scopeName ?? "",
    row.graphJson ?? null
  );
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow template projection", () => {
  it("getTemplateById returns a parsed template", () => {
    const db = setup();
    seedTemplate(db, {
      id: "custom/a",
      name: "Custom A",
      isBuiltIn: false,
      isLocked: false,
    });

    const template = getTemplateById(db, "custom/a");
    expect(template).not.toBeNull();
    expect(template?.id).toBe("custom/a");
    expect(template?.steps[0]?.id).toBe("step-1");
    expect(template?.isBuiltIn).toBe(false);
  });

  it("listTemplates orders built-in first then by name", () => {
    const db = setup();
    seedTemplate(db, { id: "custom/b", name: "Bravo", isBuiltIn: false, isLocked: false });
    seedTemplate(db, { id: "orca/engineering", name: "Engineering", isBuiltIn: true, isLocked: true });
    seedTemplate(db, { id: "custom/a", name: "Alpha", isBuiltIn: false, isLocked: false });

    const templates = listTemplates(db);
    expect(templates.map((t) => t.id)).toEqual([
      "orca/engineering",
      "custom/a",
      "custom/b",
    ]);
  });

  it("rowToTemplate maps scope, scopeName, and graph from row", () => {
    const db = setup();
    const graph = {
      nodes: [{ id: "n1", type: "step" as const, name: "Step 1", stepId: "intake" }],
      edges: [{ from: "n1", to: "n1" }],
      positions: { n1: { x: 10, y: 20 } },
    };
    seedTemplate(db, {
      id: "custom/scope-test",
      name: "Scope Test",
      isBuiltIn: false,
      isLocked: false,
      scope: "goal",
      scopeName: "my-goal",
      graphJson: JSON.stringify(graph),
    });

    const template = getTemplateById(db, "custom/scope-test");
    expect(template).not.toBeNull();
    expect(template?.scope).toBe("goal");
    expect(template?.scopeName).toBe("my-goal");
    expect(template?.graph).toEqual(graph);
  });

  it("rowToTemplate returns scope=global and graph=null for rows with defaults", () => {
    const db = setup();
    // Insert without the new columns (back-compat: only old columns)
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "custom/legacy",
      "Legacy",
      "desc",
      1,
      0,
      0,
      JSON.stringify([
        {
          id: "step-1",
          ordinal: 0,
          name: "Step 1",
          instructions: "Do something.",
          outputSchema: [{ key: "summary", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        },
      ]),
      JSON.stringify([]),
      NOW,
      NOW
    );

    const template = getTemplateById(db, "custom/legacy");
    expect(template).not.toBeNull();
    expect(template?.scope).toBe("global");
    expect(template?.scopeName).toBe("");
    expect(template?.graph).toBeNull();
  });
});
