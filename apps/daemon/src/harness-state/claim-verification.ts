import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// A structured "file claim" is a path-like string leaf in a step output: a
// relative or absolute path with at least one directory segment and a file
// extension. Conservative on purpose — prose, enums ("passed", "read_only"),
// and single bare words are not claims, so we don't false-positive on them.
const FILE_CLAIM_RE = /^\/?(?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z0-9]{1,8}$/;

function isFileClaim(value: string): boolean {
  return FILE_CLAIM_RE.test(value.trim());
}

/**
 * Collect the unique, sorted set of file-path claims asserted anywhere in a step
 * output (walks nested objects/arrays). This is the structured claim-set 2.8
 * diffs across a correction.
 */
export function extractFileClaims(output: unknown): string[] {
  const claims = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const s = v.trim();
      if (isFileClaim(s)) claims.add(s);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v !== null && typeof v === "object") {
      for (const item of Object.values(v)) walk(item);
    }
  };
  walk(output);
  return [...claims].sort();
}

/**
 * Does a file claim resolve against any of the step's workspace roots? Injected
 * so the actual working-tree read can move behind the RunnerPort (execution
 * plane) without changing the control-plane reject decision. The default reads
 * the in-daemon filesystem, matching the current fused-plane Done-step check.
 */
export type ClaimResolver = (path: string, roots: string[]) => boolean;

const defaultResolve: ClaimResolver = (path, roots) =>
  isAbsolute(path) ? existsSync(path) : roots.some((root) => existsSync(join(root, path)));

/**
 * Item 2.8 — assumption-level claim verification on a correction. Diff the file
 * claim-set the correction introduced against the pre-correction output, and
 * return the NEW claims that don't resolve against the step's workspace roots —
 * the fabricated paths a revision invented. Claims carried over from before the
 * correction are not the correction's fault and are not flagged.
 */
export function verifyCorrectionClaims(args: {
  priorOutput: unknown;
  correctedOutput: unknown;
  roots: string[];
  resolve?: ClaimResolver;
}): { fabricatedClaims: string[] } {
  const resolve = args.resolve ?? defaultResolve;
  const prior = new Set(extractFileClaims(args.priorOutput));
  const introduced = extractFileClaims(args.correctedOutput).filter((c) => !prior.has(c));
  const fabricatedClaims = introduced.filter((c) => !resolve(c, args.roots));
  return { fabricatedClaims };
}
