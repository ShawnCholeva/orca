import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { DomainEvent } from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

function setup(): { db: Database.Database; ctx: WorkflowTemplateUsecaseCtx; events: DomainEvent[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-template-uc-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const events: DomainEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => {
    events.push(event);
  });
  let nextId = 0;
  return {
    db,
    events,
    ctx: {
      db,
      bus,
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
        instructions: "Do the work for this step.",
        outputSchema: [{ key: "summary", type: "string", required: true }],
        agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
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
          instructions: "Ask user input.",
          outputSchema: [{ key: "summary", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        },
      ],
      guardrails: [],
      scope: "global",
      scopeName: "",
      graph: null,
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
          instructions: "Ask user input.",
          outputSchema: [{ key: "summary", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        },
      ],
      guardrails: [],
      scope: "global",
      scopeName: "",
      graph: null,
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
            instructions: "Ask user input.",
            outputSchema: [{ key: "summary", type: "string", required: true }],
            agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
          },
        ],
        guardrails: [],
        scope: "global",
        scopeName: "",
        graph: null,
      })
    ).toThrow(WorkflowTemplateLockedError);
    expect(getTemplateById(db, "orca/engineering")?.version).toBe(1);
  });

  it("createCustomTemplate persists scope, scopeName, graph", () => {
    const { ctx } = setup();
    const graph = {
      nodes: [{ id: "n1", type: "step" as const, name: "Step 1", stepId: "intake" }],
      edges: [{ from: "n1", to: "n1" }],
      positions: { n1: { x: 0, y: 0 } },
    };

    const created = createCustomTemplate(ctx, {
      name: "Scoped Template",
      description: "desc",
      steps: [
        {
          id: "intake",
          name: "Intake",
          instructions: "Ask user input.",
          outputSchema: [{ key: "summary", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        },
      ],
      guardrails: [],
      scope: "workspace",
      scopeName: "my-workspace",
      graph,
    });

    expect(created.scope).toBe("workspace");
    expect(created.scopeName).toBe("my-workspace");
    expect(created.graph).toEqual(graph);
  });

  it("updateCustomTemplate changes scope, scopeName, graph", () => {
    const { ctx } = setup();

    const created = createCustomTemplate(ctx, {
      name: "Template",
      description: "desc",
      steps: [
        {
          id: "intake",
          name: "Intake",
          instructions: "Ask user input.",
          outputSchema: [{ key: "summary", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        },
      ],
      guardrails: [],
      scope: "global",
      scopeName: "",
      graph: null,
    });

    const graph = {
      nodes: [{ id: "n1", type: "step" as const, name: "Step 1", stepId: "intake" }],
      edges: [] as { from: string; to: string }[],
      positions: { n1: { x: 5, y: 5 } },
    };

    const updated = updateCustomTemplate(ctx, created.id, {
      name: "Template",
      description: "desc",
      steps: [
        {
          id: "intake",
          name: "Intake",
          instructions: "Ask user input.",
          outputSchema: [{ key: "summary", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        },
      ],
      guardrails: [],
      scope: "goal",
      scopeName: "goal-123",
      graph,
    });

    expect(updated.scope).toBe("goal");
    expect(updated.scopeName).toBe("goal-123");
    expect(updated.graph).toEqual(graph);
  });

  it("duplicateTemplate copies scope, scopeName, graph from source", () => {
    const { ctx } = setup();
    const graph = {
      nodes: [{ id: "n1", type: "step" as const, name: "Step 1", stepId: "intake" }],
      edges: [] as { from: string; to: string }[],
      positions: { n1: { x: 1, y: 2 } },
    };

    const source = createCustomTemplate(ctx, {
      name: "Source",
      description: "desc",
      steps: [
        {
          id: "intake",
          name: "Intake",
          instructions: "Ask user input.",
          outputSchema: [{ key: "summary", type: "string", required: true }],
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
        },
      ],
      guardrails: [],
      scope: "workspace",
      scopeName: "ws-abc",
      graph,
    });

    const duped = duplicateTemplate(ctx, {
      sourceTemplateId: source.id,
      name: "Source Copy",
    });

    expect(duped.scope).toBe("workspace");
    expect(duped.scopeName).toBe("ws-abc");
    expect(duped.graph).toEqual(graph);
  });
});
