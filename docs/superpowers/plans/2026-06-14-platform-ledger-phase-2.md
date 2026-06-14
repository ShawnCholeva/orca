# Platform-Managed Workflow Ledger (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every workflow run a platform-owned, immutable, versioned ledger that step agents *propose* updates to (via a completion envelope), the orchestrator reviews/normalizes, and the engine validates + commits — so gates and downstream steps read durable committed records instead of re-parsing raw transcripts.

**Architecture:** A step's `orca:step-complete` block changes from a bare business output to an envelope `{ output, ledger_updates }`. The engine validates `output` against the authored step schema (unchanged) and `ledger_updates` against a new platform schema (independently). Proposed updates flow `agent proposes → orchestrator reviews/normalizes → engine allocates canonical IDs + commits a new immutable ledger version → gates read the latest committed version`. The ledger is a self-contained subsystem (new tables + usecases + projection) that hooks into the existing step-completion path in `service.ts`; it is orthogonal to Phase 1 graph routing, which already shipped.

**Tech Stack:** TypeScript, zod (`@orca/contracts`), better-sqlite3 (WAL), Fastify, vitest. Conventional Commits; every commit message ends with the trailer below.

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

**Source spec:** `docs/superpowers/specs/2026-06-12-feature-development-workflow-design.md` — sections "Platform-Managed Workflow Ledger", "Update Ownership", "Gate Execution" (ledger_version on decisions), "Contract additions". Phase 1 (graph routing) is merged to `main` and provides: labeled edges, `evaluate_gate` orchestration kind, `evaluateGate` (`apps/daemon/src/workflows/orchestrator/gate-evaluation.ts`), `workflow_gate_decisions` (note: it currently has **no** `ledger_version` column — Task 7 adds it), the run node cursor, and `commitAdvanceOrComplete` in `service.ts`.

---

## Key existing integration points (verified)

- **Step-complete parsing:** `apps/daemon/src/workflows/orchestrator/orca-output.ts` — `extractOrcaStepCompleteBlock(text): unknown | null` parses the ` ```orca:step-complete ` fenced JSON. Today the parsed object IS the business output.
- **Output validation:** `packages/contracts/src/workflows/output-schema.ts` — `validateStepOutput(schema, output): { ok: true } | { ok: false; errors: string[] }`.
- **Completion path:** `apps/daemon/src/workflows/orchestrator/service.ts` — the `approve_step_complete` handler (~line 1340–1450) extracts the block and writes the `step_output` artifact; the orchestrator-direct step path (~1228, ~1311) calls `validateStepOutput`; `runSynthesis` (~507–569) writes `step_output` on terminal transitions; `commitAdvanceOrComplete` advances/gates.
- **Gate evaluation:** `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts` — `evaluateGate(deps, input)`; `service.ts` `evaluateAndRouteGate` builds the input + calls `recordGateDecision`.
- **Gate persistence:** `apps/daemon/src/workflows/gates/usecases.ts` (`recordGateDecision`, `nextTraversalSeq`), `projection.ts` (`listGateDecisionsForRun`).
- **Migrations:** append-only numbered SQL in `apps/daemon/migrations/`, registered in `apps/daemon/src/migrations.ts`; last is `0030_provider_recovery.sql`. **This plan's migration is `0031_workflow_ledger.sql`.** Three test files assert the exact migration list and must be appended to: `apps/daemon/src/migrations.test.ts`, `apps/daemon/test/migrations-0006.test.ts`, `apps/daemon/src/migrations/suggested-orchestration.test.ts`.
- **Artifacts:** `apps/daemon/src/workflows/artifacts/` (`usecases.ts` `createArtifact`, `projection.ts` `listArtifactsForRun`) — pattern to mirror for ledger persistence/projection.

## Conventions you must follow

- Migrations are **append-only**. Never edit an applied `.sql`. Add `0031_workflow_ledger.sql` and register it.
- Daemon tests: `pnpm --filter @orca/daemon test`; contracts: `pnpm --filter @orca/contracts test`. Single file: append `-- <path>`; one test: `-t "<name>"`. Typecheck: `pnpm typecheck`. Unused exports: `pnpm knip`.
- Projection modules cache prepared statements keyed by `db` identity and expose `resetPreparedStatements()`. When you add a `SELECT`, follow that pattern (tests call `resetPreparedStatements()` in setup).
- Keep changes surgical (CLAUDE.md §3). Backward compatibility is **mandatory**: steps that emit no `ledger_updates` must keep working (treated as an empty array), and the built-in `orca/engineering` template (which emits bare outputs) must not regress.

---

## File Structure

**Contracts (`packages/contracts/src/`)**
- Modify `workflows/index.ts` — add `LedgerOperation`, `LedgerRecordType`, `LedgerRecordStatus`, `LedgerUpdate`, `StepCompletionEnvelope`, `LedgerRecord`, `LedgerVersion` schemas; add `review_ledger` to `OrchestrationDecisionKind` if the orchestrator review is modeled as a broker call (Task 5 decides); export all.

**Daemon ledger subsystem (`apps/daemon/src/workflows/ledger/`) — new directory**
- Create `usecases.ts` — `allocateCanonicalId`, `commitLedgerVersion`, `nextLedgerVersion`.
- Create `projection.ts` — `latestCommittedLedger(db, runId)`, `listLedgerRecordsForRun`, `listLedgerVersionsForRun`, `resetPreparedStatements`.
- Create `usecases.test.ts`, `projection.test.ts`.
- Create `review.ts` — `reviewAndNormalizeLedgerUpdates(...)` (orchestrator-driven normalization of proposals).
- Create `review.test.ts`.

**Daemon parsing**
- Modify `apps/daemon/src/workflows/orchestrator/orca-output.ts` — add `parseStepCompletionEnvelope(block): { output: unknown; ledgerUpdates: unknown[] }` with backward-compat.
- Modify `apps/daemon/src/workflows/orchestrator/orca-output.test.ts`.

**Daemon persistence**
- Create `apps/daemon/migrations/0031_workflow_ledger.sql`.
- Modify `apps/daemon/src/migrations.ts`, `migrations.test.ts`, `test/migrations-0006.test.ts`, `src/migrations/suggested-orchestration.test.ts`.

**Daemon orchestration integration**
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` — split the completion block into `{output, ledger_updates}`; validate independently; on approve, review/normalize + commit a ledger version in the same transaction as `step_output`; feed committed ledger + `ledger_version` into gate evaluation; record `ledger_version` on gate decisions.
- Modify `apps/daemon/migrations/` (gate-decision `ledger_version`) — see Task 7 (new migration `0032_gate_decision_ledger_version.sql`, since `0029` is released).
- Modify `apps/daemon/src/workflows/gates/usecases.ts` + `projection.ts` — carry `ledgerVersion`.

