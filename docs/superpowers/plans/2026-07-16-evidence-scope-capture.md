# Evidence Scope Capture (Phase 2a) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the never-written `EvidenceFacet.untestedRegions` and the half-written `oracleAdequacy.gaps` (plus `residualRisk`) deterministically from facts, so the evidence bundle honestly declares what it could not verify.

**Architecture:** A new pure function `deriveEvidenceScope` computes scope from the step's write-set, the workspace's available sensor kinds, and which sensors actually ran. It's called from `buildEvidenceFacet` (which gains one `scope` arg), fed by the single completion call site (`service.ts:1324`) from the already-derived state facet's write-set and a new `availableSensorKinds` detector. No score/UI change (that's 2b/2c); no contract change (the fields already exist as `string[]`).

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), Vitest, pnpm workspace. Daemon only.

**Spec:** `docs/superpowers/specs/2026-07-16-evidence-scope-capture-design.md`

## Global Constraints

- **Deterministic only — NO model/LLM-generated scope.** Every string is derived from facts (write-set, sensor availability, run sensors). Model-named regions are deferred to a later phase.
- **Sensor semantics never diluted.** `deriveEvidenceScope` must NEVER change `verdict` or `oracleAdequacy.sufficient` — it only fills the descriptive `untestedRegions` / `gaps` / `residualRisk`. Preserve the invariant at `grounding.ts:246-248`.
- **No contract change.** `untestedRegions`/`residualRisk`/`oracleAdequacy.gaps` are already `z.array(z.string())` — 2a only starts *writing* them. Respect the existing caps (`.max(64)` on untestedRegions/residualRisk, strings `.max(512)`).
- **No jargon** in any derived string (`oracle`/`sensor`/`verdict`/`refute`/`veto` — plain language only), matching the metrics failure-label bar.
- **Available-but-unran sensor gaps are gated on a CODE write-set** — a doc/reasoning step (no code files changed) must NOT be flagged "unit tests didn't run."
- **No backfill/migration** — scores recompute from persisted facets on read; historical facets keep their empty `[]` honestly.
- **`buildEvidenceFacet` has exactly one non-test caller** (`service.ts:1324`); the `scope` arg is required.
- **File classification:** a write-set entry is code iff its `kind === "file"` and its `.ref` has a code extension (allow-list in Task 2).

---

## File Structure

**Create:**
- `apps/daemon/src/harness-sensors/scope.ts` — `deriveEvidenceScope` + code-extension allow-list.
- `apps/daemon/src/harness-sensors/scope.test.ts` — fixture unit tests.

**Modify:**
- `apps/daemon/src/harness-sensors/detect.ts` — add `availableSensorKinds(workspacePath)`.
- `apps/daemon/src/harness-sensors/detect.test.ts` — test it (create if absent).
- `apps/daemon/src/harness-sensors/grounding.ts:250-272` — `buildEvidenceFacet` gains `scope`, calls `deriveEvidenceScope` in both branches.
- `apps/daemon/src/harness-sensors/grounding.test.ts` — extend for populated scope + preserved verdict/sufficient.
- `apps/daemon/src/workflows/orchestrator/service.ts:1324` — pass real `scope` (write-set files + available sensors).

---

## Task 1: `availableSensorKinds` detector

**Files:**
- Modify: `apps/daemon/src/harness-sensors/detect.ts`
- Test: `apps/daemon/src/harness-sensors/detect.test.ts`

**Interfaces:**
- Produces: `availableSensorKinds(workspacePath: string): WorkflowSensorKind[]` — the sensor kinds whose package.json script exists in the workspace, regardless of guardrail `required`. (Distinct from `detectSensors`, which intersects with `required`.)

- [ ] **Step 1: Write the failing test**

Create/extend `apps/daemon/src/harness-sensors/detect.test.ts`:
```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { availableSensorKinds } from "./detect.js";

function wsWithScripts(scripts: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "orca-detect-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }));
  return dir;
}

describe("availableSensorKinds", () => {
  it("returns the kinds whose script exists, ignoring guardrail required", () => {
    const ws = wsWithScripts({ typecheck: "tsc", test: "vitest", lint: "eslint" });
    expect(availableSensorKinds(ws).sort()).toEqual(["lint", "typecheck", "unit"]);
  });
  it("returns [] when package.json is absent or has no matching scripts", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "orca-detect-empty-"));
    expect(availableSensorKinds(ws)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- detect.test.ts`
