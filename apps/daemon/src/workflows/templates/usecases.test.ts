import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { DomainEvent } from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { getTemplateById, resetPreparedStatements as resetProjectionStatements } from "./projection.js";
import {
  createCustomTemplate,
  duplicateTemplate,
  updateCustomTemplate,
  WorkflowTemplateLockedError,
  type WorkflowTemplateUsecaseCtx,
} from "./usecases.js";

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

function setup(): { db: Database.Database; ctx: WorkflowTemplateUsecaseCtx; events: DomainEvent[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-template-uc-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const events: DomainEvent[] = [];
  let nextId = 0;
  return {
    db,
    events,
    ctx: {
      db,
      bus: {
        publish(event) {
          events.push(event);
        },
      },
      now: () => NOW,
      idFactory: () => `fixed-id-${++nextId}`,
    },
  };
}

function seedTemplate(db: Database.Database, id: string, isBuiltIn: boolean, isLocked: boolean): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    isBuiltIn ? "Engineering" : "Custom",
    "desc",
    1,
    isBuiltIn ? 1 : 0,
    isLocked ? 1 : 0,
    JSON.stringify([
      {
        id: "step-1",
        ordinal: 0,
        name: "Step 1",
        purpose: "Purpose",
        requiredInputs: [],
        requiredOutputs: ["goal_brief"],
        gateType: "human-input",
        recommendedCapabilities: [],
        validationExpectations: [],
        exitCriteria: ["done"],
        recommendedOperatorIds: [],
      },
    ]),
    JSON.stringify([]),
    NOW,
    NOW
  );
}

afterEach(() => {
  closeDatabase();
  resetProjectionStatements();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow template usecases", () => {
  it("create -> update (version bump) -> duplicate works and emits events", () => {
    const { db, ctx, events } = setup();

    const created = createCustomTemplate(ctx, {
      name: "New Template",
      description: "desc",
      steps: [
        {
          id: "intake",
          name: "Intake",
          purpose: "Ask user input",
          requiredInputs: [],
          requiredOutputs: ["goal_brief"],
          gateType: "human-input",
          recommendedCapabilities: [],
          validationExpectations: [],
          exitCriteria: ["brief captured"],
          recommendedOperatorIds: [],
        },
      ],
      guardrails: [],
    });
    expect(created.id.startsWith("custom/")).toBe(true);
    expect(created.version).toBe(1);
    expect(created.steps[0]?.ordinal).toBe(0);

    const updated = updateCustomTemplate(ctx, created.id, {
      name: "New Template v2",
      description: "desc2",
      steps: [
        {
          id: "intake",
          ordinal: 3,
          name: "Intake",
          purpose: "Ask user input",
          requiredInputs: [],
          requiredOutputs: ["goal_brief"],
          gateType: "human-input",
          recommendedCapabilities: [],
          validationExpectations: [],
          exitCriteria: ["brief captured"],
          recommendedOperatorIds: [],
        },
      ],
      guardrails: [],
    });
    expect(updated.version).toBe(2);
    expect(updated.steps[0]?.ordinal).toBe(3);

    seedTemplate(db, "orca/engineering", true, true);
    const duplicated = duplicateTemplate(ctx, {
      sourceTemplateId: "orca/engineering",
      name: "Engineering Copy",
    });
    expect(duplicated.id.startsWith("custom/")).toBe(true);
    expect(duplicated.isBuiltIn).toBe(false);
    expect(duplicated.isLocked).toBe(false);
    expect(duplicated.version).toBe(1);

    expect(events.map((event) => event.type)).toEqual([
      "workflow.template.created",
      "workflow.template.updated",
      "workflow.template.duplicated",
    ]);
  });

  it("update on built-in template is rejected", () => {
    const { db, ctx } = setup();
    seedTemplate(db, "orca/engineering", true, true);
    expect(() =>
      updateCustomTemplate(ctx, "orca/engineering", {
        name: "Nope",
        description: "nope",
        steps: [
          {
            id: "intake",
            name: "Intake",
            purpose: "Ask user input",
            requiredInputs: [],
            requiredOutputs: ["goal_brief"],
            gateType: "human-input",
            recommendedCapabilities: [],
            validationExpectations: [],
            exitCriteria: ["brief captured"],
            recommendedOperatorIds: [],
          },
        ],
        guardrails: [],
      })
    ).toThrow(WorkflowTemplateLockedError);
    expect(getTemplateById(db, "orca/engineering")?.version).toBe(1);
  });
});