---

## Task 1: Completion-envelope + ledger contracts

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts`
- Test: `packages/contracts/src/__tests__/workflow-contracts.test.ts` (extend) or a new `packages/contracts/src/workflows/ledger-contract.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/workflows/ledger-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  LedgerUpdate,
  StepCompletionEnvelope,
  LedgerOperation,
  LedgerRecordType,
} from "./index.js";

describe("LedgerUpdate", () => {
  it("parses a create proposal with a local ref", () => {
    const u = LedgerUpdate.parse({
      operation: "create",
      record_id: "local:req-1",
      record_type: "requirement",
      status: "open",
      evidence_refs: [],
      note: "first requirement",
    });
    expect(u.operation).toBe("create");
  });

  it("rejects an unknown operation", () => {
    expect(() =>
      LedgerUpdate.parse({ operation: "destroy", record_id: "x", record_type: "finding", status: "open", evidence_refs: [], note: "" }),
    ).toThrow();
  });
});

describe("StepCompletionEnvelope", () => {
  it("parses an envelope with output + ledger_updates", () => {
    const e = StepCompletionEnvelope.parse({
      output: { summary: "done" },
      ledger_updates: [
        { operation: "update", record_id: "REQ-1", record_type: "requirement", status: "satisfied", evidence_refs: ["ev-1"], note: "met" },
      ],
    });
    expect(e.ledger_updates).toHaveLength(1);
  });

  it("defaults ledger_updates to [] when absent", () => {
    const e = StepCompletionEnvelope.parse({ output: { summary: "x" } });
    expect(e.ledger_updates).toEqual([]);
  });
});

describe("enum coverage", () => {
  it("exposes the operation + record-type options", () => {
    expect(LedgerOperation.options).toEqual(["create", "update", "link"]);
    expect(LedgerRecordType.options).toContain("requirement");
  });
});
```

Run: `pnpm --filter @orca/contracts test -- ledger-contract.test.ts` → FAIL (schemas missing).

- [ ] **Step 2: Add the schemas**

In `packages/contracts/src/workflows/index.ts`, near the other workflow schemas, add:

```ts
export const LedgerOperation = z.enum(["create", "update", "link"]);
export type LedgerOperation = z.infer<typeof LedgerOperation>;

export const LedgerRecordType = z.enum([
  "requirement",
  "deliverable",
  "finding",
  "decision",
  "evidence",
  "artifact",
]);
export type LedgerRecordType = z.infer<typeof LedgerRecordType>;

export const LedgerRecordStatus = z.string().min(1).max(64);

export const LedgerUpdate = z
  .object({
    operation: LedgerOperation,
    // For update/link: an existing canonical id. For create: a worker-local ref
    // (e.g. "local:foo"); the engine allocates the canonical id on commit.
    record_id: z.string().min(1).max(128),
    record_type: LedgerRecordType,
    status: LedgerRecordStatus,
    evidence_refs: z.array(z.string().min(1).max(256)).max(100).default([]),
    related_record_ids: z.array(z.string().min(1).max(128)).max(100).optional(),
    note: z.string().max(4000).default(""),
  })
  .strict();
export type LedgerUpdate = z.infer<typeof LedgerUpdate>;

export const StepCompletionEnvelope = z
  .object({
    output: z.unknown(),
    ledger_updates: z.array(LedgerUpdate).max(200).default([]),
  })
  .strict();
export type StepCompletionEnvelope = z.infer<typeof StepCompletionEnvelope>;

// A committed canonical ledger record (read model).
export const LedgerRecord = z
  .object({
    id: z.string().min(1),
    recordType: LedgerRecordType,
    status: LedgerRecordStatus,
    note: z.string(),
    evidenceRefs: z.array(z.string()),
    relatedRecordIds: z.array(z.string()),
    firstVersion: z.number().int().positive(),
    lastVersion: z.number().int().positive(),
    updatedAt: z.string(),
  })
  .strict();