Expected: FAIL — `availableSensorKinds` not exported.

- [ ] **Step 3: Implement it**

In `apps/daemon/src/harness-sensors/detect.ts`, `readScripts` is module-private (line 40). Add below `detectSensors`:
```ts
/** Sensor kinds whose package.json script exists in the workspace, regardless of
 *  guardrail `required` — i.e. what verification COULD run here. */
export function availableSensorKinds(workspacePath: string): WorkflowSensorKind[] {
  const scripts = readScripts(workspacePath);
  return HARNESS_SENSORS.filter((entry) => typeof scripts[entry.script] === "string").map((e) => e.kind);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-sensors/detect.ts apps/daemon/src/harness-sensors/detect.test.ts
git commit -m "feat(daemon): availableSensorKinds — what verification could run in a workspace"
```

---

## Task 2: `deriveEvidenceScope` pure function

**Files:**
- Create: `apps/daemon/src/harness-sensors/scope.ts`
- Test: `apps/daemon/src/harness-sensors/scope.test.ts`

**Interfaces:**
- Consumes: `WorkflowSensorKind` (Task 1 type), `SensorResult` from `@orca/contracts`.
- Produces: `deriveEvidenceScope(input: { writeSet: string[]; availableSensors: WorkflowSensorKind[]; ranSensors: SensorResult[] }): { untestedRegions: string[]; gaps: string[]; residualRisk: string[] }`. Pure, deterministic, no I/O.

> Note: the spec listed `grounding` as a possible input; the deterministic derivation doesn't need it (scope comes from write-set + sensors), so it's omitted to avoid an unused parameter. `hasExecutionOracle` is derived internally as `ranSensors.length > 0`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/harness-sensors/scope.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { deriveEvidenceScope } from "./scope.js";
import type { SensorResult } from "@orca/contracts";

const sensor = (kind: SensorResult["kind"]): SensorResult => ({
  kind, command: "npm run x", exitCode: 0, durationMs: 1, result: "passed", summary: "", artifactRef: null,
});

describe("deriveEvidenceScope", () => {
  it("code changed, nothing executed → gap + per-file untested + residual risk", () => {
    const r = deriveEvidenceScope({ writeSet: ["src/calc.js", "README.md"], availableSensors: ["unit"], ranSensors: [] });
    expect(r.gaps).toContain("code changed but nothing executed it");
    expect(r.gaps).toContain("unit tests are available here but none ran over this change");
    expect(r.untestedRegions).toContain("src/calc.js — changed, no test or check ran over it");
    expect(r.untestedRegions.some((u) => u.includes("README.md"))).toBe(false); // non-code file not listed
    expect(r.residualRisk.length).toBeGreaterThan(0);
  });

  it("non-code output, no execution → 'nothing was executed to check this', NOT dinged for unrun sensors", () => {
    const r = deriveEvidenceScope({ writeSet: ["docs/plan.md"], availableSensors: ["unit", "typecheck"], ranSensors: [] });
    expect(r.gaps).toContain("nothing was executed to check this — semantic correctness is unverified");
    expect(r.gaps.some((g) => g.includes("available here but none ran"))).toBe(false); // gated on code write-set
    expect(r.untestedRegions).toContain("semantic correctness — nothing was executed");
  });

  it("code changed, some sensors ran → no per-file untested; unran available sensor still a gap", () => {
    const r = deriveEvidenceScope({ writeSet: ["src/a.ts"], availableSensors: ["unit", "lint"], ranSensors: [sensor("unit")] });
    expect(r.untestedRegions).toEqual([]); // something executed
    expect(r.gaps).toContain("lint is available here but none ran over this change");
    expect(r.gaps.some((g) => g.includes("unit"))).toBe(false); // unit DID run
  });

  it("no jargon; caps applied", () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    const r = deriveEvidenceScope({ writeSet: many, availableSensors: [], ranSensors: [] });
    expect(r.untestedRegions.length).toBeLessThanOrEqual(64);
    // Derived strings render in the UI, so they must pass the same no-jargon bar as Phase 1.
    expect(JSON.stringify(r)).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });
});
```
> The no-jargon guard is the SAME regex the desktop `no-jargon.test.tsx` enforces (`oracle|sensor|verdict|refute|veto`), because these strings render in "What we couldn't check" and the per-artifact "couldn't check" lines. Every derived string must avoid those tokens.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- scope.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `deriveEvidenceScope`**

Create `apps/daemon/src/harness-sensors/scope.ts`:
```ts
import type { SensorResult, WorkflowSensorKind } from "@orca/contracts";

