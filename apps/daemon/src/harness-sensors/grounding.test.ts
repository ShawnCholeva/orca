// apps/daemon/src/harness-sensors/grounding.test.ts
import { describe, expect, it } from "vitest";
import type { EvidenceFacet, GroundingCheck } from "@orca/contracts";
import { buildEvidenceFacet, evaluateGrounding, type WorkspaceProbe } from "./grounding.js";

// A probe with a fixed set of existing paths and changed paths. `changed: null`
// simulates git being unavailable.
function probe(existing: string[], changed: string[] | null = []): WorkspaceProbe {
  return {
    pathExists: (p) => existing.includes(p),
    changedPaths: () => changed,
  };
}

const noPrior = () => null;

function run(checks: GroundingCheck[], output: unknown, p: WorkspaceProbe | null = probe([])) {
  return evaluateGrounding({ checks, output, readPriorOutput: noPrior, probe: p });
}

describe("evaluateGrounding — paths_exist", () => {
  const check: GroundingCheck[] = [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce" }];

  it("passes when every named path exists", () => {
    const g = run(check, { files_in_scope: ["src/a.ts", "src/b.ts"] }, probe(["src/a.ts", "src/b.ts"]));
    expect(g.checks[0]!.result).toBe("passed");
    expect(g.verdict).toBe("passed");
  });

  it("fails and names the missing paths", () => {
    const g = run(check, { files_in_scope: ["src/a.ts", "src/nope.ts"] }, probe(["src/a.ts"]));
    expect(g.checks[0]!.result).toBe("failed");
    expect(g.checks[0]!.detail).toContain("src/nope.ts");
    expect(g.checks[0]!.detail).not.toContain("src/a.ts,");
    expect(g.verdict).toBe("failed");
  });

  it("skips when the field is absent or there is no workspace", () => {
    expect(run(check, {}, probe([])).checks[0]!.result).toBe("skipped");
    expect(run(check, { files_in_scope: ["src/a.ts"] }, null).checks[0]!.result).toBe("skipped");
  });
});

describe("evaluateGrounding — paths_changed", () => {
  const check: GroundingCheck[] = [{ rule: "paths_changed", field: "changes[].file", mode: "enforce" }];
  const output = { changes: [{ file: "src/edited.ts" }, { file: "src/deleted.ts" }] };

  it("passes for paths in the change set or existing on disk", () => {
    // edited.ts exists but is not in the diff (committed); deleted.ts is in the diff but gone from disk.
    const g = run(check, output, probe(["src/edited.ts"], ["src/deleted.ts"]));
    expect(g.checks[0]!.result).toBe("passed");
  });

  it("fails for a fabricated path that neither changed nor exists", () => {
    const g = run(check, { changes: [{ file: "src/fabricated.ts" }] }, probe([], []));
    expect(g.checks[0]!.result).toBe("failed");
    expect(g.checks[0]!.detail).toContain("src/fabricated.ts");
  });

  it("skips when git is unavailable", () => {
    const g = run(check, { changes: [{ file: "src/x.ts" }] }, probe([], null));
    expect(g.checks[0]!.result).toBe("skipped");
  });
});

describe("evaluateGrounding — member_of", () => {
  const check: GroundingCheck[] = [
    { rule: "member_of", field: "chosen_approach", set: "approaches[].name", mode: "enforce" },
  ];

  it("passes when the value is in the set and fails when it is not", () => {
    const output = { chosen_approach: "B", approaches: [{ name: "A" }, { name: "B" }] };
    expect(run(check, output).checks[0]!.result).toBe("passed");
    const g = run(check, { chosen_approach: "C", approaches: [{ name: "A" }] });
    expect(g.checks[0]!.result).toBe("failed");
    expect(g.checks[0]!.detail).toContain("C");
  });
});

describe("evaluateGrounding — implies", () => {
  it("vacuously passes when the antecedent does not hold", () => {
    const g = run(
      [{ rule: "implies", when: { field: "verdict", equals: "needs_work" }, then: { field: "concerns", nonEmpty: true }, mode: "enforce" }],
      { verdict: "sound", concerns: [] },
    );
    expect(g.checks[0]!.result).toBe("passed");
  });

  it("fails when the antecedent holds and the consequent is empty", () => {
    const g = run(
      [{ rule: "implies", when: { field: "verdict", equals: "needs_work" }, then: { field: "concerns", nonEmpty: true }, mode: "enforce" }],
      { verdict: "needs_work", concerns: [] },
    );
    expect(g.checks[0]!.result).toBe("failed");
  });

  it("fails an excludes consequent when a forbidden value is present", () => {
    const g = run(
      [{ rule: "implies", when: { field: "verdict", equals: "passed" }, then: { field: "findings[].severity", excludes: ["critical", "high"] }, mode: "enforce" }],
      { verdict: "passed", findings: [{ severity: "high" }, { severity: "low" }] },
    );
    expect(g.checks[0]!.result).toBe("failed");
    expect(g.checks[0]!.detail).toContain("high");
  });
});

describe("evaluateGrounding — subset_of_prior", () => {
  const check: GroundingCheck[] = [{
    rule: "subset_of_prior", field: "delivered_requirements",
    prior: [{ stepId: "execution", field: "completed_requirements" }], mode: "observe",
  }];

  it("passes when every value appears in the prior step's output (case/space-insensitive)", () => {
    const g = evaluateGrounding({
      checks: check,
      output: { delivered_requirements: ["Login works "] },
      readPriorOutput: (id) => (id === "execution" ? { completed_requirements: ["login works"] } : null),
      probe: probe([]),
    });
    expect(g.checks[0]!.result).toBe("passed");
  });

  it("skips when the prior step output is unavailable", () => {
    const g = evaluateGrounding({
      checks: check, output: { delivered_requirements: ["x"] },
      readPriorOutput: () => null, probe: probe([]),
    });
    expect(g.checks[0]!.result).toBe("skipped");
  });
});

describe("evaluateGrounding — covers_prior", () => {
  const check: GroundingCheck[] = [{
    rule: "covers_prior", field: "task_plan[].files",
    prior: [{ stepId: "research", field: "files_in_scope" }], mode: "observe",
  }];
  const priorRes = (id: string) => (id === "research" ? { files_in_scope: ["src/a.ts", "src/b.ts"] } : null);

  it("passes when the current field covers every prior value (superset)", () => {
    const g = evaluateGrounding({
      checks: check,
      output: { task_plan: [{ files: ["src/a.ts"] }, { files: ["src/b.ts", "src/c.ts"] }] },
      readPriorOutput: priorRes, probe: probe([]),
    });
    expect(g.checks[0]!.result).toBe("passed");
  });

  it("fails and names prior values missing from the current field", () => {
    const g = evaluateGrounding({
      checks: check,
      output: { task_plan: [{ files: ["src/a.ts"] }] },
      readPriorOutput: priorRes, probe: probe([]),
    });
    expect(g.checks[0]!.result).toBe("failed");
    expect(g.checks[0]!.detail).toContain("src/b.ts");
  });

  it("skips when the current field is absent or no prior output is available", () => {
    expect(evaluateGrounding({ checks: check, output: {}, readPriorOutput: priorRes, probe: probe([]) }).checks[0]!.result).toBe("skipped");
    expect(evaluateGrounding({ checks: check, output: { task_plan: [{ files: ["x"] }] }, readPriorOutput: () => null, probe: probe([]) }).checks[0]!.result).toBe("skipped");
  });
});

describe("evaluateGrounding — skipWhen", () => {
  const check: GroundingCheck[] = [{
    rule: "paths_exist", field: "files_in_scope", mode: "enforce",
    skipWhen: { stepId: "triage", field: "codebase_state", equals: "greenfield" },
    skipDetail: "greenfield — files are planned, not yet created",
  }];

  it("skips (not fails) when the prior field equals the skip value, even if paths do not exist", () => {
    const g = evaluateGrounding({
      checks: check,
      output: { files_in_scope: ["src/new.ts"] }, // does not exist
      readPriorOutput: (id) => (id === "triage" ? { codebase_state: "greenfield" } : null),
      probe: probe([]),
    });
    expect(g.checks[0]!.result).toBe("skipped");
    expect(g.checks[0]!.detail).toContain("greenfield");
  });

  it("still enforces when the prior field does not match the skip value", () => {
    const g = evaluateGrounding({
      checks: check,
      output: { files_in_scope: ["src/new.ts"] },
      readPriorOutput: (id) => (id === "triage" ? { codebase_state: "existing_understood" } : null),
      probe: probe(["src/a.ts"]),
    });
    expect(g.checks[0]!.result).toBe("failed");
  });

  it("carries the check's label onto the result", () => {
    const labeled: GroundingCheck[] = [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce", label: "Referenced files exist" }];
    const g = run(labeled, { files_in_scope: ["src/a.ts"] }, probe(["src/a.ts"]));
    expect(g.checks[0]!.label).toBe("Referenced files exist");
  });
});

describe("evaluateGrounding — verdict semantics", () => {
  it("excludes observe-mode failures from the verdict", () => {
    const g = run(
      [{ rule: "paths_exist", field: "files_in_scope", mode: "observe" }],
      { files_in_scope: ["src/nope.ts"] },
      probe([]),
    );
    expect(g.checks[0]!.result).toBe("failed");
    expect(g.verdict).toBe("passed");
  });

  it("is skipped when every check skipped", () => {
    const g = run([{ rule: "paths_exist", field: "missing", mode: "enforce" }], {});
    expect(g.verdict).toBe("skipped");
  });
});

describe("buildEvidenceFacet", () => {
  const sensors: EvidenceFacet = {
    sensorsRun: [{ kind: "unit", command: "pnpm test", exitCode: 0, durationMs: 5,
      result: "passed", summary: "", artifactRef: null }],
    verdict: "passed", untestedRegions: [], residualRisk: [],
    oracleAdequacy: { sufficient: true, gaps: [] },
  };
  const failedGrounding = {
    checks: [{ rule: "paths_exist", field: "f", mode: "enforce" as const, result: "failed" as const, detail: "d" }],
    verdict: "failed" as const,
  };
  const passedGrounding = {
    checks: [{ rule: "paths_exist", field: "f", mode: "enforce" as const, result: "passed" as const, detail: "" }],
    verdict: "passed" as const,
  };
  const skippedGrounding = {
    checks: [{ rule: "paths_exist", field: "f", mode: "enforce" as const, result: "skipped" as const, detail: "" }],
    verdict: "skipped" as const,
  };

  const noScope = { writeSet: [], availableSensors: [] };

  it("returns null when nothing ran", () => {
    expect(buildEvidenceFacet({ sensors: null, grounding: null, scope: noScope })).toBeNull();
    expect(buildEvidenceFacet({ sensors: null, grounding: skippedGrounding, scope: noScope })).toBeNull();
  });

  it("builds a grounding-only facet with a sensor-free oracle", () => {
    const f = buildEvidenceFacet({ sensors: null, grounding: passedGrounding, scope: noScope })!;
    expect(f.sensorsRun).toHaveLength(0);
    expect(f.verdict).toBe("passed");
    expect(f.oracleAdequacy.sufficient).toBe(false);
    // Non-code, no-execution scope: derived gap for "nothing was executed".
    expect(f.oracleAdequacy.gaps).toEqual(["nothing was executed to check this — semantic correctness is unverified"]);
    expect(f.grounding?.verdict).toBe("passed");
  });

  it("a failed enforce grounding check fails the merged verdict", () => {
    expect(buildEvidenceFacet({ sensors, grounding: failedGrounding, scope: noScope })!.verdict).toBe("failed");
    expect(buildEvidenceFacet({ sensors: null, grounding: failedGrounding, scope: noScope })!.verdict).toBe("failed");
  });

  it("passing grounding never upgrades a sensor verdict or oracle adequacy", () => {
    const partial: EvidenceFacet = { ...sensors, verdict: "partial", oracleAdequacy: { sufficient: false, gaps: ["unit_tests: no matching script"] } };
    const merged = buildEvidenceFacet({ sensors: partial, grounding: passedGrounding, scope: noScope })!;
    expect(merged.verdict).toBe("partial");
    expect(merged.oracleAdequacy.sufficient).toBe(false);
    expect(merged.oracleAdequacy.gaps).toEqual(["unit_tests: no matching script"]);
  });
});

const groundingPass = { verdict: "passed" as const, checks: [{ mode: "enforce", result: "passed" }] } as never;

describe("buildEvidenceFacet — scope population", () => {
  it("no-sensors branch populates untested/gaps from scope (non-code)", () => {
    const f = buildEvidenceFacet({
      sensors: null, grounding: groundingPass,
      scope: { writeSet: ["docs/x.md"], availableSensors: ["unit"] },
    })!;
    expect(f.oracleAdequacy.sufficient).toBe(false); // UNCHANGED
    expect(f.oracleAdequacy.gaps).toContain("nothing was executed to check this — semantic correctness is unverified");
    expect(f.untestedRegions).toContain("semantic correctness — nothing was executed");
  });

  it("sensors branch merges derived gaps with existing missing-required gaps; verdict/sufficient unchanged", () => {
    const sensorsFacet: EvidenceFacet = {
      sensorsRun: [{ kind: "unit", command: "npm test", exitCode: 0, durationMs: 1, result: "passed", summary: "", artifactRef: null }],
      verdict: "passed", untestedRegions: [], residualRisk: [],
      oracleAdequacy: { sufficient: true, gaps: ["build: no matching script"] },
    };
    const f = buildEvidenceFacet({
      sensors: sensorsFacet, grounding: null,
      scope: { writeSet: ["src/a.ts"], availableSensors: ["unit", "lint"] },
    })!;
    expect(f.verdict).toBe("passed");            // UNCHANGED
    expect(f.oracleAdequacy.sufficient).toBe(true); // UNCHANGED
    expect(f.oracleAdequacy.gaps).toContain("build: no matching script"); // pre-existing preserved
    expect(f.oracleAdequacy.gaps).toContain("lint is available here but none ran over this change"); // derived
    expect(f.untestedRegions).toEqual([]); // a sensor ran → no per-file untested
  });
});