export type LedgerRecord = z.infer<typeof LedgerRecord>;
```

Run: `pnpm --filter @orca/contracts test -- ledger-contract.test.ts` → PASS. Then `pnpm --filter @orca/contracts test` (full) → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/ledger-contract.test.ts
git commit -m "$(cat <<'EOF'
feat(contracts): step completion envelope + ledger update schemas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Ledger tables migration (0031)

**Files:**
- Create: `apps/daemon/migrations/0031_workflow_ledger.sql`
- Modify: `apps/daemon/src/migrations.ts`, `apps/daemon/src/migrations.test.ts`, `apps/daemon/test/migrations-0006.test.ts`, `apps/daemon/src/migrations/suggested-orchestration.test.ts`

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0031_workflow_ledger.sql`:

```sql
-- 0031_workflow_ledger.sql
-- Per-run platform-managed ledger: immutable versions + the canonical records
-- materialized at each version. A new version is committed per executable step
-- whose ledger proposals validate.

-- Monotonic version counter per run (mirrors workflow_runs.traversal_seq pattern).
ALTER TABLE workflow_runs ADD COLUMN ledger_version INTEGER NOT NULL DEFAULT 0;

-- One immutable row per committed ledger version.
CREATE TABLE workflow_ledger_versions (
  id                 TEXT PRIMARY KEY,
  goal_id            TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id    TEXT NOT NULL REFERENCES workflow_runs(id),
  version            INTEGER NOT NULL,
  source_step_run_id TEXT,                 -- null for non-step commits (none in this phase)
  traversal_seq      INTEGER NOT NULL,
  updates_json       TEXT NOT NULL,        -- the normalized, canonical-id'd LedgerUpdate[]
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ledger_versions_run_version
  ON workflow_ledger_versions(workflow_run_id, version);

-- Canonical records, one row per (run, canonical record id), carrying the
-- latest committed state. Earlier states are reconstructable from versions.
CREATE TABLE workflow_ledger_records (
  id                  TEXT NOT NULL,        -- canonical record id (engine-allocated)
  goal_id             TEXT NOT NULL REFERENCES goals(id),
  workflow_run_id     TEXT NOT NULL REFERENCES workflow_runs(id),
  record_type         TEXT NOT NULL,
  status              TEXT NOT NULL,
  note                TEXT NOT NULL DEFAULT '',
  evidence_refs_json  TEXT NOT NULL DEFAULT '[]',
  related_ids_json    TEXT NOT NULL DEFAULT '[]',
  first_version       INTEGER NOT NULL,
  last_version        INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (workflow_run_id, id)
);
CREATE INDEX idx_ledger_records_run ON workflow_ledger_records(workflow_run_id, last_version DESC);
```

- [ ] **Step 2: Register + update assertions**

In `apps/daemon/src/migrations.ts`, append `"0031_workflow_ledger.sql"` after `"0030_provider_recovery.sql"`. Append the same filename to the exact migration-list assertions in `migrations.test.ts`, `test/migrations-0006.test.ts`, and `src/migrations/suggested-orchestration.test.ts` (match each file's quote/comma style). Add a column-presence assertion in `migrations.test.ts`:

```ts
const cols = db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>;
expect(cols.map((c) => c.name)).toContain("ledger_version");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["workflow_ledger_versions", "workflow_ledger_records"]));
```

- [ ] **Step 3: Run + commit**

Run: `pnpm --filter @orca/daemon test -- migrations.test.ts test/migrations-0006.test.ts src/migrations/suggested-orchestration.test.ts` → PASS.

```bash
git add apps/daemon/migrations/0031_workflow_ledger.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts apps/daemon/test/migrations-0006.test.ts apps/daemon/src/migrations/suggested-orchestration.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): workflow ledger tables and per-run version counter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Ledger persistence usecases + projection

**Files:**
- Create: `apps/daemon/src/workflows/ledger/usecases.ts`, `usecases.test.ts`
- Create: `apps/daemon/src/workflows/ledger/projection.ts`, `projection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/ledger/usecases.test.ts` (mirror `gates/usecases.test.ts`: in-memory db, `runMigrations`, seed a goal + template + run):

```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../migrations.js";
import { nextLedgerVersion, commitLedgerVersion, allocateCanonicalId } from "./usecases.js";
import { latestCommittedLedger } from "./projection.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES ('g','G','','active','L1','t','t')").run();
  db.prepare("INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('t','T','',1,0,0,'[]','[]','t','t')").run();
  db.prepare("INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES ('r','g','t',1,'active','t')").run();
});
// NOTE: confirm the real goals NOT-NULL columns against 0001_init.sql before running; adjust the INSERT.