// Code-file extensions for write-set classification. Deliberately conservative;
// a file not matched here is treated as non-code output.
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".rb", ".c", ".h", ".cc", ".cpp", ".cs", ".php", ".swift", ".kt", ".scala", ".sh",
]);
function isCodeFile(p: string): boolean {
  const dot = p.lastIndexOf(".");
  return dot >= 0 && CODE_EXTS.has(p.slice(dot).toLowerCase());
}

// Plain-language label per sensor kind (no jargon).
const SENSOR_LABEL: Record<WorkflowSensorKind, string> = {
  typecheck: "type checks", lint: "lint", unit: "unit tests",
  integration: "integration tests", build: "the build", static: "static analysis",
};

const REGION_CAP = 64;
const STR_CAP = 512;
const capList = (xs: string[]): string[] => [...new Set(xs.map((x) => x.slice(0, STR_CAP)))].slice(0, REGION_CAP);

export function deriveEvidenceScope(input: {
  writeSet: string[];
  availableSensors: WorkflowSensorKind[];
  ranSensors: SensorResult[];
}): { untestedRegions: string[]; gaps: string[]; residualRisk: string[] } {
  const ran = new Set(input.ranSensors.map((s) => s.kind));
  const hasExecutionOracle = input.ranSensors.length > 0;
  const codeFiles = input.writeSet.filter(isCodeFile);
  const gaps: string[] = [];
  const untestedRegions: string[] = [];
  const residualRisk: string[] = [];

  if (codeFiles.length > 0) {
    // Diversity gaps: verification that exists here but didn't run over this change.
    for (const kind of input.availableSensors) {
      if (!ran.has(kind)) gaps.push(`${SENSOR_LABEL[kind]} are available here but none ran over this change`);
    }
    if (!hasExecutionOracle) {
      gaps.push("code changed but nothing executed it");
      for (const f of codeFiles) untestedRegions.push(`${f} — changed, no test or check ran over it`);
      residualRisk.push("a change could ship with a defect no check would catch");
    }
  } else if (!hasExecutionOracle) {
    // Non-code output with no execution: the whole semantic surface is unverified.
    // (No "oracle"/"sensor"/etc. — these strings render in the UI and must pass no-jargon.)
    gaps.push("nothing was executed to check this — semantic correctness is unverified");
    untestedRegions.push("semantic correctness — nothing was executed");
    untestedRegions.push("runtime behavior");
  }

  return { untestedRegions: capList(untestedRegions), gaps: capList(gaps), residualRisk: capList(residualRisk) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- scope.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-sensors/scope.ts apps/daemon/src/harness-sensors/scope.test.ts
git commit -m "feat(daemon): deriveEvidenceScope — deterministic untested-regions/gaps from write-set + sensors"
```

---

## Task 3: Wire scope into `buildEvidenceFacet` + the completion call site

**Files:**
- Modify: `apps/daemon/src/harness-sensors/grounding.ts:250-272`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts:1324`
- Test: `apps/daemon/src/harness-sensors/grounding.test.ts`

**Interfaces:**
- Consumes: `deriveEvidenceScope` (Task 2), `availableSensorKinds` (Task 1), `WorkflowSensorKind`.
- Produces: `buildEvidenceFacet` gains a required `scope: { writeSet: string[]; availableSensors: WorkflowSensorKind[] }` arg and populates `untestedRegions`/`gaps`/`residualRisk` in both branches.

- [ ] **Step 1: Write the failing test**

Extend `apps/daemon/src/harness-sensors/grounding.test.ts` (create the describe if absent):
```ts
import { describe, expect, it } from "vitest";
import { buildEvidenceFacet } from "./grounding.js";
import type { EvidenceFacet } from "@orca/contracts";

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
    const sensors: EvidenceFacet = {
      sensorsRun: [{ kind: "unit", command: "npm test", exitCode: 0, durationMs: 1, result: "passed", summary: "", artifactRef: null }],
      verdict: "passed", untestedRegions: [], residualRisk: [],
      oracleAdequacy: { sufficient: true, gaps: ["build: no matching script"] },
    };
    const f = buildEvidenceFacet({
      sensors, grounding: null,
      scope: { writeSet: ["src/a.ts"], availableSensors: ["unit", "lint"] },
    })!;
    expect(f.verdict).toBe("passed");            // UNCHANGED
    expect(f.oracleAdequacy.sufficient).toBe(true); // UNCHANGED
    expect(f.oracleAdequacy.gaps).toContain("build: no matching script"); // pre-existing preserved
    expect(f.oracleAdequacy.gaps).toContain("lint is available here but none ran over this change"); // derived
    expect(f.untestedRegions).toEqual([]); // a sensor ran → no per-file untested
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- grounding.test.ts`
Expected: FAIL — `buildEvidenceFacet` doesn't accept `scope` / doesn't populate scope.

- [ ] **Step 3: Update `buildEvidenceFacet`**

In `apps/daemon/src/harness-sensors/grounding.ts`, add the import and rewrite `buildEvidenceFacet` (lines 250-272):
```ts
import { deriveEvidenceScope } from "./scope.js";
import type { WorkflowSensorKind } from "@orca/contracts";

export function buildEvidenceFacet(args: {
  sensors: EvidenceFacet | null;
  grounding: Grounding | null;
  scope: { writeSet: string[]; availableSensors: WorkflowSensorKind[] };
}): EvidenceFacet | null {
  const grounding = args.grounding && args.grounding.verdict !== "skipped" ? args.grounding : null;
  if (!args.sensors && !grounding) return null;
  const groundingFailed = grounding?.verdict === "failed";
  const ranSensors = args.sensors?.sensorsRun ?? [];
  const derived = deriveEvidenceScope({
    writeSet: args.scope.writeSet,
    availableSensors: args.scope.availableSensors,
    ranSensors,
  });
  if (!args.sensors) {
    return {
      sensorsRun: [],
      verdict: groundingFailed ? "failed" : "passed",
      untestedRegions: derived.untestedRegions,
      residualRisk: derived.residualRisk,
      oracleAdequacy: { sufficient: false, gaps: derived.gaps },
      grounding: grounding!,
    };
  }
  return {
    ...args.sensors,
    verdict: groundingFailed ? "failed" : args.sensors.verdict,
    untestedRegions: derived.untestedRegions,
    residualRisk: derived.residualRisk,
    oracleAdequacy: {
      sufficient: args.sensors.oracleAdequacy.sufficient, // UNCHANGED
      gaps: [...new Set([...args.sensors.oracleAdequacy.gaps, ...derived.gaps])],
    },
    ...(grounding ? { grounding } : {}),
  };
}
```
> The sensors branch previously spread `...args.sensors` and only overrode `verdict`. Now it also overrides `untestedRegions`/`residualRisk`/`oracleAdequacy.gaps` (merged) — but NEVER `oracleAdequacy.sufficient`, preserving the sensor-semantics invariant.

- [ ] **Step 4: Update the single caller (`service.ts:1324`)**

In `apps/daemon/src/workflows/orchestrator/service.ts`, add the import (near the other harness-sensors imports at line 89):
```ts
import { buildEvidenceFacet, evaluateGrounding, localWorkspaceProbe, availableSensorKinds } from "../../harness-sensors/grounding.js";
```
> `availableSensorKinds` lives in `detect.js`; re-export it from `grounding.js` OR import from `../../harness-sensors/detect.js`. Pick the path that matches existing import style — the plan assumes a direct `detect.js` import:
```ts
import { availableSensorKinds } from "../../harness-sensors/detect.js";
```
Replace line 1324 (`evidence = buildEvidenceFacet({ sensors, grounding });`) with scope derived from the already-built `stateFacet` (created at ~1235-1249) and the workspace:
```ts
          const writeSet = (stateFacet?.write_set ?? [])
            .filter((w) => w.kind === "file")
            .map((w) => w.ref);
          const availableSensors = workspacePath ? availableSensorKinds(workspacePath) : [];
          evidence = buildEvidenceFacet({ sensors, grounding, scope: { writeSet, availableSensors } });
```
> Confirm `stateFacet` is in scope at 1324 (it is declared at ~1234 `let stateFacet` in the same handler). If a code path reaches 1324 with `stateFacet` still null (its build is in a try/guard), the `?? []` fallback yields an empty write-set — honest (no scope claimed), never a crash.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- grounding.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck (the single caller now compiles with the required arg)**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: clean.

- [ ] **Step 7: Assert the downstream per-artifact `cannotVerify` is now real**

Add to `apps/daemon/src/metrics/verification.test.ts` (or the file testing `buildArtifacts`; create a focused test if absent):
```ts
import { buildArtifacts } from "./verification.js";
it("executable artifact's cannotVerify shows the real gap, not the 'untested regions' placeholder", () => {
  const arts = buildArtifacts({
    hasEvidence: true, anySensors: true, oracleSufficientRate: 0.5,
    oracleGaps: ["lint is available here but none ran over this change"],
    hasRefute: false, falseAccept: 0, hasGrounding: false, groundingFailed: false,
  });
  const exe = arts.find((a) => a.source === "executable")!;
  expect(exe.cannotVerify).toContain("lint are available here but none ran");
  expect(exe.cannotVerify).not.toBe("untested regions");
});
```

- [ ] **Step 8: Run it + commit**

Run: `pnpm --filter @orca/daemon test -- grounding.test.ts verification.test.ts`
Expected: PASS.
```bash
git add apps/daemon/src/harness-sensors/grounding.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/harness-sensors/grounding.test.ts apps/daemon/src/metrics/verification.test.ts
git commit -m "feat(daemon): populate evidence-bundle scope at step completion (Phase 2a)"
```

---

## Task 4: Verification (full suite + live)

**Files:** none (verification only).

- [ ] **Step 1: Full daemon suite + typecheck**

Run: `pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck`
Expected: all green. Any pre-existing test that asserted `untestedRegions: []` / `gaps: []` on a completion fixture that now legitimately has content must be updated to the correct new value (never weakened) — note each in the report.

- [ ] **Step 2: Live drive (per `/verify`)**

Requires the daemon rebuilt/restarted on this code (ask the user first — it disrupts running goals). Then via the browser at http://localhost:5174/ run or inspect a fresh Adaptive Delivery completion and confirm:
- A non-code step (e.g. `research`) now has `untestedRegions`/`gaps` including "nothing was executed to check this — semantic correctness is unverified" — visible in the confirmation card's "What we couldn't check."
- A code step missing a sensor shows "<sensor> are available here but none ran."
- The Metrics tab step-detail "Checks run" per-artifact line shows the real gap text, not the "untested regions" placeholder.
- Optional DB spot-check: `sqlite3` the `evidence_json` of a fresh `triage`/`research` `step_complete` transition and confirm non-empty `untestedRegions`/`oracleAdequacy.gaps`.

- [ ] **Step 3: Final commit (if verification fixups were needed)**

```bash
git add -A && git commit -m "test(daemon): update fixtures for populated evidence scope (Phase 2a)"
```

---

## Self-Review notes
- **Spec coverage:** `availableSensorKinds` (§3.3 → Task 1); `deriveEvidenceScope` deterministic rules incl. code-gating + non-code categorical (§3.1 → Task 2); `buildEvidenceFacet` scope wiring preserving sensor semantics (§3.2 → Task 3); facts at the call site from `stateFacet.write_set` + available sensors (§3.3 → Task 3); per-artifact `cannotVerify` feed (§3.4 → Task 3 Step 7); mechanical-only honesty (no model scope) enforced by construction; live verify (§4 → Task 4).
- **Deviation from spec:** `deriveEvidenceScope` omits the `grounding`/`hasExecutionOracle` inputs the spec's signature sketched — `hasExecutionOracle` is derived internally; `grounding` is unused by the deterministic rules. Noted in Task 2.
- **Type consistency:** `deriveEvidenceScope` input/output matches its Task 3 caller; `buildEvidenceFacet`'s new `scope` shape matches the `service.ts` call site; `availableSensorKinds` return type (`WorkflowSensorKind[]`) matches `scope.availableSensors`.
