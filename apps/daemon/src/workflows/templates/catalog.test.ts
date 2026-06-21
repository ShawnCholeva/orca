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

describe("Brainstorm participatory revision", () => {
  const brainstorm = BUILTIN_TEMPLATE_CATALOG.find((d) => d.id === "orca/brainstorm")!;
  const step = (id: string) => brainstorm.steps.find((s) => s.id === id)!;

  it("bumps the template version to 3", () => {
    expect(brainstorm.version).toBe(3);
  });

  it("assigns the expected completion policies", () => {
    expect(step("frame").completionPolicy).toBe("interview");
    expect(step("research").completionPolicy).toBe("reasoning");
    expect(step("proposal").completionPolicy).toBe("reasoning");
    expect(step("critique").completionPolicy).toBe("reasoning");
    expect(step("verify").completionPolicy).toBe("reasoning");
    expect(step("done").completionPolicy).toBe("handoff");
  });

  it("frames relentlessly and requires confirmation before completing", () => {
    expect(step("frame").instructions).toMatch(/relentlessly/i);
    expect(step("frame").instructions).toMatch(/confirm/i);
    expect(step("frame").instructions).toMatch(/do not analyze the code technically/i);
  });

  it("tells reasoning steps to pause at a material fork", () => {
    for (const id of ["research", "proposal", "critique", "verify"]) {
      expect(step(id).instructions).toMatch(/pause and ask/i);
    }
  });

  it("critiques the chosen approach, not the recommendation", () => {
    expect(step("critique").instructions).toMatch(/approach the user chose/i);
  });

  it("requires Proposal to capture chosen_approach", () => {
    const field = step("proposal").outputSchema.find((f) => f.key === "chosen_approach");
    expect(field).toMatchObject({ key: "chosen_approach", type: "string", required: true });
  });

  it("gives Done an artifacts field and a save-to-disk instruction", () => {
    const field = step("done").outputSchema.find((f) => f.key === "artifacts");
    expect(field?.type).toBe("array");
    expect(step("done").instructions).toMatch(/\.orca\/specs/);
    expect(step("done").instructions).toMatch(/do not finish silently/i);
  });

  it("Frame step no longer instructs the agent to ask the user to confirm", () => {
    const brainstorm = BUILTIN_TEMPLATE_CATALOG.find((t) => t.id === "orca/brainstorm")!;
    const frame = brainstorm.steps.find((s) => s.id === "frame")!;
    expect(frame.completionPolicy).toBe("interview");
    expect(frame.instructions).not.toMatch(/ask the user to confirm/i);
    expect(frame.instructions).toMatch(/complete/i);
  });
});

describe("Bug Triage & Fix systematic debugging (Four Phases)", () => {
  const bugfix = BUILTIN_TEMPLATE_CATALOG.find((d) => d.id === "orca/bug-triage-fix")!;
  const step = (id: string) => bugfix.steps.find((s) => s.id === id)!;

  it("bumps the template version to 4", () => {
    expect(bugfix.version).toBe(4);
  });

  it("names its steps after the four phases plus Done", () => {
    expect(bugfix.steps.map((s) => s.id)).toEqual([
      "root_cause",
      "pattern_analysis",
      "hypothesis",
      "implementation",
      "done",
    ]);
    expect(step("root_cause").name).toBe("Root Cause Investigation");
    expect(step("pattern_analysis").name).toBe("Pattern Analysis");
    expect(step("hypothesis").name).toBe("Hypothesis & Testing");
    expect(step("implementation").name).toBe("Implementation");
  });

  it("assigns the expected completion policies", () => {
    expect(step("root_cause").completionPolicy).toBe("interview");
    expect(step("pattern_analysis").completionPolicy).toBe("reasoning");
    expect(step("hypothesis").completionPolicy).toBe("reasoning");
    expect(step("implementation").completionPolicy).toBe("reasoning");
    expect(step("done").completionPolicy).toBe("handoff");
  });

  it("makes Phase 1 an interview that reproduces, enforces the Iron Law, and confirms on the card", () => {
    const ins = step("root_cause").instructions;
    expect(ins).toMatch(/reproduce/i);
    expect(ins).toMatch(/no fix|do not .*fix/i);
    expect(ins).toMatch(/empty open_questions list/i);
    expect(ins).toMatch(/completion card/i);
    const field = step("root_cause").outputSchema.find((f) => f.key === "open_questions");
    expect(field).toMatchObject({ key: "open_questions", type: "array", required: false });
  });

  it("requires Pattern Analysis to compare against working examples", () => {
    expect(step("pattern_analysis").instructions).toMatch(/working example/i);
    const keys = step("pattern_analysis").outputSchema.map((f) => f.key);
    expect(keys).toContain("working_examples");
    expect(keys).toContain("differences");
  });

  it("requires a single hypothesis and a failing test in Phase 3", () => {
    expect(step("hypothesis").instructions).toMatch(/single[^.]*hypothesis|one hypothesis/i);
    const keys = step("hypothesis").outputSchema.map((f) => f.key);
    expect(keys).toContain("hypothesis");
    expect(keys).toContain("failing_test");
  });

  it("tells reasoning steps to pause at a material fork", () => {
    for (const id of ["pattern_analysis", "hypothesis", "implementation"]) {
      expect(step(id).instructions).toMatch(/pause and ask/i);
    }
  });

  it("routes a failed verdict gate back to Root Cause Investigation", () => {
    const graph = bugfix.graph!;
    const verdict = graph.nodes.find((n) => n.type === "gate");
    expect(verdict?.id).toBe("verdict");
    const approved = graph.edges.find((e) => e.from === "verdict" && e.port === "approved");
    const rejected = graph.edges.find((e) => e.from === "verdict" && e.port === "rejected");
    expect(approved?.to).toBe("done");
    expect(rejected?.to).toBe("root_cause");
  });

  it("wires the validation guardrail to the renamed implementation step", () => {
    const rule = bugfix.guardrails?.find((g) => g.kind === "validation_rule");
    expect((rule?.configJson as { appliesToSteps?: string[] })?.appliesToSteps).toEqual([
      "implementation",
    ]);
  });

  it("gives Done a handoff that self-reviews and does not finish silently", () => {
    const field = step("done").outputSchema.find((f) => f.key === "open_questions");
    expect(field?.type).toBe("array");
    expect(step("done").instructions).toMatch(/self-review/i);
    expect(step("done").instructions).toMatch(/do not finish silently/i);
  });
});
