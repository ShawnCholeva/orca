import type Database from "better-sqlite3";
import { HarnessTransition, HarnessTransitionBoundary, HARNESS_FACETS } from "@orca/contracts";
import { HARNESS_BOUNDARIES } from "./emit.js";

const ENVELOPE_KEYS = new Set([
  "id", "goalId", "workflowRunId", "workflowStepRunId", "boundary", "createdAt",
]);

/**
 * Assert the facet registry stays in lockstep with the contract and the DB:
 *  - registry keys === the non-envelope fields of HarnessTransition
 *  - every registry column exists on the harness_transitions table
 * Throws loud on drift (called at daemon load + in tests).
 */
export function assertFacetConformance(db: Database.Database): void {
  const shapeKeys = Object.keys(HarnessTransition.shape);
  const contractFacetKeys = shapeKeys.filter((k) => !ENVELOPE_KEYS.has(k)).sort();
  const registryKeys = HARNESS_FACETS.map((f) => f.key).slice().sort();
  if (JSON.stringify(contractFacetKeys) !== JSON.stringify(registryKeys)) {
    throw new Error(
      `Harness facet drift: registry [${registryKeys}] != contract facet fields [${contractFacetKeys}]`
    );
  }

  const cols = new Set(
    (db.prepare("PRAGMA table_info(harness_transitions)").all() as { name: string }[]).map((r) => r.name)
  );
  for (const f of HARNESS_FACETS) {
    if (!cols.has(f.column)) {
      throw new Error(`Harness facet drift: column '${f.column}' (facet '${f.key}') missing from harness_transitions`);
    }
  }
}

/** registry boundary keys === the HarnessTransitionBoundary enum (no dormant gaps). */
export function assertBoundaryConformance(): void {
  const enumValues = [...HarnessTransitionBoundary.options].sort();
  const registered = HARNESS_BOUNDARIES.map((b) => b.key).slice().sort();
  if (JSON.stringify(enumValues) !== JSON.stringify(registered)) {
    throw new Error(`Harness boundary drift: registry [${registered}] != enum [${enumValues}]`);
  }
}

/** Aggregator invoked once at daemon startup. Extended by later tasks. */
export function assertHarnessRegistryConformance(db: Database.Database): void {
  assertFacetConformance(db);
  assertBoundaryConformance();
}