describe("commitLedgerVersion", () => {
  it("allocates canonical ids for creates and materializes records", () => {
    const seq = 1;
    const result = commitLedgerVersion(db, () => "t2", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-1",
      traversalSeq: seq,
      updates: [
        { operation: "create", record_id: "local:a", record_type: "requirement", status: "open", evidence_refs: [], note: "n", related_record_ids: undefined },
      ],
    });
    expect(result.version).toBe(1);
    expect(result.idMap["local:a"]).toMatch(/^REQ-/); // canonical id allocated
    const ledger = latestCommittedLedger(db, "r");
    expect(ledger.version).toBe(1);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0].id).toBe(result.idMap["local:a"]);
  });

  it("applies update/link to the existing canonical record without re-creating", () => {
    const c = commitLedgerVersion(db, () => "t2", { goalId: "g", workflowRunId: "r", sourceStepRunId: "sr-1", traversalSeq: 1, updates: [{ operation: "create", record_id: "local:a", record_type: "requirement", status: "open", evidence_refs: [], note: "" }] });
    const canonical = c.idMap["local:a"];
    const c2 = commitLedgerVersion(db, () => "t3", { goalId: "g", workflowRunId: "r", sourceStepRunId: "sr-2", traversalSeq: 2, updates: [{ operation: "update", record_id: canonical, record_type: "requirement", status: "satisfied", evidence_refs: ["ev-1"], note: "met" }] });
    expect(c2.version).toBe(2);
    const ledger = latestCommittedLedger(db, "r");
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0].status).toBe("satisfied");
    expect(ledger.records[0].lastVersion).toBe(2);
  });
});
```

Run: `pnpm --filter @orca/daemon test -- ledger/usecases.test.ts` → FAIL (modules missing).

- [ ] **Step 2: Write `usecases.ts`**

Create `apps/daemon/src/workflows/ledger/usecases.ts`:

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { LedgerUpdate, LedgerRecordType } from "@orca/contracts";

const ID_PREFIX: Record<LedgerRecordType, string> = {
  requirement: "REQ",
  deliverable: "DEL",
  finding: "FND",
  decision: "DEC",
  evidence: "EVD",
  artifact: "ART",
};

export interface CommitLedgerInput {
  goalId: string;
  workflowRunId: string;
  sourceStepRunId: string | null;
  traversalSeq: number;
  updates: LedgerUpdate[]; // normalized; create ops may carry local refs
}

export interface CommitLedgerResult {
  version: number;
  idMap: Record<string, string>; // local ref -> canonical id (creates only)
}

/** Atomically increments and returns the per-run ledger version. */
export function nextLedgerVersion(db: Database.Database, runId: string): number {
  db.prepare("UPDATE workflow_runs SET ledger_version = ledger_version + 1 WHERE id = ?").run(runId);
  const row = db.prepare("SELECT ledger_version FROM workflow_runs WHERE id = ?").get(runId) as { ledger_version: number } | undefined;
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  return row.ledger_version;
}

/** Allocates a stable canonical id for a new record of the given type. */
export function allocateCanonicalId(recordType: LedgerRecordType): string {
  return `${ID_PREFIX[recordType]}-${randomUUID().slice(0, 8)}`;
}

/**
 * Commits one immutable ledger version for a step: allocates canonical ids for
 * creates, materializes/updates the canonical records, and writes the version
 * row with the resolved (canonical-id'd) updates. Returns the version + the
 * local->canonical id map so the caller can persist the mapping in the step's
 * evidence if desired. All in one transaction.
 */
export function commitLedgerVersion(
  db: Database.Database,
  now: () => string,
  input: CommitLedgerInput
): CommitLedgerResult {
  return db.transaction((): CommitLedgerResult => {
    const version = nextLedgerVersion(db, input.workflowRunId);
    const ts = now();
    const idMap: Record<string, string> = {};

    // First pass: allocate canonical ids for creates.
    for (const u of input.updates) {
      if (u.operation === "create") {
        const canonical = allocateCanonicalId(u.record_type);
        idMap[u.record_id] = canonical;
      }
    }
    const resolve = (id: string): string => idMap[id] ?? id;

    const resolved = input.updates.map((u) => ({
      ...u,
      record_id: resolve(u.record_id),
      related_record_ids: (u.related_record_ids ?? []).map(resolve),
    }));

    // Apply to canonical records.
    for (const u of resolved) {
      if (u.operation === "create") {
        db.prepare(
          `INSERT INTO workflow_ledger_records
             (id, goal_id, workflow_run_id, record_type, status, note,
              evidence_refs_json, related_ids_json, first_version, last_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          u.record_id, input.goalId, input.workflowRunId, u.record_type, u.status, u.note,
          JSON.stringify(u.evidence_refs), JSON.stringify(u.related_record_ids), version, version, ts, ts
        );
      } else {
        // update / link: mutate the existing canonical row, bump last_version.
        const existing = db.prepare(
          "SELECT evidence_refs_json, related_ids_json FROM workflow_ledger_records WHERE workflow_run_id = ? AND id = ?"
        ).get(input.workflowRunId, u.record_id) as { evidence_refs_json: string; related_ids_json: string } | undefined;
        if (!existing) {
          throw new LedgerCommitError(`update/link references unknown canonical record: ${u.record_id}`);
        }
        const evidence = mergeUnique(JSON.parse(existing.evidence_refs_json), u.evidence_refs);
        const related = mergeUnique(JSON.parse(existing.related_ids_json), u.related_record_ids);
        db.prepare(
          "UPDATE workflow_ledger_records SET status = ?, note = ?, evidence_refs_json = ?, related_ids_json = ?, last_version = ?, updated_at = ? WHERE workflow_run_id = ? AND id = ?"
        ).run(u.status, u.note, JSON.stringify(evidence), JSON.stringify(related), version, ts, input.workflowRunId, u.record_id);
      }
    }

    db.prepare(
      `INSERT INTO workflow_ledger_versions
         (id, goal_id, workflow_run_id, version, source_step_run_id, traversal_seq, updates_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), input.goalId, input.workflowRunId, version, input.sourceStepRunId, input.traversalSeq, JSON.stringify(resolved), ts);

    return { version, idMap };
  })();
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

export class LedgerCommitError extends Error {
  readonly code = "ledger_commit_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "LedgerCommitError";
  }
}
```

Create `apps/daemon/src/workflows/ledger/projection.ts`:

```ts
import type Database from "better-sqlite3";
import type { LedgerRecord } from "@orca/contracts";

export interface CommittedLedger {
  version: number;
  records: LedgerRecord[];
}

interface RecordRow {
  id: string; record_type: string; status: string; note: string;
  evidence_refs_json: string; related_ids_json: string;
  first_version: number; last_version: number; updated_at: string;
}

export function latestCommittedLedger(db: Database.Database, runId: string): CommittedLedger {
  const v = db.prepare("SELECT ledger_version FROM workflow_runs WHERE id = ?").get(runId) as { ledger_version: number } | undefined;
  const rows = db.prepare("SELECT * FROM workflow_ledger_records WHERE workflow_run_id = ? ORDER BY first_version ASC").all(runId) as RecordRow[];
  return {
    version: v?.ledger_version ?? 0,
    records: rows.map((r) => ({
      id: r.id,
      recordType: r.record_type as LedgerRecord["recordType"],
      status: r.status,
      note: r.note,
      evidenceRefs: JSON.parse(r.evidence_refs_json),
      relatedRecordIds: JSON.parse(r.related_ids_json),
      firstVersion: r.first_version,
      lastVersion: r.last_version,
      updatedAt: r.updated_at,
    })),
  };
}

export function listLedgerVersionsForRun(db: Database.Database, runId: string): Array<{ version: number; sourceStepRunId: string | null; traversalSeq: number; createdAt: string }> {
  const rows = db.prepare("SELECT version, source_step_run_id, traversal_seq, created_at FROM workflow_ledger_versions WHERE workflow_run_id = ? ORDER BY version ASC").all(runId) as Array<{ version: number; source_step_run_id: string | null; traversal_seq: number; created_at: string }>;
  return rows.map((r) => ({ version: r.version, sourceStepRunId: r.source_step_run_id, traversalSeq: r.traversal_seq, createdAt: r.created_at }));
}
```

(If the project requires `resetPreparedStatements()` parity with other projections, follow the cached-statement pattern from `runs/projection.ts`; the simple uncached form above is acceptable if the file does not cache.)

Run: `pnpm --filter @orca/daemon test -- ledger/usecases.test.ts` → PASS.

- [ ] **Step 3: Projection test + commit**

Add `apps/daemon/src/workflows/ledger/projection.test.ts` asserting `latestCommittedLedger` and `listLedgerVersionsForRun` after two commits (version history length 2, records reflect latest). Run → PASS.

```bash
git add apps/daemon/src/workflows/ledger/
git commit -m "$(cat <<'EOF'
feat(daemon): ledger version commit + canonical id allocation + projection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Completion-envelope parsing (backward-compatible)

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/orca-output.ts`
- Test: `apps/daemon/src/workflows/orchestrator/orca-output.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `orca-output.test.ts`:

```ts
import { parseStepCompletionEnvelope } from "./orca-output.js";

describe("parseStepCompletionEnvelope", () => {
  it("splits an envelope into output + ledgerUpdates", () => {
    const r = parseStepCompletionEnvelope({ output: { summary: "x" }, ledger_updates: [{ operation: "create", record_id: "local:a", record_type: "finding", status: "open", evidence_refs: [], note: "" }] });
    expect(r.output).toEqual({ summary: "x" });
    expect(r.ledgerUpdates).toHaveLength(1);
  });

  it("treats a bare output (no envelope keys) as output with empty ledger updates", () => {
    const r = parseStepCompletionEnvelope({ summary: "legacy" });
    expect(r.output).toEqual({ summary: "legacy" });
    expect(r.ledgerUpdates).toEqual([]);
  });

  it("treats { output } with no ledger_updates as empty updates", () => {
    const r = parseStepCompletionEnvelope({ output: { a: 1 } });
    expect(r.ledgerUpdates).toEqual([]);
  });
});
```

Run: `pnpm --filter @orca/daemon test -- orca-output.test.ts` → FAIL.

- [ ] **Step 2: Implement**

Add to `orca-output.ts`:

```ts
import { StepCompletionEnvelope } from "@orca/contracts";

/**
 * Interprets a parsed orca:step-complete block as the completion envelope
 * `{ output, ledger_updates }`. Backward-compatible: a block that has no
 * `output` key is treated as a bare legacy business output with no ledger
 * updates. Invalid ledger_updates throw via zod (caller maps to a revise).
 */
export function parseStepCompletionEnvelope(block: unknown): { output: unknown; ledgerUpdates: import("@orca/contracts").LedgerUpdate[] } {
  if (block !== null && typeof block === "object" && "output" in (block as Record<string, unknown>)) {
    const parsed = StepCompletionEnvelope.parse(block);
    return { output: parsed.output, ledgerUpdates: parsed.ledger_updates };
  }
  return { output: block, ledgerUpdates: [] };
}
```

Run: `pnpm --filter @orca/daemon test -- orca-output.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/orca-output.ts apps/daemon/src/workflows/orchestrator/orca-output.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): parse step-complete envelope with legacy back-compat

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Orchestrator review/normalize of ledger proposals

