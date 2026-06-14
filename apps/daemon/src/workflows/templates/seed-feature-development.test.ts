import { describe, expect, it, beforeEach } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { runMigrations, defaultMigrationsDir } from "../../migrations.js";
import { WorkflowGraph, WorkflowStepOutputSchema, type WorkflowStepTemplate } from "@orca/contracts";
import { validateGraph, validateSchemaReferences } from "../graph/validate-graph.js";
import { seedFeatureDevelopmentTemplate, FEATURE_DEV_ID, FEATURE_DEV_VERSION, __TEST_ONLY__ } from "./seed-feature-development.js";

let db: Database.Database;
beforeEach(() => {
  db = new DatabaseCtor(":memory:");
  runMigrations(db, defaultMigrationsDir());
});

describe("feature development template", () => {
  it("seeds the template with a graph (idempotently)", () => {
    seedFeatureDevelopmentTemplate(db, () => "t");
    seedFeatureDevelopmentTemplate(db, () => "t"); // second call is a no-op at same version
    const row = db.prepare("SELECT version, is_built_in, graph_json FROM workflow_templates WHERE id = ?").get(FEATURE_DEV_ID) as { version: number; is_built_in: number; graph_json: string | null };
    expect(row.version).toBe(FEATURE_DEV_VERSION);
    expect(row.is_built_in).toBe(1);
    expect(row.graph_json).toBeTruthy();
    WorkflowGraph.parse(JSON.parse(row.graph_json!)); // persisted graph parses
  });

  it("authored graph passes the Phase-1 blocking validators", () => {
    const steps = __TEST_ONLY__.STEPS as WorkflowStepTemplate[];
    expect(validateGraph(__TEST_ONLY__.GRAPH, steps)).toEqual([]);
    expect(validateSchemaReferences(__TEST_ONLY__.GRAPH, steps)).toEqual([]);
  });

  it("every step's output schema is valid", () => {
    for (const step of __TEST_ONLY__.STEPS as WorkflowStepTemplate[]) {
      expect(() => WorkflowStepOutputSchema.parse(step.outputSchema)).not.toThrow();
    }
  });

  it("has exactly one terminal step and a gate with both ports", () => {
    const terminals = __TEST_ONLY__.GRAPH.nodes.filter((n) => n.type === "step" && n.terminal);
    expect(terminals.map((n) => n.id)).toEqual(["done"]);
    const gatePorts = __TEST_ONLY__.GRAPH.edges.filter((e) => e.from === "gate").map((e) => e.port).sort();
    expect(gatePorts).toEqual(["approved", "rejected"]);
  });
});
