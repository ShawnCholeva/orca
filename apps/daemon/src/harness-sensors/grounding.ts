// apps/daemon/src/harness-sensors/grounding.ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { EvidenceFacet, GroundingCheck } from "@orca/contracts";

type Grounding = NonNullable<EvidenceFacet["grounding"]>;
type CheckResult = Grounding["checks"][number];

const DETAIL_MAX = 512;

/**
 * The evaluator's ONLY workspace access. The contract returns claim verdicts
 * and path names — never file contents — so when the execution plane is
 * extracted this becomes a single low-bandwidth Runner Protocol request
 * ("probe workspace claims"); no source code crosses to the control plane.
 * Today's implementation reads the in-daemon filesystem/git (fused plane),
 * same as claim-verification.ts and write-set.ts. `changedPaths` returns null
 * when git is unavailable so dependent checks skip instead of false-failing.
 */
export interface WorkspaceProbe {
  pathExists(path: string): boolean;
  changedPaths(): string[] | null;
}

const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER = 1_048_576; // 1 MB

/** Parse `git status --porcelain` — rename lines contribute both sides. */
export function parsePorcelainPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    for (const part of rest.split(" -> ")) {
      const p = part.trim().replace(/^"|"$/g, "");
      if (p) paths.push(p);
    }
  }
  return paths;
}

export function localWorkspaceProbe(workspacePath: string): WorkspaceProbe {
  return {
    pathExists: (p) =>
      isAbsolute(p) ? existsSync(p) : existsSync(join(workspacePath, p)),
    changedPaths: () => {
      try {
        return parsePorcelainPaths(
          execFileSync("git", ["status", "--porcelain"], {
            cwd: workspacePath,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          })
        );
      } catch {
        return null;
      }
    },
  };
}

// Resolve a dotted selector ("a", "a.b", "a[].b") against a step output.
// `present` is false when the head field is absent — the check skips rather
// than judging a claim the step never made. A resolved array flattens to its
// elements so "files_in_scope" yields the paths themselves.
function resolveSelector(output: unknown, selector: string): { present: boolean; values: unknown[] } {
  const segments = selector.split(".");
  let current: unknown[] = [output];
  let present = false;
  for (const [i, rawSeg] of segments.entries()) {
    const overArray = rawSeg.endsWith("[]");
    const key = overArray ? rawSeg.slice(0, -2) : rawSeg;
    const next: unknown[] = [];
    for (const v of current) {
      if (v === null || typeof v !== "object" || !(key in (v as Record<string, unknown>))) continue;
      if (i === 0) present = true;
      const child = (v as Record<string, unknown>)[key];
      if (overArray) {
        if (Array.isArray(child)) next.push(...child);
      } else {
        next.push(child);
      }
    }
    current = next;
  }
  const values = current.flatMap((v) => (Array.isArray(v) ? v : [v]));
  return { present, values };
}

function bounded(detail: string): string {
  return detail.length > DETAIL_MAX ? detail.slice(0, DETAIL_MAX) : detail;
}

function normalize(v: unknown): string {
  return String(v).trim().toLowerCase();
}

const strings = (values: unknown[]): string[] =>
  values.filter((v): v is string => typeof v === "string");