**Files:**
- Create: `apps/daemon/src/workflows/ledger/review.ts`, `review.test.ts`
- (Possibly) Modify: `packages/contracts/src/workflows/index.ts` if review is a broker call (add a `review_ledger` orchestration kind + proposal schema, mirroring `gate-evaluation`).

**Design decision (make it explicit in the review module):** The spec says the orchestrator "may accept, correct, or reject proposals against the goal, prior ledger, and step instructions." Implement `reviewAndNormalizeLedgerUpdates` with a **deterministic normalization core** (dedupe, coerce local-ref format, drop updates that reference unknown canonical ids for update/link, default empty arrays) PLUS an optional broker-backed correction pass modeled on `gate-evaluation.ts`. To keep this task self-contained and testable, the broker pass is injected via deps and may be a no-op in tests; the deterministic core is always applied. (If a full broker review is descoped for this phase, the deterministic normalizer alone satisfies "engine validates and commits"; record that choice in the module doc comment.)

- [ ] **Step 1: Write the failing test**

Create `review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reviewAndNormalizeLedgerUpdates } from "./review.js";

const committed = { version: 1, records: [{ id: "REQ-1", recordType: "requirement" as const, status: "open", note: "", evidenceRefs: [], relatedRecordIds: [], firstVersion: 1, lastVersion: 1, updatedAt: "t" }] };

describe("reviewAndNormalizeLedgerUpdates", () => {
  it("keeps valid creates and updates to known records", async () => {
    const r = await reviewAndNormalizeLedgerUpdates({}, {
      committed,
      proposals: [
        { operation: "update", record_id: "REQ-1", record_type: "requirement", status: "satisfied", evidence_refs: ["e"], note: "" },
        { operation: "create", record_id: "local:x", record_type: "finding", status: "open", evidence_refs: [], note: "" },
      ],
    });
    expect(r.accepted).toHaveLength(2);
    expect(r.rejected).toHaveLength(0);
  });

  it("rejects an update to an unknown canonical record", async () => {
    const r = await reviewAndNormalizeLedgerUpdates({}, {
      committed,
      proposals: [{ operation: "update", record_id: "REQ-NOPE", record_type: "requirement", status: "x", evidence_refs: [], note: "" }],
    });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/unknown/i);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `review.ts`**

```ts
import type { LedgerUpdate } from "@orca/contracts";
import type { CommittedLedger } from "./projection.js";

