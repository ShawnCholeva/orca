import { describe, expect, it } from "vitest";
import { WorkflowGraph, WorkflowStepOutputSchema, type WorkflowStepTemplate } from "@orca/contracts";
import { validateGraph, validateSchemaReferences } from "../graph/validate-graph.js";
import { resolveSplitterNext, resolveStepNext } from "../graph/graph-routing.js";
import { validateTemplatePipeline } from "./validate-pipeline.js";
import { BUILTIN_TEMPLATE_CATALOG, BUILTIN_TEMPLATE_IDS, builtInCatalogSummaries } from "./catalog.js";

const EXPECTED_IDS = [
  "orca/adaptive-delivery",
  "orca/bug-triage-fix",
  "orca/code-review",
  "orca/refactor",
  "orca/quality-coverage",
];

describe("built-in template catalog", () => {
  it("contains exactly the 5 expected ids, all orca/-prefixed and unique", () => {
    const ids = BUILTIN_TEMPLATE_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("orca/"))).toBe(true);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    expect([...BUILTIN_TEMPLATE_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("recommends exactly adaptive-delivery and bug-triage-fix", () => {
    const rec = BUILTIN_TEMPLATE_CATALOG.filter((d) => d.recommended).map((d) => d.id).sort();
    expect(rec).toEqual(["orca/adaptive-delivery", "orca/bug-triage-fix"]);
  });

  it("every definition has non-empty bestFor (<=200 chars) and category Engineering", () => {
    for (const d of BUILTIN_TEMPLATE_CATALOG) {
      expect(d.bestFor.length).toBeGreaterThan(0);
      expect(d.bestFor.length).toBeLessThanOrEqual(200);
      expect(["Engineering"]).toContain(d.category); // extend this set as categories are added
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
    expect(summaries).toHaveLength(5);
    const byId = (id: string) => summaries.find((s) => s.id === id);
    expect(byId("orca/adaptive-delivery")?.stepCount).toBe(12); // 9 steps + splitter + 2 gates
    expect(byId("orca/code-review")?.stepCount).toBe(4);
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

describe("honest/participatory rewrite of the secondary templates", () => {
  const def = (id: string) => BUILTIN_TEMPLATE_CATALOG.find((d) => d.id === id)!;
  const step = (id: string, sid: string) => def(id).steps.find((s) => s.id === sid)!;

  it("bumps code-review, refactor, and quality-coverage to version 3", () => {
    expect(def("orca/code-review").version).toBe(3);
    expect(def("orca/refactor").version).toBe(3);
    expect(def("orca/quality-coverage").version).toBe(3);
  });

  it("tells the analytical/change steps to pause and ask at a user-owned fork", () => {
    expect(step("orca/code-review", "report").instructions).toMatch(/pause and ask/i);
    expect(step("orca/refactor", "restructure").instructions).toMatch(/pause and ask/i);
    expect(step("orca/quality-coverage", "find_gaps").instructions).toMatch(/pause and ask/i);
  });

  it("tells the verification steps to treat prior output as untrusted evidence", () => {
    expect(step("orca/code-review", "analyze_diff").instructions).toMatch(/untrusted/i);
    expect(step("orca/refactor", "behavior_parity").instructions).toMatch(/untrusted/i);
  });

  it("applies YAGNI to the change steps", () => {
    expect(step("orca/refactor", "restructure").instructions).toMatch(/YAGNI|smallest|no .*improvement/i);
    expect(step("orca/quality-coverage", "generate_checks").instructions).toMatch(/right reason/i);
  });

  it("gives every Done step a closing summary that does not finish silently", () => {
    for (const id of ["orca/code-review", "orca/refactor", "orca/quality-coverage"]) {
      expect(step(id, "done").instructions).toMatch(/do not finish silently/i);
    }
  });
});

describe("Adaptive Delivery splitter wiring", () => {
  const def = BUILTIN_TEMPLATE_CATALOG.find((d) => d.id === "orca/adaptive-delivery")!;
  const g = def.graph!;

  it("routes each entry tier to the intended step", () => {
    expect(resolveSplitterNext(g, "route", "clarify_first")).toEqual({ kind: "step", nodeId: "clarify" });
    expect(resolveSplitterNext(g, "route", "ground_and_design")).toEqual({ kind: "step", nodeId: "research" });
    expect(resolveSplitterNext(g, "route", "approach_only")).toEqual({ kind: "step", nodeId: "proposal" });
  });

  it("Triage flows into the splitter", () => {
    expect(resolveStepNext(g, "triage")).toEqual({ kind: "splitter", nodeId: "route" });
  });

  it("the design gate approves to Execution and rejects back to Proposal", () => {
    const approved = g.edges.find((e) => e.from === "designgate" && e.port === "approved");
    const rejected = g.edges.find((e) => e.from === "designgate" && e.port === "rejected");
    expect(approved?.to).toBe("execution");
    expect(rejected?.to).toBe("proposal");
  });
});