function evaluateOne(
  check: GroundingCheck,
  output: unknown,
  probe: WorkspaceProbe | null,
  readPriorOutput: (stepTemplateId: string) => Record<string, unknown> | null
): { result: CheckResult["result"]; detail: string } {
  // Not-applicable clause: skip the check when a prior step's field equals a
  // value (e.g. a reference-existence check on a greenfield build, where the
  // files are planned rather than already present).
  if (check.skipWhen) {
    const prior = readPriorOutput(check.skipWhen.stepId);
    if (prior) {
      const { values } = resolveSelector(prior, check.skipWhen.field);
      if (values.some((v) => normalize(v) === normalize(check.skipWhen!.equals))) {
        return { result: "skipped", detail: check.skipDetail ?? "not applicable" };
      }
    }
  }
  switch (check.rule) {
    case "paths_exist": {
      const { present, values } = resolveSelector(output, check.field);
      if (!present) return { result: "skipped", detail: `${check.field} not present in output` };
      if (!probe) return { result: "skipped", detail: "no workspace to check against" };
      const missing = strings(values).filter((p) => !probe.pathExists(p));
      return missing.length
        ? { result: "failed", detail: bounded(`${check.field} names paths that do not exist in the workspace: ${missing.join(", ")}`) }
        : { result: "passed", detail: "" };
    }
    case "paths_changed": {
      const { present, values } = resolveSelector(output, check.field);
      if (!present) return { result: "skipped", detail: `${check.field} not present in output` };
      if (!probe) return { result: "skipped", detail: "no workspace to check against" };
      const changed = probe.changedPaths();
      if (changed === null) return { result: "skipped", detail: "git state unavailable" };
      const changedSet = new Set(changed);
      const fabricated = strings(values).filter((p) => !changedSet.has(p) && !probe.pathExists(p));
      return fabricated.length
        ? { result: "failed", detail: bounded(`${check.field} claims changes to paths that neither changed nor exist: ${fabricated.join(", ")}`) }
        : { result: "passed", detail: "" };
    }
    case "member_of": {
      const value = resolveSelector(output, check.field);
      if (!value.present) return { result: "skipped", detail: `${check.field} not present in output` };
      const set = new Set(resolveSelector(output, check.set).values.map(normalize));
      const outliers = value.values.filter((v) => !set.has(normalize(v)));
      return outliers.length
        ? { result: "failed", detail: bounded(`${check.field} value ${outliers.map(String).join(", ")} is not among ${check.set}`) }
        : { result: "passed", detail: "" };
    }
    case "implies": {
      const antecedent = resolveSelector(output, check.when.field);
      if (!antecedent.present || !antecedent.values.some((v) => v === check.when.equals)) {
        return { result: "passed", detail: "" };
      }
      const consequent = resolveSelector(output, check.then.field);
      const failures: string[] = [];
      if (check.then.nonEmpty && consequent.values.length === 0) {
        failures.push(`${check.then.field} is empty`);
      }
      if (check.then.equals !== undefined && !consequent.values.some((v) => v === check.then.equals)) {
        failures.push(`${check.then.field} is not ${String(check.then.equals)}`);
      }
      if (check.then.excludes) {
        const forbidden = new Set(check.then.excludes.map(normalize));
        const hits = consequent.values.filter((v) => forbidden.has(normalize(v)));
        if (hits.length) failures.push(`${check.then.field} contains ${hits.map(String).join(", ")}`);
      }
      return failures.length
        ? { result: "failed", detail: bounded(`${check.when.field}=${String(check.when.equals)} but ${failures.join("; ")}`) }
        : { result: "passed", detail: "" };
    }
    case "subset_of_prior": {
      const value = resolveSelector(output, check.field);
      if (!value.present) return { result: "skipped", detail: `${check.field} not present in output` };
      const priorValues = new Set<string>();
      let anyPrior = false;
      for (const p of check.prior) {
        const prior = readPriorOutput(p.stepId);
        if (prior === null) continue;
        anyPrior = true;
        for (const v of resolveSelector(prior, p.field).values) priorValues.add(normalize(v));
      }
      if (!anyPrior) return { result: "skipped", detail: "prior step output unavailable" };
      const unmatched = value.values.filter((v) => !priorValues.has(normalize(v)));
      return unmatched.length
        ? { result: "failed", detail: bounded(`${check.field} values not found in prior outputs: ${unmatched.map(String).join(", ")}`) }
        : { result: "passed", detail: "" };
    }
    case "covers_prior": {
      const value = resolveSelector(output, check.field);
      if (!value.present) return { result: "skipped", detail: `${check.field} not present in output` };
      const current = new Set(value.values.map(normalize));
      const priorValues = new Set<string>();
      let anyPrior = false;
      for (const p of check.prior) {
        const prior = readPriorOutput(p.stepId);
        if (prior === null) continue;
        anyPrior = true;
        for (const v of resolveSelector(prior, p.field).values) priorValues.add(normalize(v));
      }
      if (!anyPrior) return { result: "skipped", detail: "prior step output unavailable" };
      const missing = [...priorValues].filter((v) => !current.has(v));
      return missing.length
        ? { result: "failed", detail: bounded(`${check.field} does not cover prior values: ${missing.join(", ")}`) }
        : { result: "passed", detail: "" };
    }
  }
}

/**
 * Deterministic grounding evaluation — plain code over the step's structured
 * output, the workspace probe, and persisted prior step outputs. No LLM.
 * Observe-mode results are recorded but never contribute to the verdict.
 */
export function evaluateGrounding(opts: {
  checks: GroundingCheck[];
  output: unknown;
  readPriorOutput: (stepTemplateId: string) => Record<string, unknown> | null;
  probe: WorkspaceProbe | null;
}): Grounding {
  const checks: CheckResult[] = opts.checks.map((check) => {
    const { result, detail } = evaluateOne(check, opts.output, opts.probe, opts.readPriorOutput);
    return {
      rule: check.rule,
      field: check.rule === "implies" ? check.when.field : check.field,
      mode: check.mode,
      result,
      detail,
      ...(check.label ? { label: check.label } : {}),
    };
  });
  const enforced = checks.filter((c) => c.mode === "enforce");
  const verdict: Grounding["verdict"] = enforced.some((c) => c.result === "failed")
    ? "failed"
    : checks.every((c) => c.result === "skipped")
      ? "skipped"
      : "passed";
  return { checks, verdict };
}

/**
 * Merge sensor and grounding results into the one EvidenceFacet the gate emits.
 * Sensor semantics are never diluted: `oracleAdequacy` stays sensor-only, a
 * passing grounding never upgrades a sensor verdict, and a facet exists only
 * when something actually ran (all-skipped grounding with no sensors → null).
 */
export function buildEvidenceFacet(args: {
  sensors: EvidenceFacet | null;
  grounding: Grounding | null;
}): EvidenceFacet | null {
  const grounding = args.grounding && args.grounding.verdict !== "skipped" ? args.grounding : null;
  if (!args.sensors && !grounding) return null;
  const groundingFailed = grounding?.verdict === "failed";
  if (!args.sensors) {
    return {
      sensorsRun: [],
      verdict: groundingFailed ? "failed" : "passed",
      untestedRegions: [],
      residualRisk: [],
      oracleAdequacy: { sufficient: false, gaps: [] },
      grounding: grounding!,
    };
  }
  return {
    ...args.sensors,
    verdict: groundingFailed ? "failed" : args.sensors.verdict,
    ...(grounding ? { grounding } : {}),
  };
}