export interface ReviewDeps {
  // Optional broker correction pass; omitted in tests / when descoped.
  correct?: (proposals: LedgerUpdate[]) => Promise<LedgerUpdate[]>;
}
export interface ReviewInput { committed: CommittedLedger; proposals: LedgerUpdate[]; }
export interface ReviewResult {
  accepted: LedgerUpdate[];
  rejected: Array<{ update: LedgerUpdate; reason: string }>;
}

export async function reviewAndNormalizeLedgerUpdates(deps: ReviewDeps, input: ReviewInput): Promise<ReviewResult> {
  const known = new Set(input.committed.records.map((r) => r.id));
  const proposals = deps.correct ? await deps.correct(input.proposals) : input.proposals;
  const accepted: LedgerUpdate[] = [];
  const rejected: ReviewResult["rejected"] = [];
  const seen = new Set<string>();
  for (const u of proposals) {
    const key = `${u.operation}:${u.record_id}`;
    if (seen.has(key)) continue; // dedupe
    seen.add(key);
    if ((u.operation === "update" || u.operation === "link") && !known.has(u.record_id)) {
      rejected.push({ update: u, reason: `unknown canonical record: ${u.record_id}` });
      continue;
    }
    accepted.push({ ...u, evidence_refs: u.evidence_refs ?? [], note: u.note ?? "" });
  }
  return { accepted, rejected };
}
```

Run → PASS. Commit:

```bash
git add apps/daemon/src/workflows/ledger/review.ts apps/daemon/src/workflows/ledger/review.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): orchestrator review/normalize for ledger proposals

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire the envelope + ledger commit into step completion

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` (extend) or a new `service.ledger.test.ts`

**Goal:** Every place that today does `extractOrcaStepCompleteBlock(...)` → treat-as-output must now: parse the envelope, validate `output` against the step schema (unchanged behavior), and on a *successful* completion (approve path), review/normalize `ledger_updates` and `commitLedgerVersion` **in the same transaction** that writes the `step_output` artifact + advances. Invalid `output` OR invalid `ledger_updates` → revise the step (existing revise path). Steps emitting no `ledger_updates` commit a version with `updates: []` (or skip the commit — see decision below) so back-compat holds.

**Decision (document inline):** Commit a ledger version on every successful executable step even when `updates` is empty, so `ledger_version` advances monotonically and gates can reference a stable version. (Alternative: only commit when non-empty — but then `ledger_version` on the gate decision is ambiguous. Prefer always-commit; an empty version is cheap.) The terminal step's ledger commit must occur before the `mark_run_complete` recommendation (Phase 1's human yield), preserving that gate.

- [ ] **Step 1: Write the failing test**

In `service.agent-step.test.ts` (reuse the harness), drive a step whose agent emits an envelope:

```ts
it("commits a ledger version from the step completion envelope", async () => {
  // arrange a run at an executable step; agent response contains:
  // ```orca:step-complete\n{ "output": {<valid per schema>}, "ledger_updates": [{create requirement local:a ...}] }\n```
  await driveStepToApproval(/* ... */);
  const ledger = latestCommittedLedger(db, run.id);
  expect(ledger.version).toBeGreaterThanOrEqual(1);
  expect(ledger.records.some((r) => r.recordType === "requirement")).toBe(true);
});

