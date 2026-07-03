import { describe, expect, it, beforeEach } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import type { WorkflowTemplate } from "@orca/contracts";
import { runMigrations, defaultMigrationsDir } from "../../migrations.js";
import { EventBus } from "../../events.js";
import { installBuiltInTemplates } from "./usecases.js";
import { BUILTIN_TEMPLATE_CATALOG } from "./catalog.js";
import {
  validateGraph,
  validateSchemaReferences,
  validateDelegationAcyclic,
} from "../graph/validate-graph.js";

// The composed built-in dogfood pair: a parent that delegates to an
// independently-versioned child sub-workflow.
const PARENT_ID = "orca/scoped-delivery";
const CHILD_ID = "orca/scope-brief";

let db: Database.Database;
function ctx() {
  return { db, bus: new EventBus(), now: () => "2026-01-01T00:00:00.000Z" };
}
beforeEach(() => {
  db = new DatabaseCtor(":memory:");
  runMigrations(db, defaultMigrationsDir());
});

const catalogDef = (id: string) => BUILTIN_TEMPLATE_CATALOG.find((d) => d.id === id);

// Resolve a child from the catalog definition — which carries the typed `inputs`
// interface the cross-template validators check reads/writes against.
function resolveChild(id: string): WorkflowTemplate | null {
  const d = catalogDef(id);
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    version: d.version,
    isBuiltIn: true,
    isLocked: true,
    steps: d.steps,
    inputs: d.inputs ?? [],
    guardrails: d.guardrails,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scope: "global",
    scopeName: "",
    category: d.category,
    graph: d.graph,
  };
}

describe("composed built-in pair (workflow composition dogfood)", () => {
  it("(a) installs both the parent and the child from the catalog as built-in/locked rows", () => {
    const templates = installBuiltInTemplates(ctx(), [PARENT_ID, CHILD_ID]);
    expect(templates.map((t) => t.id).sort()).toEqual([CHILD_ID, PARENT_ID].sort());
    expect(templates.every((t) => t.isBuiltIn && t.isLocked)).toBe(true);
  });

  it("(b) the parent delegate node's reads/writes validate against the child's inputs and terminal outputs", () => {
    const parent = catalogDef(PARENT_ID)!;
    // reads keys ⊆ child.inputs, writes child-keys ⊆ child terminal outputSchema.
    expect(validateGraph(parent.graph!, parent.steps, { resolveChild })).toEqual([]);
    // the delegate reads each parent key from an upstream-produced output.
    expect(validateSchemaReferences(parent.graph!, parent.steps)).toEqual([]);
  });

  it("(c) the delegation is acyclic", () => {
    const parent = catalogDef(PARENT_ID)!;
    expect(
      validateDelegationAcyclic(resolveChild, { id: parent.id, graph: parent.graph })
    ).toEqual([]);
  });
});
