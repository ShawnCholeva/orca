import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { WorkflowStepTemplate } from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { getTemplateById, resetPreparedStatements } from "./projection.js";
import {
  ENGINEERING_ID,
  ENGINEERING_VERSION,
  seedEngineeringTemplate,
} from "./seed-engineering.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../../migrations");

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-seed-engineering-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("seedEngineeringTemplate", () => {
  it("inserts the built-in Engineering template on first run", () => {
    const db = setup();

    seedEngineeringTemplate(db, () => NOW);

    const template = getTemplateById(db, ENGINEERING_ID);
    expect(template).toBeTruthy();
    expect(template?.version).toBe(ENGINEERING_VERSION);
    expect(template?.isBuiltIn).toBe(true);
    expect(template?.isLocked).toBe(true);
    expect(template?.steps.map((step) => step.id)).toEqual([
      "intake",
      "research",
      "prd",
      "issue_breakdown",
      "execution",
      "qa",
      "review",
      "done",
    ]);
    expect(template?.guardrails).toHaveLength(5);
  });

  it("is a no-op when the same version already exists", () => {
    const db = setup();

    seedEngineeringTemplate(db, () => NOW);
    const createdAt = getTemplateById(db, ENGINEERING_ID)?.updatedAt;

    seedEngineeringTemplate(db, () => "2026-02-01T00:00:00.000Z");

    const template = getTemplateById(db, ENGINEERING_ID);
    expect(template?.version).toBe(ENGINEERING_VERSION);
    expect(template?.updatedAt).toBe(createdAt);
  });

  it("updates an older Engineering row to the current built-in version", () => {
    const db = setup();
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      ENGINEERING_ID,
      "Engineering",
      "old",
      ENGINEERING_VERSION - 1,
      0,
      0,
      JSON.stringify([
        {
          id: "old",
          ordinal: 0,
          name: "Old",
          instructions: "old placeholder",
          outputSchema: [{ key: "summary", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        },
      ]),
      JSON.stringify([]),
      NOW,
      NOW
    );

    seedEngineeringTemplate(db, () => "2026-03-01T00:00:00.000Z");

    const template = getTemplateById(db, ENGINEERING_ID);
    expect(template?.version).toBe(ENGINEERING_VERSION);
    expect(template?.isBuiltIn).toBe(true);
    expect(template?.isLocked).toBe(true);
    expect(template?.updatedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(template?.steps).toHaveLength(8);
    expect(template?.guardrails).toHaveLength(5);
  });

  it("seeds steps with only instructions + outputSchema", () => {
    const db = setup();
    seedEngineeringTemplate(db, () => "2026-05-27T00:00:00.000Z");
    const row = db.prepare("SELECT steps_json FROM workflow_templates WHERE id=?").get(ENGINEERING_ID) as { steps_json: string };
    const steps = JSON.parse(row.steps_json);
    for (const s of steps) expect(() => WorkflowStepTemplate.parse(s)).not.toThrow();
    const intake = steps.find((s: { id: string }) => s.id === "intake");
    expect(intake.instructions).toMatch(/interview/i);
    expect(intake.outputSchema.some((f: { key: string }) => f.key === "problem")).toBe(true);
  });
});

describe("engineering seed (production instructions)", () => {
  it("version is bumped to 5", () => {
    expect(ENGINEERING_VERSION).toBe(5);
  });

  it("all steps validate and have non-placeholder instructions + non-trivial schemas", () => {
    const db = new DatabaseCtor(":memory:");
    runMigrations(db, defaultMigrationsDir());
    seedEngineeringTemplate(db, () => "2026-05-27T00:00:00.000Z");
    const row = db.prepare("SELECT steps_json FROM workflow_templates WHERE id=?").get(ENGINEERING_ID) as { steps_json: string };
    const steps = JSON.parse(row.steps_json) as Array<{ id: string; name: string; instructions: string; outputSchema: unknown[] }>;
    for (const s of steps) {
      expect(() => WorkflowStepTemplate.parse(s)).not.toThrow();
      expect(s.instructions.length).toBeGreaterThan(80);
    }
    const exec = steps.find((s) => s.id === "execution")!;
    const keys = (exec.outputSchema as Array<{ key: string }>).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["changed_files", "validation", "summary", "blocked"]));
  });
});

it("engineering template seeds at v5 with Codex fallbacks per step", () => {
  expect(ENGINEERING_VERSION).toBe(5);
  const db = new DatabaseCtor(":memory:");
  runMigrations(db, MIG_DIR);
  seedEngineeringTemplate(db, () => "2026-05-28T00:00:00.000Z");
  const row = db.prepare("SELECT steps_json, guardrails_json FROM workflow_templates WHERE id='orca/engineering'").get() as { steps_json: string; guardrails_json: string };
  const steps = JSON.parse(row.steps_json) as Array<{ id: string; agentPreference: Array<{ adapterId: string; modelId: string }> }>;
  const intake = steps.find((s) => s.id === "intake")!;
  expect(intake.agentPreference[0]).toEqual({ adapterId: "claude-code", modelId: "claude-haiku-4-5" });
  expect(intake.agentPreference[1]).toEqual({ adapterId: "codex", modelId: "gpt-5.4-mini" });
  const research = steps.find((s) => s.id === "research")!;
  expect(research.agentPreference[0].modelId).toBe("claude-opus-4-7");
  expect(research.agentPreference[1]).toEqual({ adapterId: "codex", modelId: "gpt-5.5" });
  const execution = steps.find((s) => s.id === "execution")!;
  expect(execution.agentPreference[0].modelId).toBe("claude-sonnet-4-6");
  expect(execution.agentPreference[1]).toEqual({ adapterId: "codex", modelId: "gpt-5.3-codex" });
  const guards = JSON.parse(row.guardrails_json) as Array<{ id: string }>;
  expect(guards.find((g) => g.id === "approval_launch_agent")).toBeUndefined();
});