it("revises the step when ledger_updates are invalid (unknown canonical record)", async () => {
  // agent emits a valid output but an update to a nonexistent canonical id
  // assert the step is revised (not advanced) and no ledger version committed
});

it("still completes a legacy step that emits a bare output (no ledger_updates)", async () => {
  // agent emits ```orca:step-complete\n{ <bare output> }\n``` → advances; ledger version committed with empty updates
});
```

Adapt to the real harness (`driveStepToApproval`, how the fake agent response text is set, `run`, `db`). Run → FAIL.

- [ ] **Step 2: Implement**

In `service.ts`, at each `extractOrcaStepCompleteBlock` consumer in the completion path (the `approve_step_complete` handler ~1423 and the orchestrator-direct/synthesis paths that write `step_output`): replace the "block IS output" assumption with:

```ts
import { parseStepCompletionEnvelope } from "./orca-output.js";
import { reviewAndNormalizeLedgerUpdates } from "../ledger/review.js";
import { commitLedgerVersion } from "../ledger/usecases.js";
import { latestCommittedLedger } from "../ledger/projection.js";
import { LedgerUpdate } from "@orca/contracts";

const block = extractOrcaStepCompleteBlock(responseText);
const { output, ledgerUpdates: rawLedger } = parseStepCompletionEnvelope(block);
// validate business output exactly as today:
const v = validateStepOutput(stepTpl.outputSchema, output);
if (!v.ok) { /* existing revise path with v.errors */ }
// validate ledger proposals:
const parsedLedger = LedgerUpdate.array().safeParse(rawLedger);
if (!parsedLedger.success) { /* revise: "invalid ledger_updates" */ }
```

Then, inside the existing transaction that writes the `step_output` artifact and advances (so commit is atomic with the step result):

```ts
const committed = latestCommittedLedger(db, run.id);
const review = await reviewAndNormalizeLedgerUpdates({ /* correct?: brokered */ }, { committed, proposals: parsedLedger.data });
if (review.rejected.length > 0) { /* revise the step with the rejection reasons */ }
const ledgerCommit = commitLedgerVersion(db, now, {
  goalId: run.goalId,
  workflowRunId: run.id,
  sourceStepRunId: stepRun.id,
  traversalSeq: /* current traversal seq for this run */,
  updates: review.accepted,
});
// continue with writing step_output (the validated `output`) + advance, unchanged.
```

IMPORTANT (real-code adaptations):
- `reviewAndNormalizeLedgerUpdates` is async; ensure it is awaited OUTSIDE any synchronous `db.transaction(...)` (better-sqlite3 transactions must be synchronous). Pattern: do the async review first, then open the sync transaction for `commitLedgerVersion` + `step_output` + advance. (`commitLedgerVersion` opens its own sync transaction; if you need step_output + ledger in ONE transaction, inline `commitLedgerVersion`'s body into the existing sync block or wrap both in an outer `db.transaction` and call a non-transactional commit variant — verify the real transaction structure of the completion path and choose the approach that keeps it atomic and synchronous.)
- The `step_output` artifact must store the validated `output` (NOT the whole envelope), so downstream readers (`collectPriorStepArtifacts`, activity projection) are unaffected.
- Confirm the real `traversal_seq` accessor for the run (Phase 1 added `workflow_runs.traversal_seq`).
- Apply the SAME envelope split to `runSynthesis` and the orchestrator-direct path if they write `step_output` from a completion block.

Run the new tests + the broader suite: `pnpm --filter @orca/daemon test -- src/workflows/orchestrator` → PASS (existing completion tests still green; legacy bare-output steps unaffected). Typecheck: `pnpm --filter @orca/daemon exec tsc --noEmit -p tsconfig.json`.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): commit ledger versions from step completion envelopes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Feed committed ledger into gate evaluation + record ledger_version

**Files:**
- Create: `apps/daemon/migrations/0032_gate_decision_ledger_version.sql`
- Modify: `apps/daemon/src/migrations.ts` + the 3 migration-list test files
- Modify: `apps/daemon/src/workflows/gates/usecases.ts`, `projection.ts` (carry `ledgerVersion`)
- Modify: `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts` (request payload includes committed ledger)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`evaluateAndRouteGate` supplies committed ledger + records `ledger_version`)
- Modify: `packages/contracts/src/workflows/index.ts` (`GateEvaluationRequest` gains a `committedLedger` field)
- Test: `gate-evaluation.test.ts`, `service.gate-routing.test.ts` (extend)

**Why:** the spec's gate input includes "relevant committed ledger state" and the gate decision records a `ledger_version`. Phase 1 shipped `workflow_gate_decisions` WITHOUT `ledger_version`; add it now (migration `0032`, since `0029` is released).

- [ ] **Step 1: Migration + contract**

`0032_gate_decision_ledger_version.sql`:
```sql
ALTER TABLE workflow_gate_decisions ADD COLUMN ledger_version INTEGER NOT NULL DEFAULT 0;
```
Register + append to the 3 migration-list assertions. In `GateEvaluationRequest` add `committedLedger: z.array(z.object({ id: z.string(), recordType: z.string(), status: z.string(), note: z.string() }).strict()).max(200)` (a bounded read-only view) and bump the payload-size guard tolerance if needed. Contract test for the new field.

- [ ] **Step 2: Carry ledgerVersion through gate persistence**

`gates/usecases.ts` `recordGateDecision` + `GateDecisionInput` gain `ledgerVersion: number`; INSERT it. `projection.ts` `GateDecisionRecord` + the SELECT mapping gain `ledgerVersion`. Update `gates/usecases.test.ts` to assert it persists. Run → PASS.

- [ ] **Step 3: Supply + record in the service**

In `evaluateAndRouteGate` (`service.ts`): `const ledger = latestCommittedLedger(db, run.id);` pass `committedLedger: ledger.records.map(r => ({ id: r.id, recordType: r.recordType, status: r.status, note: r.note }))` into the `evaluateGate` input, and pass `ledgerVersion: ledger.version` into `recordGateDecision`. Extend `service.gate-routing.test.ts` to assert the recorded gate decision carries the current `ledger_version`. Run `pnpm --filter @orca/daemon test -- src/workflows/orchestrator` → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/migrations/0032_gate_decision_ledger_version.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts apps/daemon/test/migrations-0006.test.ts apps/daemon/src/migrations/suggested-orchestration.test.ts apps/daemon/src/workflows/gates/usecases.ts apps/daemon/src/workflows/gates/usecases.test.ts apps/daemon/src/workflows/gates/projection.ts apps/daemon/src/workflows/orchestrator/gate-evaluation.ts apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/graph-contract.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): gates read committed ledger and record ledger_version

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Expose committed ledger + version history on the run read model (minimal)

**Files:**
- Modify: `apps/daemon/src/workflows/runs/projection.ts` or add a ledger read route (follow the existing run-detail / activities read pattern)
- Test: the owning projection/route test

**Scope:** The spec says the run UI "can expose committed ledger state, version history, step evidence, scores, and gate decisions." Provide the daemon read surface only (desktop rendering is out of scope for this plan): a `GET` that returns `latestCommittedLedger(db, runId)` + `listLedgerVersionsForRun(db, runId)` for a run, wired into the existing workflow-run read route or a new `/v1/workflows/runs/:id/ledger` route mirroring an existing authenticated GET. TDD: route test asserts the committed records + version list after a run commits versions. Commit.

(If a run-detail aggregate already exists, prefer extending it over a new route — verify and choose the minimal change.)

---

## Task 9: Full-suite green + typecheck + knip

**Files:** none (verification gate)

- [ ] `pnpm typecheck` → clean.
- [ ] `pnpm --filter @orca/daemon test` → PASS (legacy bare-output completion tests still green — back-compat).
- [ ] `pnpm --filter @orca/contracts test` → PASS.
- [ ] `pnpm knip` → no NEW unused exports from `workflows/ledger/*` (wire or remove anything flagged).
- [ ] Verify the spec's ledger coverage items: ledger proposal review/validation/versioning/replay safety; gate reads committed (not proposed) state; step emitting no updates still completes; canonical-id allocation on create; update/link to unknown record revises the step.
- [ ] Commit any fixups:

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(daemon): typecheck and suite green for platform ledger phase 2

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
> NOTE: at execution time the working tree may contain unrelated leftover groundwork (`scoring-summary.ts`, `runtime.ts`) and the Phase-3 design doc. Do NOT `git add -A` blindly — stage only ledger-related fixups. Replace the `git add -A` above with explicit paths.

---

## Self-Review (spec coverage)

- Completion envelope `{ output, ledger_updates }` + independent validation → Tasks 1, 4, 6. ✓
- Platform-owned tables + versioning + canonical-ID allocation → Tasks 2, 3. ✓
- `agent proposes → orchestrator reviews/normalizes → engine validates + commits` → Tasks 5, 6. ✓
- Gates read committed (not proposed) ledger + decision records `ledger_version` → Task 7. ✓
- Backward compatibility (bare output, no ledger_updates) → Tasks 4, 6 (legacy test). ✓
- Run read surface for committed ledger + history → Task 8. ✓
- Verification suite → Task 9. ✓

**Deferred / non-goals (per spec):** the cross-goal knowledge-graph projection and cross-run retrieval are NOT built. Desktop ledger rendering beyond the daemon read surface is out of scope here.

**Open decisions for the implementer to confirm against live code before starting Task 6:** (1) the exact transaction structure of the completion path so the ledger commit is atomic with `step_output` + advance while keeping the async review outside any sync transaction; (2) whether to always-commit an empty ledger version (recommended) vs only on non-empty; (3) whether the orchestrator review uses a real broker correction pass or the deterministic normalizer alone for this phase.
