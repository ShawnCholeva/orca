import { describe, expect, it } from "vitest";
import { WorkflowGraph, WorkflowStepOutputSchema, type WorkflowStepTemplate } from "@orca/contracts";
import { validateGraph, validateSchemaReferences } from "../graph/validate-graph.js";
import { validateTemplatePipeline } from "./validate-pipeline.js";
import { BUILTIN_TEMPLATE_CATALOG, BUILTIN_TEMPLATE_IDS, builtInCatalogSummaries } from "./catalog.js";

const EXPECTED_IDS = [
  "orca/brainstorm",
  "orca/feature-development",
  "orca/bug-triage-fix",
  "orca/code-review",
  "orca/refactor",
  "orca/quality-coverage",
  "orca/initiative-implementation",
];

describe("built-in template catalog", () => {
  it("contains exactly the 7 expected ids, all orca/-prefixed and unique", () => {
    const ids = BUILTIN_TEMPLATE_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("orca/"))).toBe(true);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    expect([...BUILTIN_TEMPLATE_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("recommends exactly brainstorm, feature-development, bug-triage-fix", () => {
    const rec = BUILTIN_TEMPLATE_CATALOG.filter((d) => d.recommended).map((d) => d.id).sort();
    expect(rec).toEqual(["orca/brainstorm", "orca/bug-triage-fix", "orca/feature-development"]);
  });

  it("every definition has non-empty bestFor (<=200 chars) and category Engineering", () => {
    for (const d of BUILTIN_TEMPLATE_CATALOG) {
      expect(d.bestFor.length).toBeGreaterThan(0);
      expect(d.bestFor.length).toBeLessThanOrEqual(200);
      expect(d.category).toBe("Engineering");
    }
  });

  it("no template hard-pins an adapter via an allowed_operators guardrail", () => {
    for (const d of BUILTIN_TEMPLATE_CATALOG) {
      expect(d.guardrails.some((g) => g.kind === "allowed_operators")).toBe(false);
    }
  });

  it("every step output schema is valid and every graph passes the blocking validators", () => {
    for (const d of BUILTIN_TEMPLATE_CATALOG) {
      for (const step of d.steps as WorkflowStepTemplate[]) {
        expect(() => WorkflowStepOutputSchema.parse(step.outputSchema)).not.toThrow();
      }
      expect(validateTemplatePipeline(d.steps as WorkflowStepTemplate[])).toEqual([]);
      if (d.graph) {
        WorkflowGraph.parse(d.graph);
        expect(validateGraph(d.graph, d.steps as WorkflowStepTemplate[])).toEqual([]);
        expect(validateSchemaReferences(d.graph, d.steps as WorkflowStepTemplate[])).toEqual([]);
      }
    }
  });

  it("summaries derive stepCount from graph node count or step count", () => {
    const summaries = builtInCatalogSummaries();
    expect(summaries).toHaveLength(7);
    const byId = Object.fromEntries(summaries.map((s) => [s.id, s]));
    expect(byId["orca/feature-development"].stepCount).toBe(5); // 4 steps + gate
    expect(byId["orca/initiative-implementation"].stepCount).toBe(8); // 7 steps + gate
    expect(byId["orca/brainstorm"].stepCount).toBe(6); // linear
    expect(byId["orca/code-review"].stepCount).toBe(4);
  });

  it("every built-in graph has a terminal reachable from every node", () => {
    for (const d of BUILTIN_TEMPLATE_CATALOG) {
      expect(d.graph).not.toBeNull();
      const errors = validateGraph(d.graph!, d.steps as WorkflowStepTemplate[]);
      expect(errors).toEqual([]);
      expect(d.graph!.nodes.some((n) => n.type === "step" && n.terminal)).toBe(true);
    }
  });
});
