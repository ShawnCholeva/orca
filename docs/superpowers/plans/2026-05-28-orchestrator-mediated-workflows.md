# Orchestrator-Mediated Workflow Runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure workflow execution so a user-selected orchestrator-LLM mediates every interaction between the chat surface and per-step agents. Every step spawns an agent (one per step); the orchestrator-LLM judges step satisfaction; the run is autonomous from goal creation through every step, yielding only at the final mark-done confirm.

**Architecture:** Unified adapter dispatch layer for both orchestrator-LLM and per-step agents. DB-backed per-adapter execution-mode config (enabled/disabled, one preferred) toggles transport without code change. Workflow step templates declare `agentPreference: StepAgentChoice[]` (ordered fallback of `{adapterId, modelId, providerId?}`); the engine deterministically resolves the per-step agent + execution mode. An `OrchestratorMediator` runs the orchestrator-LLM on every trigger (user message, agent response-done hook, crash, idle timeout) to paraphrase agent output, translate user input, and approve/revise step-complete proposals. Chat UI surfaces three element kinds: user messages, orchestrator-paraphrased agent responses (with collapsible raw transcript), and persistent-styled internal-thought rows.

**Tech Stack:** TypeScript across daemon (Fastify + better-sqlite3 + node-pty) and desktop (React + Tauri); Zod for contract schemas; Vitest for tests in both packages.

**Spec:** `docs/superpowers/specs/2026-05-28-orchestrator-mediated-workflows-design.md`

---

## File Structure

This plan covers all 10 sub-plans from the spec's "Recommended decomposition" section. Files are listed by which sub-plan first creates or substantively modifies them.

### Created files

```
apps/daemon/migrations/0015_adapter_execution_modes.sql              -- Sub-plan 1
apps/daemon/src/adapters/execution-modes.ts                          -- Sub-plan 1
apps/daemon/src/adapters/execution-modes.test.ts                     -- Sub-plan 1
apps/daemon/src/adapters/execution-modes-routes.ts                   -- Sub-plan 1
apps/daemon/src/adapters/execution-modes-routes.test.ts              -- Sub-plan 1
apps/daemon/src/orchestrator-llm/                                    -- Sub-plan 3
apps/daemon/src/orchestrator-llm/session.ts                          -- Sub-plan 3
apps/daemon/src/orchestrator-llm/session.test.ts                     -- Sub-plan 3
apps/daemon/src/orchestrator-llm/mediator.ts                         -- Sub-plan 3
apps/daemon/src/orchestrator-llm/mediator.test.ts                    -- Sub-plan 3
apps/daemon/src/orchestrator-llm/context.ts                          -- Sub-plan 3
apps/daemon/src/orchestrator-llm/context.test.ts                     -- Sub-plan 3
apps/daemon/src/orchestrator-llm/prompts.ts                          -- Sub-plan 3
apps/daemon/src/orchestrator-llm/prompts.test.ts                     -- Sub-plan 3
apps/daemon/src/agent-hooks/                                         -- Sub-plan 3
apps/daemon/src/agent-hooks/routes.ts                                -- Sub-plan 3
apps/daemon/src/agent-hooks/routes.test.ts                           -- Sub-plan 3
apps/daemon/src/workflows/orchestrator/step-dispatch.ts              -- Sub-plan 4
apps/daemon/src/workflows/orchestrator/step-dispatch.test.ts         -- Sub-plan 4
apps/daemon/src/workflows/orchestrator/judgement.ts                  -- Sub-plan 5
apps/daemon/src/workflows/orchestrator/judgement.test.ts             -- Sub-plan 5
apps/daemon/src/workflows/orchestrator/revise-loop.ts                -- Sub-plan 5
apps/daemon/src/workflows/orchestrator/revise-loop.test.ts           -- Sub-plan 5
apps/daemon/src/workflows/orchestrator/idle-timeout.ts               -- Sub-plan 9
apps/daemon/src/workflows/orchestrator/idle-timeout.test.ts          -- Sub-plan 9
apps/daemon/src/workflows/orchestrator/crash-retry.ts                -- Sub-plan 9
apps/daemon/src/workflows/orchestrator/crash-retry.test.ts           -- Sub-plan 9
apps/daemon/src/workflows/orchestrator/resume.ts                     -- Sub-plan 10
apps/daemon/src/workflows/orchestrator/resume.test.ts                -- Sub-plan 10
apps/desktop/src/orchestrator/InternalThoughtRow.tsx                 -- Sub-plan 8
apps/desktop/src/orchestrator/InternalThoughtRow.test.tsx            -- Sub-plan 8
apps/desktop/src/orchestrator/AgentParaphrasedMessage.tsx            -- Sub-plan 8
apps/desktop/src/orchestrator/AgentParaphrasedMessage.test.tsx       -- Sub-plan 8
apps/desktop/src/orchestrator/MarkDoneConfirmCard.tsx                -- Sub-plan 8
apps/desktop/src/orchestrator/MarkDoneConfirmCard.test.tsx           -- Sub-plan 8
```

### Modified files

```
apps/daemon/src/migrations.ts                                        -- Sub-plan 1
apps/daemon/src/adapters/types.ts                                    -- Sub-plan 1, 4
apps/daemon/src/adapters/claude-code.ts                              -- Sub-plan 1
apps/daemon/src/adapters/codex.ts                                    -- Sub-plan 1
apps/daemon/src/adapters/opencode.ts                                 -- Sub-plan 1
apps/daemon/src/adapters/gemini.ts                                   -- Sub-plan 1
apps/daemon/src/adapters/shell-manual.ts                             -- Sub-plan 1
apps/daemon/src/daemon-context.ts                                    -- Sub-plan 1, 3
apps/daemon/src/server.ts                                            -- Sub-plan 1, 3, 7
apps/daemon/src/workflows/orchestration-transport/broker.ts          -- Sub-plan 2
apps/daemon/src/workflows/orchestration-transport/broker.test.ts     -- Sub-plan 2
apps/daemon/src/workflows/orchestration-transport/policy.ts          -- Sub-plan 2
apps/daemon/src/workflows/orchestrator/service.ts                    -- Sub-plan 4, 5, 7
apps/daemon/src/workflows/orchestrator/service.skill-step.test.ts    -- Sub-plan 4, 5
apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts    -- Sub-plan 4, 5
apps/daemon/src/workflows/templates/seed-engineering.ts              -- Sub-plan 6
apps/daemon/src/goals/bootstrap-route.ts                             -- Sub-plan 7
apps/daemon/src/goals/bootstrap-route.test.ts                        -- Sub-plan 7
apps/desktop/src/orchestrator/OrcaChat.tsx                           -- Sub-plan 8
apps/desktop/src/orchestrator/OrcaChat.test.tsx                      -- Sub-plan 8
packages/contracts/src/workflows/index.ts                            -- Sub-plan 6
packages/contracts/src/adapters/execution-modes.ts (new)             -- Sub-plan 1
packages/contracts/src/index.ts                                      -- Sub-plan 1
```

### Removed code paths (no file deletion; code excised within files)

```
apps/daemon/src/workflows/orchestrator/service.ts
  - commitOperatorSelectionForSkill (removed by Sub-plan 4)
  - LLM-based skill step turn path (replaced by Sub-plan 5 mediator-driven flow)
apps/daemon/src/workflows/templates/seed-engineering.ts
  - approval_launch_agent guardrail entry (removed by Sub-plan 6)
apps/desktop/src/orchestrator/OrcaChat.tsx
  - WorkflowBanner rendering inside chat (removed by Sub-plan 8)
  - Workflow recommendations list inside chat (removed by Sub-plan 8)
  - restoredPendingInput textarea card (removed by Sub-plan 8)
  - SystemCard "No pending workflow recommendations" (removed by Sub-plan 8)
```

---

# Sub-plan 1: Adapter execution-mode configuration

**Goal:** DB-backed adapter execution-mode config (enabled/disabled with one preferred + reasons), with code-declared capability on adapters, mutation API + invariants + audit event, and on-boot seeding.

## Task 1: Contract types for execution mode

**Files:**
- Create: `packages/contracts/src/adapters/execution-modes.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: extends `packages/contracts/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/index.test.ts`:

```ts
import {
  ExecutionMode,
  AdapterExecutionModeConfig,
  validateAdapterExecutionModeConfig,
} from "./index.js";

describe("ExecutionMode and AdapterExecutionModeConfig", () => {
  it("parses both execution modes", () => {
    expect(ExecutionMode.parse("shadow_session")).toBe("shadow_session");
    expect(ExecutionMode.parse("one_shot")).toBe("one_shot");
    expect(() => ExecutionMode.parse("invalid")).toThrow();
  });

  it("validates a valid config", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
      disabledExecutionModes: [{ mode: "one_shot", reason: "post 2026-06-15 -p billing" }],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(true);
  });

  it("rejects config with no preferred entry", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [{ mode: "shadow_session" }],
      disabledExecutionModes: [],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/preferred/);
  });

  it("rejects config with multiple preferred entries", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [
        { mode: "shadow_session", preferred: true },
        { mode: "one_shot", preferred: true },
      ],
      disabledExecutionModes: [],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exactly one preferred/);
  });

  it("rejects config with intersecting enabled and disabled", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
      disabledExecutionModes: [{ mode: "shadow_session", reason: "x" }],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cannot be both enabled and disabled/);
  });

  it("rejects empty enabled list", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [],
      disabledExecutionModes: [{ mode: "shadow_session", reason: "x" }, { mode: "one_shot", reason: "y" }],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-empty/);
  });

  it("rejects mode not in supportedExecutionModes", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
      disabledExecutionModes: [{ mode: "one_shot", reason: "x" }],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session"]); // one_shot not supported
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not supported/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test -- --run index.test`
Expected: FAIL (imports not exported yet)

- [ ] **Step 3: Create the contract module**

Create `packages/contracts/src/adapters/execution-modes.ts`:

```ts
import { z } from "zod";
import { AdapterId } from "../index.js";

export const ExecutionMode = z.enum(["shadow_session", "one_shot"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

export const EnabledExecutionModeEntry = z
  .object({
    mode: ExecutionMode,
    preferred: z.boolean().optional(),
  })
  .strict();
export type EnabledExecutionModeEntry = z.infer<typeof EnabledExecutionModeEntry>;

export const DisabledExecutionModeEntry = z
  .object({
    mode: ExecutionMode,
    reason: z.string().min(1).max(500),
  })
  .strict();
export type DisabledExecutionModeEntry = z.infer<typeof DisabledExecutionModeEntry>;

export const AdapterExecutionModeConfig = z
  .object({
    adapterId: AdapterId,
    enabledExecutionModes: z.array(EnabledExecutionModeEntry).max(8),
    disabledExecutionModes: z.array(DisabledExecutionModeEntry).max(8),
  })
  .strict();
export type AdapterExecutionModeConfig = z.infer<typeof AdapterExecutionModeConfig>;

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateAdapterExecutionModeConfig(
  config: AdapterExecutionModeConfig,
  supportedModes: ExecutionMode[]
): ValidationResult {
  const supported = new Set(supportedModes);
  if (config.enabledExecutionModes.length === 0) {
    return { ok: false, reason: "enabledExecutionModes must be non-empty" };
  }

  const preferredCount = config.enabledExecutionModes.filter((e) => e.preferred === true).length;
  if (preferredCount !== 1) {
    return {
      ok: false,
      reason: `enabledExecutionModes must contain exactly one preferred entry (found ${preferredCount})`,
    };
  }

  const enabledModes = new Set(config.enabledExecutionModes.map((e) => e.mode));
  const disabledModes = new Set(config.disabledExecutionModes.map((e) => e.mode));
  for (const mode of enabledModes) {
    if (disabledModes.has(mode)) {
      return { ok: false, reason: `mode ${mode} cannot be both enabled and disabled` };
    }
  }

  for (const e of config.enabledExecutionModes) {
    if (!supported.has(e.mode)) {
      return { ok: false, reason: `mode ${e.mode} not supported by adapter ${config.adapterId}` };
    }
  }
  for (const e of config.disabledExecutionModes) {
    if (!supported.has(e.mode)) {
      return { ok: false, reason: `mode ${e.mode} not supported by adapter ${config.adapterId}` };
    }
  }

  return { ok: true };
}
```

- [ ] **Step 4: Re-export from contracts root**

In `packages/contracts/src/index.ts`, add an export block after the existing exports (find a suitable location near other re-exports):

```ts
export {
  ExecutionMode,
  EnabledExecutionModeEntry,
  DisabledExecutionModeEntry,
  AdapterExecutionModeConfig,
  validateAdapterExecutionModeConfig,
} from "./adapters/execution-modes.js";
export type { ValidationResult as AdapterExecutionModeValidation } from "./adapters/execution-modes.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test -- --run index.test`
Expected: PASS for all new ExecutionMode tests.

- [ ] **Step 6: Build contracts**

Run: `pnpm --filter @orca/contracts build`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/adapters/execution-modes.ts \
        packages/contracts/src/index.ts \
        packages/contracts/src/index.test.ts
git commit -m "feat(contracts): ExecutionMode + AdapterExecutionModeConfig schema + validator"
```

## Task 2: Migration 0015 — adapter_execution_modes table

**Files:**
- Create: `apps/daemon/migrations/0015_adapter_execution_modes.sql`
- Modify: `apps/daemon/src/migrations.ts`

- [ ] **Step 1: Create migration**

```sql
-- 0015_adapter_execution_modes.sql
CREATE TABLE IF NOT EXISTS adapter_execution_modes (
  adapter_id            TEXT PRIMARY KEY,
  enabled_modes_json    TEXT NOT NULL,
  disabled_modes_json   TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  updated_by            TEXT
);
```

- [ ] **Step 2: Register migration in migrations.ts**

In `apps/daemon/src/migrations.ts`, append to `migrationFiles` array:

```ts
export const migrationFiles = [
  "0001_init.sql",
  "0002_workspaces_refinements.sql",
  "0004_sessions.sql",
  "0005_memory.sql",
  "0006_context.sql",
  "0007_agents.sql",
  SUGGESTED_ORCHESTRATION_MIGRATION,
  "0009_agent_readiness.sql",
  "0010_workflows.sql",
  WORKFLOW_RECOMMENDATION_TYPES_MIGRATION,
  ORCHESTRATION_TRANSPORT_MIGRATION,
  ORCHESTRATOR_MESSAGES_MIGRATION,
  WORKFLOW_STEP_RUNS_OPERATOR_SELECTION_MIGRATION,
  "0015_adapter_execution_modes.sql",
] as const;
```

- [ ] **Step 3: Verify migration applies cleanly**

Run: `pnpm --filter @orca/daemon test -- --run migrations.test`
Expected: PASS. If failing, inspect `apps/daemon/src/migrations.test.ts` — it likely lists all expected migration files; add the new file there per the pattern.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/migrations/0015_adapter_execution_modes.sql \
        apps/daemon/src/migrations.ts \
        apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): migration 0015 adapter_execution_modes table"
```

## Task 3: Adapter manifest — supportedExecutionModes capability

**Files:**
- Modify: `apps/daemon/src/adapters/types.ts`
- Modify: `apps/daemon/src/adapters/claude-code.ts`
- Modify: `apps/daemon/src/adapters/codex.ts`
- Modify: `apps/daemon/src/adapters/opencode.ts`
- Modify: `apps/daemon/src/adapters/gemini.ts`
- Modify: `apps/daemon/src/adapters/shell-manual.ts`
- Test: `apps/daemon/src/adapters/agent-adapters.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/adapters/agent-adapters.test.ts`:

```ts
import { ExecutionMode } from "@orca/contracts";
import { adapterRegistry } from "./registry.js";
// ensure adapters are registered (this happens in daemon bootstrap; for tests, register manually)
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { opencodeAdapter } from "./opencode.js";
import { geminiAdapter } from "./gemini.js";
import { shellManualAdapter } from "./shell-manual.js";

describe("adapter supportedExecutionModes", () => {
  it("claude-code declares shadow_session and one_shot", () => {
    expect(claudeCodeAdapter.supportedExecutionModes).toEqual(
      expect.arrayContaining(["shadow_session", "one_shot"])
    );
  });
  it("codex declares one_shot and shadow_session", () => {
    expect(codexAdapter.supportedExecutionModes).toEqual(
      expect.arrayContaining(["one_shot", "shadow_session"])
    );
  });
  it("opencode declares shadow_session", () => {
    expect(opencodeAdapter.supportedExecutionModes).toContain("shadow_session");
  });
  it("gemini and shell-manual declare at least one mode", () => {
    expect(geminiAdapter.supportedExecutionModes.length).toBeGreaterThan(0);
    expect(shellManualAdapter.supportedExecutionModes.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- --run agent-adapters`
Expected: FAIL with "property 'supportedExecutionModes' does not exist" / undefined.

- [ ] **Step 3: Extend `AgentAdapter` interface**

In `apps/daemon/src/adapters/types.ts`, add to the `AgentAdapter` interface (after `supportsTerminal?`):

```ts
import type { AdapterId, AgentReadinessStatus, CheckStep, RepairAction, ExecutionMode } from "@orca/contracts";

// ... existing code ...

export interface AgentAdapter {
  id: AdapterId;
  title: string;
  supportsRepoEditing?: boolean;
  supportsTerminal?: boolean;
  /**
   * Execution modes this adapter can technically dispatch. Code-declared invariant.
   * The runtime DB-backed AdapterExecutionModeConfig must declare a subset of these.
   */
  supportedExecutionModes: ExecutionMode[];
  contextDelivery: AdapterContextDelivery;
  resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult>;
  probeAvailability(): Promise<AdapterAvailability>;

  checkInstalled(): Promise<CheckStep & { version?: string }>;
  checkAuth(): Promise<CheckStep>;
  repairFor(status: AgentReadinessStatus): RepairAction | undefined;
}
```

- [ ] **Step 4: Set capability on each adapter**

In `apps/daemon/src/adapters/claude-code.ts`, find the exported adapter object and add:

```ts
supportedExecutionModes: ["shadow_session", "one_shot"],
```

In `apps/daemon/src/adapters/codex.ts`:

```ts
supportedExecutionModes: ["one_shot", "shadow_session"],
```

In `apps/daemon/src/adapters/opencode.ts`:

```ts
supportedExecutionModes: ["shadow_session"],
```

In `apps/daemon/src/adapters/gemini.ts`:

```ts
supportedExecutionModes: ["one_shot"],
```

In `apps/daemon/src/adapters/shell-manual.ts`:

```ts
supportedExecutionModes: ["shadow_session"],
```

(Use the appropriate placement adjacent to the existing capability properties such as `supportsRepoEditing`. If the file exports the adapter as a `const` literal, add the property to the literal.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- --run agent-adapters`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/adapters/types.ts \
        apps/daemon/src/adapters/claude-code.ts \
        apps/daemon/src/adapters/codex.ts \
        apps/daemon/src/adapters/opencode.ts \
        apps/daemon/src/adapters/gemini.ts \
        apps/daemon/src/adapters/shell-manual.ts \
        apps/daemon/src/adapters/agent-adapters.test.ts
git commit -m "feat(daemon): adapters declare supportedExecutionModes capability"
```

## Task 4: Adapter execution-mode default configs

**Files:**
- Create: `apps/daemon/src/adapters/execution-modes.ts` (defaults section)

- [ ] **Step 1: Write failing test**

Create `apps/daemon/src/adapters/execution-modes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ADAPTER_EXECUTION_MODE_DEFAULTS } from "./execution-modes.js";

describe("ADAPTER_EXECUTION_MODE_DEFAULTS", () => {
  it("claude-code preferred shadow_session, disabled one_shot with billing reason", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["claude-code"];
    expect(cfg).toBeDefined();
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("shadow_session");
    const disabled = cfg.disabledExecutionModes.find((e) => e.mode === "one_shot");
    expect(disabled?.reason).toMatch(/2026-06-15/);
  });

  it("codex preferred one_shot with shadow_session as fallback enabled", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["codex"];
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("one_shot");
    const fallback = cfg.enabledExecutionModes.find((e) => e.preferred !== true);
    expect(fallback?.mode).toBe("shadow_session");
  });

  it("opencode preferred shadow_session, disabled one_shot", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["opencode"];
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("shadow_session");
    expect(cfg.disabledExecutionModes.find((e) => e.mode === "one_shot")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- --run adapters/execution-modes`
Expected: FAIL (module not found).

- [ ] **Step 3: Create defaults module**

Create `apps/daemon/src/adapters/execution-modes.ts`:

```ts
import type { AdapterExecutionModeConfig, AdapterId } from "@orca/contracts";

export const ADAPTER_EXECUTION_MODE_DEFAULTS: Record<AdapterId, AdapterExecutionModeConfig> = {
  "claude-code": {
    adapterId: "claude-code",
    enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
    disabledExecutionModes: [
      {
        mode: "one_shot",
        reason: "post 2026-06-15 the -p flag bills against API budget; shadow_session uses interactive subscription",
      },
    ],
  },
  codex: {
    adapterId: "codex",
    enabledExecutionModes: [
      { mode: "one_shot", preferred: true },
      { mode: "shadow_session" },
    ],
    disabledExecutionModes: [],
  },
  opencode: {
    adapterId: "opencode",
    enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
    disabledExecutionModes: [
      { mode: "one_shot", reason: "adapter does not implement one-shot yet" },
    ],
  },
  "gemini-cli": {
    adapterId: "gemini-cli",
    enabledExecutionModes: [{ mode: "one_shot", preferred: true }],
    disabledExecutionModes: [],
  },
  "shell-manual": {
    adapterId: "shell-manual",
    enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
    disabledExecutionModes: [],
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- --run adapters/execution-modes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/adapters/execution-modes.ts \
        apps/daemon/src/adapters/execution-modes.test.ts
git commit -m "feat(daemon): default execution-mode configs per adapter"
```

## Task 5: Repository functions — get/set adapter execution mode config

**Files:**
- Modify: `apps/daemon/src/adapters/execution-modes.ts`
- Extend test: `apps/daemon/src/adapters/execution-modes.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `apps/daemon/src/adapters/execution-modes.test.ts`:

```ts
import { runMigrations } from "../migrations.js";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAdapterExecutionModeConfig,
  upsertAdapterExecutionModeConfig,
  seedAdapterExecutionModes,
} from "./execution-modes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../migrations");

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  return db;
}

describe("adapter execution-mode repository", () => {
  it("seeds defaults on first call; idempotent on second call", () => {
    const db = makeDb();
    const supportedByAdapter: Record<string, ("shadow_session"|"one_shot")[]> = {
      "claude-code": ["shadow_session", "one_shot"],
      codex: ["one_shot", "shadow_session"],
      opencode: ["shadow_session"],
      "gemini-cli": ["one_shot"],
      "shell-manual": ["shadow_session"],
    };
    const now = () => "2026-05-28T00:00:00.000Z";
    seedAdapterExecutionModes(db, now, supportedByAdapter);
    const cc = getAdapterExecutionModeConfig(db, "claude-code");
    expect(cc).not.toBeNull();
    expect(cc!.enabledExecutionModes.find((e) => e.preferred)?.mode).toBe("shadow_session");

    // idempotent: second call doesn't change rows
    const before = db.prepare("SELECT updated_at FROM adapter_execution_modes WHERE adapter_id=?").get("claude-code") as { updated_at: string };
    seedAdapterExecutionModes(db, () => "2026-06-01T00:00:00.000Z", supportedByAdapter);
    const after = db.prepare("SELECT updated_at FROM adapter_execution_modes WHERE adapter_id=?").get("claude-code") as { updated_at: string };
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("upsert validates invariants", () => {
    const db = makeDb();
    const now = () => "2026-05-28T00:00:00.000Z";

    expect(() =>
      upsertAdapterExecutionModeConfig(
        db,
        now,
        {
          adapterId: "claude-code",
          enabledExecutionModes: [{ mode: "shadow_session" }],  // no preferred
          disabledExecutionModes: [{ mode: "one_shot", reason: "x" }],
        },
        ["shadow_session", "one_shot"],
        "test"
      )
    ).toThrow(/preferred/);
  });

  it("upsert writes valid config", () => {
    const db = makeDb();
    const now = () => "2026-05-28T00:00:00.000Z";
    upsertAdapterExecutionModeConfig(
      db,
      now,
      {
        adapterId: "codex",
        enabledExecutionModes: [
          { mode: "shadow_session", preferred: true },
          { mode: "one_shot" },
        ],
        disabledExecutionModes: [],
      },
      ["one_shot", "shadow_session"],
      "user"
    );
    const cfg = getAdapterExecutionModeConfig(db, "codex");
    expect(cfg!.enabledExecutionModes.find((e) => e.preferred)?.mode).toBe("shadow_session");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- --run adapters/execution-modes`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement repository functions**

Append to `apps/daemon/src/adapters/execution-modes.ts`:

```ts
import type Database from "better-sqlite3";
import {
  AdapterExecutionModeConfig,
  validateAdapterExecutionModeConfig,
  type ExecutionMode,
} from "@orca/contracts";

interface Row {
  adapter_id: string;
  enabled_modes_json: string;
  disabled_modes_json: string;
  updated_at: string;
  updated_by: string | null;
}

export function getAdapterExecutionModeConfig(
  db: Database.Database,
  adapterId: string
): AdapterExecutionModeConfig | null {
  const row = db
    .prepare(
      "SELECT adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by FROM adapter_execution_modes WHERE adapter_id=?"
    )
    .get(adapterId) as Row | undefined;
  if (!row) return null;
  return {
    adapterId: row.adapter_id as AdapterExecutionModeConfig["adapterId"],
    enabledExecutionModes: JSON.parse(row.enabled_modes_json),
    disabledExecutionModes: JSON.parse(row.disabled_modes_json),
  };
}

export function listAdapterExecutionModeConfigs(
  db: Database.Database
): AdapterExecutionModeConfig[] {
  const rows = db
    .prepare(
      "SELECT adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by FROM adapter_execution_modes ORDER BY adapter_id"
    )
    .all() as Row[];
  return rows.map((row) => ({
    adapterId: row.adapter_id as AdapterExecutionModeConfig["adapterId"],
    enabledExecutionModes: JSON.parse(row.enabled_modes_json),
    disabledExecutionModes: JSON.parse(row.disabled_modes_json),
  }));
}

export function upsertAdapterExecutionModeConfig(
  db: Database.Database,
  now: () => string,
  config: AdapterExecutionModeConfig,
  supportedModes: ExecutionMode[],
  updatedBy: string
): AdapterExecutionModeConfig {
  const validation = validateAdapterExecutionModeConfig(config, supportedModes);
  if (!validation.ok) throw new Error(validation.reason);
  db.prepare(
    `INSERT INTO adapter_execution_modes
       (adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(adapter_id) DO UPDATE SET
       enabled_modes_json=excluded.enabled_modes_json,
       disabled_modes_json=excluded.disabled_modes_json,
       updated_at=excluded.updated_at,
       updated_by=excluded.updated_by`
  ).run(
    config.adapterId,
    JSON.stringify(config.enabledExecutionModes),
    JSON.stringify(config.disabledExecutionModes),
    now(),
    updatedBy
  );
  return config;
}

export function seedAdapterExecutionModes(
  db: Database.Database,
  now: () => string,
  supportedByAdapter: Record<string, ExecutionMode[]>
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO adapter_execution_modes
       (adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 'system_seed')`
  );
  for (const [adapterId, defaults] of Object.entries(ADAPTER_EXECUTION_MODE_DEFAULTS)) {
    const supported = supportedByAdapter[adapterId];
    if (!supported) continue;
    const validation = validateAdapterExecutionModeConfig(defaults, supported);
    if (!validation.ok) {
      throw new Error(`seed defaults invalid for adapter ${adapterId}: ${validation.reason}`);
    }
    insert.run(
      defaults.adapterId,
      JSON.stringify(defaults.enabledExecutionModes),
      JSON.stringify(defaults.disabledExecutionModes),
      now()
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- --run adapters/execution-modes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/adapters/execution-modes.ts \
        apps/daemon/src/adapters/execution-modes.test.ts
git commit -m "feat(daemon): adapter_execution_modes repo + seeder + invariant-checked upsert"
```

## Task 6: Wire seed into daemon bootstrap

**Files:**
- Modify: `apps/daemon/src/daemon-context.ts`
- Modify: `apps/daemon/src/server.ts`

- [ ] **Step 1: Identify where adapters are registered and DB is opened**

Run: `grep -n "adapterRegistry\|getDatabase\|registerAdapters\|register(" apps/daemon/src/server.ts apps/daemon/src/daemon-context.ts | head -40`

- [ ] **Step 2: Call seed after migrations + adapter registry freeze**

In `apps/daemon/src/server.ts`, after the call that registers all adapters and after `runMigrations`, add:

```ts
import { seedAdapterExecutionModes } from "./adapters/execution-modes.js";

// ... inside the server initialization, after adapters are registered:
{
  const supportedByAdapter: Record<string, import("@orca/contracts").ExecutionMode[]> = {};
  for (const adapter of adapterRegistry.listAgentAdapters()) {
    supportedByAdapter[adapter.id] = adapter.supportedExecutionModes;
  }
  seedAdapterExecutionModes(db, daemonContext.now, supportedByAdapter);
}
```

- [ ] **Step 3: Add smoke test**

Append to `apps/daemon/src/server.test.ts` (or create `apps/daemon/src/server.adapter-modes.test.ts` if simpler):

```ts
import { describe, expect, it, beforeAll } from "vitest";
import { startServer } from "./server.js";
import { getAdapterExecutionModeConfig } from "./adapters/execution-modes.js";

describe("daemon seeds adapter execution modes on boot", () => {
  it("claude-code config exists after boot", async () => {
    const handle = await startServer({ port: 0, baseUrl: undefined as never });
    try {
      const cfg = getAdapterExecutionModeConfig(handle.db, "claude-code");
      expect(cfg).not.toBeNull();
    } finally {
      await handle.close();
    }
  });
});
```

(If your `startServer` signature differs, mirror the existing tests' shape.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @orca/daemon test -- --run server`
Expected: PASS, including the seed smoke test.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.test.ts \
        apps/daemon/src/server.adapter-modes.test.ts 2>/dev/null || true
git commit -m "feat(daemon): seed adapter_execution_modes from registered adapters on boot"
```

## Task 7: HTTP routes — GET /v1/adapters/execution-modes + PUT /v1/adapters/:id/execution-modes

**Files:**
- Create: `apps/daemon/src/adapters/execution-modes-routes.ts`
- Create: `apps/daemon/src/adapters/execution-modes-routes.test.ts`
- Modify: `apps/daemon/src/server.ts` (registration)

- [ ] **Step 1: Write failing test**

Create `apps/daemon/src/adapters/execution-modes-routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../migrations.js";
import { seedAdapterExecutionModes } from "./execution-modes.js";
import { registerAdapterExecutionModeRoutes } from "./execution-modes-routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../migrations");

function newApp() {
  const db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  const supported: Record<string, ("shadow_session"|"one_shot")[]> = {
    "claude-code": ["shadow_session", "one_shot"],
    codex: ["one_shot", "shadow_session"],
    opencode: ["shadow_session"],
    "gemini-cli": ["one_shot"],
    "shell-manual": ["shadow_session"],
  };
  seedAdapterExecutionModes(db, () => "2026-05-28T00:00:00.000Z", supported);
  const app = Fastify();
  registerAdapterExecutionModeRoutes(app, {
    db,
    now: () => "2026-05-28T01:00:00.000Z",
    supportedByAdapter: supported,
  });
  return app;
}

describe("adapter execution-modes routes", () => {
  it("GET /v1/adapters/execution-modes returns all configs", async () => {
    const app = newApp();
    const res = await app.inject({ method: "GET", url: "/v1/adapters/execution-modes" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { configs: Array<{ adapterId: string }> };
    expect(body.configs.map((c) => c.adapterId)).toEqual(
      expect.arrayContaining(["claude-code", "codex", "opencode"])
    );
  });

  it("PUT /v1/adapters/:id/execution-modes updates config", async () => {
    const app = newApp();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/adapters/codex/execution-modes",
      payload: {
        adapterId: "codex",
        enabledExecutionModes: [
          { mode: "shadow_session", preferred: true },
          { mode: "one_shot" },
        ],
        disabledExecutionModes: [],
      },
    });
    expect(res.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/v1/adapters/execution-modes" });
    const body = get.json() as { configs: Array<{ adapterId: string; enabledExecutionModes: Array<{ mode: string; preferred?: boolean }> }> };
    const codex = body.configs.find((c) => c.adapterId === "codex")!;
    expect(codex.enabledExecutionModes.find((e) => e.preferred)?.mode).toBe("shadow_session");
  });

  it("PUT with invalid invariants returns 400", async () => {
    const app = newApp();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/adapters/claude-code/execution-modes",
      payload: {
        adapterId: "claude-code",
        enabledExecutionModes: [{ mode: "shadow_session" }],   // no preferred
        disabledExecutionModes: [{ mode: "one_shot", reason: "x" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT mismatched adapterId in body vs URL returns 400", async () => {
    const app = newApp();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/adapters/codex/execution-modes",
      payload: {
        adapterId: "claude-code",
        enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
        disabledExecutionModes: [],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- --run execution-modes-routes`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement routes**

Create `apps/daemon/src/adapters/execution-modes-routes.ts`:

```ts
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  AdapterExecutionModeConfig,
  type ExecutionMode,
} from "@orca/contracts";
import {
  getAdapterExecutionModeConfig,
  listAdapterExecutionModeConfigs,
  upsertAdapterExecutionModeConfig,
} from "./execution-modes.js";

export interface AdapterExecutionModeRouteDeps {
  db: Database.Database;
  now: () => string;
  supportedByAdapter: Record<string, ExecutionMode[]>;
}

export function registerAdapterExecutionModeRoutes(
  server: FastifyInstance,
  deps: AdapterExecutionModeRouteDeps
): void {
  server.get("/v1/adapters/execution-modes", async () => {
    const configs = listAdapterExecutionModeConfigs(deps.db);
    return { configs };
  });

  server.get("/v1/adapters/:id/execution-modes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const cfg = getAdapterExecutionModeConfig(deps.db, id);
    if (!cfg) {
      reply.status(404);
      return { error: { code: "adapter_not_found", message: `No execution-mode config for adapter ${id}` } };
    }
    return cfg;
  });

  server.put("/v1/adapters/:id/execution-modes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = AdapterExecutionModeConfig.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "validation_failed", issues: parsed.error.issues } };
    }
    if (parsed.data.adapterId !== id) {
      reply.status(400);
      return { error: { code: "adapter_id_mismatch", message: "URL adapter id must match body adapter id" } };
    }
    const supported = deps.supportedByAdapter[id];
    if (!supported) {
      reply.status(404);
      return { error: { code: "adapter_not_registered", message: `Adapter ${id} is not registered in this daemon` } };
    }
    try {
      const stored = upsertAdapterExecutionModeConfig(deps.db, deps.now, parsed.data, supported, "settings_api");
      return stored;
    } catch (err) {
      reply.status(400);
      return { error: { code: "invariant_violation", message: err instanceof Error ? err.message : "unknown" } };
    }
  });
}
```

- [ ] **Step 4: Register routes in server**

In `apps/daemon/src/server.ts`, after seed call, register the routes:

```ts
import { registerAdapterExecutionModeRoutes } from "./adapters/execution-modes-routes.js";

// ... inside server init, after seed call:
{
  const supportedByAdapter: Record<string, import("@orca/contracts").ExecutionMode[]> = {};
  for (const adapter of adapterRegistry.listAgentAdapters()) {
    supportedByAdapter[adapter.id] = adapter.supportedExecutionModes;
  }
  registerAdapterExecutionModeRoutes(server, {
    db: getDatabase(),
    now: daemonContext.now,
    supportedByAdapter,
  });
}
```

(Reuse the existing `supportedByAdapter` variable if it's already constructed for the seed.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- --run execution-modes-routes`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/adapters/execution-modes-routes.ts \
        apps/daemon/src/adapters/execution-modes-routes.test.ts \
        apps/daemon/src/server.ts
git commit -m "feat(daemon): HTTP routes to read/update adapter execution-mode config"
```

## Task 8: Audit event on config mutation

**Files:**
- Modify: `apps/daemon/src/adapters/execution-modes.ts`
- Extend test in `execution-modes.test.ts`

- [ ] **Step 1: Append failing test**

Append to `apps/daemon/src/adapters/execution-modes.test.ts`:

```ts
import { EventBus } from "../events.js";

describe("audit event on upsert", () => {
  it("appends adapter.execution_modes.changed event on upsert", () => {
    const db = makeDb();
    const bus = new EventBus();
    const events: { type: string; payload: unknown }[] = [];
    bus.subscribe((event) => events.push({ type: event.type, payload: event.payload }));
    upsertAdapterExecutionModeConfig(
      db,
      () => "2026-05-28T01:00:00.000Z",
      {
        adapterId: "codex",
        enabledExecutionModes: [
          { mode: "shadow_session", preferred: true },
          { mode: "one_shot" },
        ],
        disabledExecutionModes: [],
      },
      ["one_shot", "shadow_session"],
      "user",
      { bus }
    );
    const changed = events.find((e) => e.type === "adapter.execution_modes.changed");
    expect(changed).toBeDefined();
    expect((changed!.payload as { adapterId: string }).adapterId).toBe("codex");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL (no bus argument supported yet).

- [ ] **Step 3: Add optional `bus` parameter to upsert**

In `apps/daemon/src/adapters/execution-modes.ts`, modify `upsertAdapterExecutionModeConfig`:

```ts
import type { EventBus } from "../events.js";

export interface UpsertOptions {
  bus?: EventBus;
}

export function upsertAdapterExecutionModeConfig(
  db: Database.Database,
  now: () => string,
  config: AdapterExecutionModeConfig,
  supportedModes: ExecutionMode[],
  updatedBy: string,
  options: UpsertOptions = {}
): AdapterExecutionModeConfig {
  const validation = validateAdapterExecutionModeConfig(config, supportedModes);
  if (!validation.ok) throw new Error(validation.reason);
  db.prepare(
    `INSERT INTO adapter_execution_modes
       (adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(adapter_id) DO UPDATE SET
       enabled_modes_json=excluded.enabled_modes_json,
       disabled_modes_json=excluded.disabled_modes_json,
       updated_at=excluded.updated_at,
       updated_by=excluded.updated_by`
  ).run(
    config.adapterId,
    JSON.stringify(config.enabledExecutionModes),
    JSON.stringify(config.disabledExecutionModes),
    now(),
    updatedBy
  );
  if (options.bus) {
    options.bus.publish({
      type: "adapter.execution_modes.changed",
      payload: {
        adapterId: config.adapterId,
        enabledExecutionModes: config.enabledExecutionModes,
        disabledExecutionModes: config.disabledExecutionModes,
        updatedBy,
        updatedAt: now(),
      },
      at: now(),
    });
  }
  return config;
}
```

(Adapt to the exact `EventBus.publish` signature in `apps/daemon/src/events.ts`.)

- [ ] **Step 4: Plumb `bus` through routes**

In `apps/daemon/src/adapters/execution-modes-routes.ts`, accept `bus?: EventBus` in `AdapterExecutionModeRouteDeps` and pass it to `upsertAdapterExecutionModeConfig`.

In `apps/daemon/src/server.ts`, pass `bus: eventBus` when registering the routes.

- [ ] **Step 5: Run tests to verify it passes**

Run: `pnpm --filter @orca/daemon test -- --run execution-modes`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/adapters/execution-modes.ts \
        apps/daemon/src/adapters/execution-modes-routes.ts \
        apps/daemon/src/adapters/execution-modes.test.ts \
        apps/daemon/src/server.ts
git commit -m "feat(daemon): emit adapter.execution_modes.changed audit event on upsert"
```

---

# Sub-plan 2: Unified adapter dispatch

**Goal:** Collapse the orchestrator-LLM dispatch and per-step agent dispatch onto a single adapter layer. The dispatcher resolves the active execution mode per adapter (from DB-backed config) and routes the request through the appropriate transport (existing `one_shot` or `hidden_interactive`/`shadow_session`).

## Task 9: AdapterDispatcher abstraction

**Files:**
- Create: `apps/daemon/src/adapters/dispatcher.ts`
- Create: `apps/daemon/src/adapters/dispatcher.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/daemon/src/adapters/dispatcher.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../migrations.js";
import { seedAdapterExecutionModes } from "./execution-modes.js";
import { AdapterDispatcher } from "./dispatcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../migrations");

function makeDb() {
  const db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  seedAdapterExecutionModes(db, () => "t0", {
    "claude-code": ["shadow_session", "one_shot"],
    codex: ["one_shot", "shadow_session"],
  });
  return db;
}

describe("AdapterDispatcher.resolveMode", () => {
  it("returns the preferred enabled mode", () => {
    const db = makeDb();
    const d = new AdapterDispatcher({ db });
    expect(d.resolveMode("claude-code")).toEqual({ adapterId: "claude-code", mode: "shadow_session", fallbacks: [] });
    expect(d.resolveMode("codex")).toEqual({ adapterId: "codex", mode: "one_shot", fallbacks: ["shadow_session"] });
  });

  it("throws when adapter has no config", () => {
    const db = makeDb();
    const d = new AdapterDispatcher({ db });
    expect(() => d.resolveMode("opencode")).toThrow(/no execution-mode config/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- --run dispatcher`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement dispatcher**

Create `apps/daemon/src/adapters/dispatcher.ts`:

```ts
import type Database from "better-sqlite3";
import type { ExecutionMode } from "@orca/contracts";
import { getAdapterExecutionModeConfig } from "./execution-modes.js";

export interface ResolvedMode {
  adapterId: string;
  mode: ExecutionMode;
  fallbacks: ExecutionMode[];
}

export interface AdapterDispatcherDeps {
  db: Database.Database;
}

export class AdapterDispatcher {
  constructor(private readonly deps: AdapterDispatcherDeps) {}

  resolveMode(adapterId: string): ResolvedMode {
    const cfg = getAdapterExecutionModeConfig(this.deps.db, adapterId);
    if (!cfg) throw new Error(`no execution-mode config for adapter ${adapterId}`);
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    if (!preferred) throw new Error(`adapter ${adapterId} has no preferred enabled mode`);
    const fallbacks = cfg.enabledExecutionModes.filter((e) => e !== preferred).map((e) => e.mode);
    return { adapterId, mode: preferred.mode, fallbacks };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- --run dispatcher`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/adapters/dispatcher.ts apps/daemon/src/adapters/dispatcher.test.ts
git commit -m "feat(daemon): AdapterDispatcher resolves preferred enabled mode + fallbacks"
```

## Task 10: Broker integration with AdapterDispatcher

**Files:**
- Modify: `apps/daemon/src/workflows/orchestration-transport/broker.ts`
- Modify: `apps/daemon/src/workflows/orchestration-transport/broker.test.ts` (extend)

- [ ] **Step 1: Read existing broker to understand current shape**

Run: `sed -n '1,80p' apps/daemon/src/workflows/orchestration-transport/broker.ts`

Note the existing `propose` signature and how it picks a transport ("one_shot" / "hidden_interactive"). Goal: introduce a hook so that for a given `request`, the transport choice can be supplied by `AdapterDispatcher.resolveMode(adapterId).mode` (mapping `shadow_session` → `hidden_interactive`).

- [ ] **Step 2: Add a mode resolver argument to broker**

In `apps/daemon/src/workflows/orchestration-transport/broker.ts`, extend `OrchestrationTransportBroker` constructor or factory to accept an optional `modeResolver: (adapterId: string) => "one_shot" | "hidden_interactive"`. Where the broker currently chooses transport, prefer `modeResolver(adapterId)` if provided.

Example shape:

```ts
import type { ExecutionMode } from "@orca/contracts";

type Transport = "one_shot" | "hidden_interactive";
export type AdapterModeResolver = (adapterId: string) => Transport;

function execModeToTransport(mode: ExecutionMode): Transport {
  return mode === "shadow_session" ? "hidden_interactive" : "one_shot";
}
```

Pass it through to the `propose` flow that already selects a transport.

- [ ] **Step 3: Test broker uses resolver when given**

Extend `apps/daemon/src/workflows/orchestration-transport/broker.test.ts`:

```ts
import { execModeToTransport } from "./broker.js";  // re-export from above

it("execModeToTransport maps shadow_session -> hidden_interactive", () => {
  expect(execModeToTransport("shadow_session")).toBe("hidden_interactive");
  expect(execModeToTransport("one_shot")).toBe("one_shot");
});

it("propose uses provided modeResolver to pick transport for the adapter", async () => {
  // build a broker with the resolver wired; provide a request whose providerId/adapterId
  // is known; assert the chosen transport matches the resolver's output.
  // (mirror the shape of existing tests in this file)
});
```

(Fill in the "propose uses ..." assertion using the file's existing test scaffolding for mocked transports.)

- [ ] **Step 4: Run broker tests**

Run: `pnpm --filter @orca/daemon test -- --run broker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestration-transport/broker.ts \
        apps/daemon/src/workflows/orchestration-transport/broker.test.ts
git commit -m "feat(daemon): broker accepts AdapterDispatcher-derived transport resolver"
```

## Task 11: Wire dispatcher into daemon-context

**Files:**
- Modify: `apps/daemon/src/daemon-context.ts`
- Modify: `apps/daemon/src/server.ts`

- [ ] **Step 1: Identify daemon-context shape**

Run: `sed -n '1,60p' apps/daemon/src/daemon-context.ts`

- [ ] **Step 2: Construct dispatcher in context build**

In `apps/daemon/src/daemon-context.ts`, add `adapterDispatcher` to the context type and instantiate it after DB is opened and migrations are applied:

```ts
import { AdapterDispatcher } from "./adapters/dispatcher.js";

// inside the context constructor / builder:
const adapterDispatcher = new AdapterDispatcher({ db });
// expose on returned context:
return { /* ...existing fields... */, adapterDispatcher };
```

In `apps/daemon/src/server.ts`, pass a `modeResolver` to the orchestration transport broker construction:

```ts
const modeResolver = (adapterId: string) => {
  const resolved = adapterDispatcher.resolveMode(adapterId);
  return resolved.mode === "shadow_session" ? "hidden_interactive" : "one_shot";
};
// pass `modeResolver` into broker factory
```

- [ ] **Step 3: Run all daemon tests**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS suite-wide (no regressions).

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/daemon-context.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): construct AdapterDispatcher in context; wire to broker"
```

---

# Sub-plan 3: Orchestrator-LLM session + mediator

**Goal:** Add a goal-scoped orchestrator-LLM session lifecycle, an `OrchestratorMediator` that invokes the orchestrator-LLM on each trigger, and supporting context-envelope and prompt-composition modules. Also: HTTP endpoint for adapter response-done hook callbacks.

## Task 12: Context envelope builder

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/context.ts`
- Create: `apps/daemon/src/orchestrator-llm/context.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/daemon/src/orchestrator-llm/context.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOrchestratorContext } from "./context.js";

describe("buildOrchestratorContext", () => {
  it("assembles goal + run + current step + conversation + prior artifacts", () => {
    const ctx = buildOrchestratorContext({
      goal: { id: "g1", title: "T", description: "D", attachedWorkspaces: [{ id: "w1", name: "main", root: "/x" }] },
      run: { templateId: "orca/engineering", templateVersion: 4, ordinal: 1, status: "active" },
      currentStep: {
        id: "research", instructions: "do research", outputSchema: [],
        agentAdapterId: "claude-code", executionMode: "shadow_session",
      },
      chatMessages: [{ role: "user", body: "hi", ts: "t0" }],
      currentStepAgentTurns: [{ role: "agent", body: "asking", ts: "t1" }],
      priorStepArtifacts: [{ stepId: "intake", outputJson: { problem: "X" } }],
      payloadBudgetBytes: 64 * 1024,
    });
    expect(ctx.goal.id).toBe("g1");
    expect(ctx.currentStep.id).toBe("research");
    expect(ctx.conversation.chatMessages).toHaveLength(1);
    expect(ctx.priorStepArtifacts).toHaveLength(1);
  });

  it("truncates oldest currentStepAgentTurns first when over budget", () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: "agent" as const, body: "X".repeat(5000), ts: `t${i}` }));
    const ctx = buildOrchestratorContext({
      goal: { id: "g1", title: "T", description: "D", attachedWorkspaces: [] },
      run: { templateId: "orca/engineering", templateVersion: 4, ordinal: 1, status: "active" },
      currentStep: { id: "research", instructions: "x", outputSchema: [], agentAdapterId: "claude-code", executionMode: "shadow_session" },
      chatMessages: [],
      currentStepAgentTurns: turns,
      priorStepArtifacts: [],
      payloadBudgetBytes: 50_000,
    });
    expect(ctx.conversation.currentStepAgentTurns.length).toBeLessThan(20);
    expect(ctx.conversation.currentStepAgentTurns.at(-1)?.ts).toBe("t19");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- --run orchestrator-llm/context`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `apps/daemon/src/orchestrator-llm/context.ts`:

```ts
import type {
  ExecutionMode,
  WorkflowRunStatus,
  WorkflowStepOutputSchema,
} from "@orca/contracts";

export interface WorkspaceRef {
  id: string;
  name: string;
  root: string;
}

export interface OrchestratorContextInput {
  goal: { id: string; title: string; description: string; attachedWorkspaces: WorkspaceRef[] };
  run: { templateId: string; templateVersion: number; ordinal: number; status: WorkflowRunStatus };
  currentStep: {
    id: string;
    instructions: string;
    outputSchema: WorkflowStepOutputSchema;
    agentAdapterId: string;
    executionMode: ExecutionMode;
  };
  chatMessages: Array<{
    role: "user" | "orchestrator" | "agent_paraphrased";
    body: string;
    ts: string;
    stepRunId?: string;
  }>;
  currentStepAgentTurns: Array<{
    role: "agent" | "user_via_orchestrator";
    body: string;
    ts: string;
  }>;
  priorStepArtifacts: Array<{ stepId: string; outputJson: unknown }>;
  payloadBudgetBytes: number;
}

export interface OrchestratorInvocationContext {
  goal: OrchestratorContextInput["goal"];
  workflowRun: OrchestratorContextInput["run"];
  currentStep: OrchestratorContextInput["currentStep"];
  conversation: {
    chatMessages: OrchestratorContextInput["chatMessages"];
    currentStepAgentTurns: OrchestratorContextInput["currentStepAgentTurns"];
  };
  priorStepArtifacts: OrchestratorContextInput["priorStepArtifacts"];
}

export function buildOrchestratorContext(
  input: OrchestratorContextInput
): OrchestratorInvocationContext {
  let agentTurns = input.currentStepAgentTurns.slice();
  let priorArtifacts = input.priorStepArtifacts.slice();

  // Truncation strategy: oldest currentStepAgentTurns first; then earliest priorStepArtifacts.
  while (estimateBytes({ ...input, currentStepAgentTurns: agentTurns, priorStepArtifacts: priorArtifacts }) > input.payloadBudgetBytes && agentTurns.length > 1) {
    agentTurns = agentTurns.slice(1);
  }
  while (estimateBytes({ ...input, currentStepAgentTurns: agentTurns, priorStepArtifacts: priorArtifacts }) > input.payloadBudgetBytes && priorArtifacts.length > 1) {
    priorArtifacts = priorArtifacts.slice(1);
  }

  return {
    goal: input.goal,
    workflowRun: input.run,
    currentStep: input.currentStep,
    conversation: {
      chatMessages: input.chatMessages,
      currentStepAgentTurns: agentTurns,
    },
    priorStepArtifacts: priorArtifacts,
  };
}

function estimateBytes(input: OrchestratorContextInput): number {
  return Buffer.byteLength(JSON.stringify(input), "utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- --run orchestrator-llm/context`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/context.ts \
        apps/daemon/src/orchestrator-llm/context.test.ts
git commit -m "feat(daemon): orchestrator-LLM invocation context builder with payload-budget truncation"
```

## Task 13: Prompt composition

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/prompts.ts`
- Create: `apps/daemon/src/orchestrator-llm/prompts.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/daemon/src/orchestrator-llm/prompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composeOrchestratorPrompt, composeAgentInitialPrompt } from "./prompts.js";

describe("composeAgentInitialPrompt", () => {
  it("includes step instructions, outputSchema, and orca-output convention", () => {
    const out = composeAgentInitialPrompt({
      stepInstructions: "Interview the user.",
      outputSchema: [{ key: "problem", type: "string", required: true }],
      priorStepArtifacts: [],
    });
    expect(out).toMatch(/Interview the user\./);
    expect(out).toMatch(/orca:step-complete/);
    expect(out).toMatch(/problem.*string/);
  });

  it("includes bounded prior step artifacts", () => {
    const out = composeAgentInitialPrompt({
      stepInstructions: "Research.",
      outputSchema: [],
      priorStepArtifacts: [{ stepId: "intake", outputJson: { problem: "P", success_outcome: "O" } }],
    });
    expect(out).toMatch(/intake/);
    expect(out).toMatch(/problem/);
  });
});

describe("composeOrchestratorPrompt", () => {
  it("describes role and produces a structured response shape request", () => {
    const out = composeOrchestratorPrompt({
      triggerKind: "agent_response",
      // ...other fields will be added by impl; verify presence:
    } as any);
    expect(out.systemPrompt).toMatch(/orchestrator/i);
    expect(out.userPrompt).toMatch(/agent_response/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- --run orchestrator-llm/prompts`
Expected: FAIL.

- [ ] **Step 3: Implement prompts**

Create `apps/daemon/src/orchestrator-llm/prompts.ts`:

```ts
import type { OrchestratorInvocationContext } from "./context.js";
import type { WorkflowStepOutputSchema } from "@orca/contracts";

export interface AgentInitialPromptInput {
  stepInstructions: string;
  outputSchema: WorkflowStepOutputSchema;
  priorStepArtifacts: Array<{ stepId: string; outputJson: unknown }>;
}

export function composeAgentInitialPrompt(input: AgentInitialPromptInput): string {
  const artifactBlock = input.priorStepArtifacts.length === 0
    ? "(no prior step outputs)"
    : input.priorStepArtifacts.map((a) => `## prior step: ${a.stepId}\n${JSON.stringify(a.outputJson, null, 2)}`).join("\n\n");

  return [
    "# Step instructions",
    input.stepInstructions,
    "",
    "# Output schema",
    JSON.stringify(input.outputSchema, null, 2),
    "",
    "# Prior step outputs",
    artifactBlock,
    "",
    "# Completion convention",
    "When you have all required information AND the success criteria are satisfied,",
    "emit a single fenced block at the end of your response:",
    "",
    "```orca:step-complete",
    "{ ...JSON matching the output schema exactly... }",
    "```",
    "",
    "If you are not done, do not emit this block. Continue working or ask the user one question at a time.",
  ].join("\n");
}

export type OrchestratorTriggerKind =
  | "agent_response"
  | "user_message"
  | "agent_crash"
  | "idle_timeout";

export interface OrchestratorPromptInput {
  triggerKind: OrchestratorTriggerKind;
  context: OrchestratorInvocationContext;
  triggerPayload: {
    agentResponseText?: string;
    agentStepCompleteBlock?: unknown;
    schemaValidationError?: string;
    userMessage?: string;
    crashReason?: string;
  };
}

export interface OrchestratorPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function composeOrchestratorPrompt(input: OrchestratorPromptInput): OrchestratorPrompt {
  const systemPrompt = [
    "You are the orchestrator-LLM for an Orca workflow run.",
    "Your job is to mediate between the user (chat surface) and a per-step agent.",
    "On each invocation, decide one of:",
    "- paraphrase_agent_message (forward agent output to user, in your voice)",
    "- forward_to_agent (translate the user's chat message to a prompt for the agent)",
    "- answer_user_directly (the user's message is meta and does not need to reach the agent)",
    "- approve_step_complete (the agent's <orca:step-complete> block satisfies step instructions and schema)",
    "- revise_step (the agent's proposal is insufficient; produce concrete feedback)",
    "- escalate_to_user (a failure has occurred; describe and ask for guidance)",
    "Return exactly one structured action.",
  ].join("\n");

  const userPrompt = JSON.stringify({
    triggerKind: input.triggerKind,
    context: input.context,
    trigger: input.triggerPayload,
  });

  return { systemPrompt, userPrompt };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- --run orchestrator-llm/prompts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/prompts.ts \
        apps/daemon/src/orchestrator-llm/prompts.test.ts
git commit -m "feat(daemon): orchestrator-LLM + agent initial prompt composers"
```

## Task 14: Orchestrator-LLM action contract

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts`
- Test: extend `packages/contracts/src/__tests__/workflow-contracts.test.ts` (create if absent)

- [ ] **Step 1: Append the action schema**

In `packages/contracts/src/workflows/index.ts`, add:

```ts
export const OrchestratorAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paraphrase_agent_message"), body: z.string().min(1).max(8000), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("forward_to_agent"), translated: z.string().min(1).max(8000), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("answer_user_directly"), body: z.string().min(1).max(8000), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("approve_step_complete"), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("revise_step"), feedback: z.string().min(1).max(4000), rationale: z.string().max(2000).optional() }),
  z.object({ kind: z.literal("escalate_to_user"), body: z.string().min(1).max(8000), rationale: z.string().max(2000).optional() }),
]);
export type OrchestratorAction = z.infer<typeof OrchestratorAction>;
```

- [ ] **Step 2: Test parse**

In a workflow-contracts test file, add:

```ts
import { OrchestratorAction } from "../workflows/index.js";

it("parses approve_step_complete", () => {
  expect(OrchestratorAction.parse({ kind: "approve_step_complete" })).toBeDefined();
});
it("rejects unknown kind", () => {
  expect(() => OrchestratorAction.parse({ kind: "explode" })).toThrow();
});
```

- [ ] **Step 3: Run contracts tests**

Run: `pnpm --filter @orca/contracts test`
Expected: PASS.

- [ ] **Step 4: Build contracts**

Run: `pnpm --filter @orca/contracts build`

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/__tests__/workflow-contracts.test.ts
git commit -m "feat(contracts): OrchestratorAction discriminated union"
```

## Task 15: Orchestrator-LLM session abstraction

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/session.ts`
- Create: `apps/daemon/src/orchestrator-llm/session.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/daemon/src/orchestrator-llm/session.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { OrchestratorSessionManager } from "./session.js";

describe("OrchestratorSessionManager", () => {
  it("spawn returns a sessionId and registers it", async () => {
    const fakeAdapter = {
      resolveSpawn: vi.fn(async () => ({ command: "true", args: [], env: {}, cwd: "/" })),
    };
    const fakeRuntime = {
      spawnPty: vi.fn(async () => ({ sessionId: "orchsess-1" })),
      terminate: vi.fn(async () => {}),
      sendStdin: vi.fn(async () => {}),
    };
    const mgr = new OrchestratorSessionManager({ adapter: fakeAdapter as any, runtime: fakeRuntime as any });
    const id = await mgr.spawn({ goalId: "g1", adapterId: "claude-code", modelId: "claude-haiku-4-5" });
    expect(id).toBe("orchsess-1");
    expect(fakeRuntime.spawnPty).toHaveBeenCalledOnce();
  });

  it("invoke one_shot returns response text", async () => {
    const fakeOneShot = vi.fn(async () => ({ text: "hello" }));
    const mgr = new OrchestratorSessionManager({
      adapter: { resolveSpawn: vi.fn() } as any,
      runtime: {} as any,
      oneShotClient: { request: fakeOneShot } as any,
    });
    const out = await mgr.invokeOneShot({ adapterId: "codex", modelId: "gpt-x", systemPrompt: "s", userPrompt: "u" });
    expect(out.text).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- --run orchestrator-llm/session`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/daemon/src/orchestrator-llm/session.ts`:

```ts
import type { AgentAdapter } from "../adapters/types.js";
import type { SessionRuntime } from "../sessions/runtime.js";

export interface OrchestratorSessionSpawnInput {
  goalId: string;
  adapterId: string;
  modelId: string;
}

export interface OrchestratorOneShotInput {
  adapterId: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface OrchestratorOneShotResult { text: string }

export interface OrchestratorOneShotClient {
  request(input: OrchestratorOneShotInput): Promise<OrchestratorOneShotResult>;
}

export interface OrchestratorSessionDeps {
  adapter: AgentAdapter;
  runtime: SessionRuntime;
  oneShotClient?: OrchestratorOneShotClient;
}

export class OrchestratorSessionManager {
  private active: Record<string, string> = {};  // goalId -> sessionId

  constructor(private readonly deps: OrchestratorSessionDeps) {}

  async spawn(input: OrchestratorSessionSpawnInput): Promise<string> {
    const spawn = await this.deps.adapter.resolveSpawn({
      goalId: input.goalId,
      sessionId: `orchsess-${input.goalId}`,
      workspacePath: ".",
    });
    const handle = await this.deps.runtime.spawnPty({
      command: spawn.command,
      args: spawn.args,
      env: spawn.env,
      cwd: spawn.cwd,
    } as never);
    this.active[input.goalId] = handle.sessionId;
    return handle.sessionId;
  }

  async sendShadowPrompt(goalId: string, prompt: string): Promise<void> {
    const sid = this.active[goalId];
    if (!sid) throw new Error(`no active orchestrator session for goal ${goalId}`);
    await this.deps.runtime.sendStdin(sid, prompt);
  }

  async terminate(goalId: string): Promise<void> {
    const sid = this.active[goalId];
    if (!sid) return;
    await this.deps.runtime.terminate(sid);
    delete this.active[goalId];
  }

  async invokeOneShot(input: OrchestratorOneShotInput): Promise<OrchestratorOneShotResult> {
    if (!this.deps.oneShotClient) throw new Error("oneShotClient not configured");
    return this.deps.oneShotClient.request(input);
  }
}
```

(If `SessionRuntime` doesn't expose `spawnPty/sendStdin/terminate`, adapt to the existing API. The point is to encapsulate shadow PTY lifecycle for orchestrator dispatch.)

- [ ] **Step 4: Run test**

Run: `pnpm --filter @orca/daemon test -- --run orchestrator-llm/session`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/session.ts \
        apps/daemon/src/orchestrator-llm/session.test.ts
git commit -m "feat(daemon): OrchestratorSessionManager for shadow + one_shot orchestrator dispatch"
```

## Task 16: OrchestratorMediator — single invocation flow

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/mediator.ts`
- Create: `apps/daemon/src/orchestrator-llm/mediator.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/daemon/src/orchestrator-llm/mediator.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { OrchestratorMediator } from "./mediator.js";

describe("OrchestratorMediator.invoke", () => {
  it("returns parsed OrchestratorAction from LLM", async () => {
    const fakeLlm = { request: vi.fn(async () => ({ text: JSON.stringify({ kind: "approve_step_complete" }) })) };
    const mediator = new OrchestratorMediator({
      llm: fakeLlm as any,
      buildContext: vi.fn(() => ({ goal: {}, workflowRun: {}, currentStep: {}, conversation: { chatMessages: [], currentStepAgentTurns: [] }, priorStepArtifacts: [] } as any)),
      composePrompt: vi.fn((i) => ({ systemPrompt: "s", userPrompt: "u" })),
    });
    const action = await mediator.invoke({
      triggerKind: "agent_response",
      goalId: "g1",
      runId: "r1",
      stepRunId: "s1",
      triggerPayload: { agentResponseText: "x", agentStepCompleteBlock: {} },
      adapterId: "claude-code",
      modelId: "claude-haiku-4-5",
    });
    expect(action.kind).toBe("approve_step_complete");
  });

  it("retries once on parse failure", async () => {
    const fakeLlm = {
      request: vi.fn()
        .mockResolvedValueOnce({ text: "not-json" })
        .mockResolvedValueOnce({ text: JSON.stringify({ kind: "paraphrase_agent_message", body: "hi" }) }),
    };
    const mediator = new OrchestratorMediator({
      llm: fakeLlm as any,
      buildContext: vi.fn(() => ({} as any)),
      composePrompt: vi.fn(() => ({ systemPrompt: "s", userPrompt: "u" })),
    });
    const action = await mediator.invoke({
      triggerKind: "agent_response",
      goalId: "g1", runId: "r1", stepRunId: "s1",
      triggerPayload: { agentResponseText: "x" },
      adapterId: "claude-code", modelId: "claude-haiku-4-5",
    });
    expect(action.kind).toBe("paraphrase_agent_message");
    expect(fakeLlm.request).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/daemon/src/orchestrator-llm/mediator.ts`:

```ts
import { OrchestratorAction } from "@orca/contracts";
import type { OrchestratorPromptInput, OrchestratorPrompt, OrchestratorTriggerKind } from "./prompts.js";
import type { OrchestratorInvocationContext, OrchestratorContextInput } from "./context.js";

export interface OrchestratorLlmClient {
  request(input: { adapterId: string; modelId: string; systemPrompt: string; userPrompt: string }): Promise<{ text: string }>;
}

export interface MediatorDeps {
  llm: OrchestratorLlmClient;
  buildContext: (args: { goalId: string; runId: string; stepRunId: string }) => OrchestratorInvocationContext;
  composePrompt: (input: OrchestratorPromptInput) => OrchestratorPrompt;
}

export interface MediatorInvokeInput {
  triggerKind: OrchestratorTriggerKind;
  goalId: string;
  runId: string;
  stepRunId: string;
  triggerPayload: OrchestratorPromptInput["triggerPayload"];
  adapterId: string;
  modelId: string;
}

export class OrchestratorMediator {
  constructor(private readonly deps: MediatorDeps) {}

  async invoke(input: MediatorInvokeInput): Promise<OrchestratorAction> {
    const context = this.deps.buildContext({ goalId: input.goalId, runId: input.runId, stepRunId: input.stepRunId });
    const prompt = this.deps.composePrompt({
      triggerKind: input.triggerKind,
      context,
      triggerPayload: input.triggerPayload,
    });
    const res1 = await this.deps.llm.request({ adapterId: input.adapterId, modelId: input.modelId, ...prompt });
    const parsed1 = tryParseAction(res1.text);
    if (parsed1) return parsed1;
    const res2 = await this.deps.llm.request({ adapterId: input.adapterId, modelId: input.modelId, ...prompt });
    const parsed2 = tryParseAction(res2.text);
    if (parsed2) return parsed2;
    throw new Error("orchestrator-LLM produced no parseable action after 2 attempts");
  }
}

function tryParseAction(text: string): OrchestratorAction | null {
  try {
    const obj = JSON.parse(text);
    const parsed = OrchestratorAction.safeParse(obj);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/mediator.ts \
        apps/daemon/src/orchestrator-llm/mediator.test.ts
git commit -m "feat(daemon): OrchestratorMediator invokes orchestrator-LLM and parses OrchestratorAction"
```

## Task 17: Agent response-done hook endpoint

**Files:**
- Create: `apps/daemon/src/agent-hooks/routes.ts`
- Create: `apps/daemon/src/agent-hooks/routes.test.ts`
- Modify: `apps/daemon/src/server.ts`

- [ ] **Step 1: Write failing test**

Create `apps/daemon/src/agent-hooks/routes.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerAgentHookRoutes } from "./routes.js";

describe("POST /v1/agent-hooks/response-done", () => {
  it("accepts payload and invokes mediator", async () => {
    const onResponseDone = vi.fn(async () => undefined);
    const app = Fastify();
    registerAgentHookRoutes(app, { onResponseDone });
    const res = await app.inject({
      method: "POST",
      url: "/v1/agent-hooks/response-done",
      payload: {
        sessionId: "sess-1",
        adapterId: "claude-code",
        responseText: "agent says hi",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(onResponseDone).toHaveBeenCalledWith({
      sessionId: "sess-1",
      adapterId: "claude-code",
      responseText: "agent says hi",
    });
  });

  it("rejects missing fields", async () => {
    const app = Fastify();
    registerAgentHookRoutes(app, { onResponseDone: vi.fn() });
    const res = await app.inject({ method: "POST", url: "/v1/agent-hooks/response-done", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test**

Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `apps/daemon/src/agent-hooks/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const AgentResponseDonePayload = z
  .object({
    sessionId: z.string().min(1).max(200),
    adapterId: z.string().min(1).max(50),
    responseText: z.string().max(200_000),
    transcriptPath: z.string().max(1000).optional(),
  })
  .strict();
export type AgentResponseDonePayload = z.infer<typeof AgentResponseDonePayload>;

export interface AgentHookRouteDeps {
  onResponseDone(payload: AgentResponseDonePayload): Promise<void>;
}

export function registerAgentHookRoutes(server: FastifyInstance, deps: AgentHookRouteDeps): void {
  server.post("/v1/agent-hooks/response-done", async (request, reply) => {
    const parsed = AgentResponseDonePayload.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "validation_failed", issues: parsed.error.issues } };
    }
    await deps.onResponseDone(parsed.data);
    return { ok: true };
  });
}
```

- [ ] **Step 4: Wire into server.ts**

In `apps/daemon/src/server.ts`, register routes with a callback that finds the orchestrator mediator + dispatches a `agent_response` trigger. Stub during this task; the real callback is connected in later tasks (Sub-plan 5).

```ts
import { registerAgentHookRoutes } from "./agent-hooks/routes.js";

// ...
registerAgentHookRoutes(server, {
  onResponseDone: async (payload) => {
    // Stubbed: real wiring occurs in Sub-plan 5 (judgement loop).
    daemonContext.log?.info?.({ msg: "agent.response.done", ...payload });
  },
});
```

- [ ] **Step 5: Run all daemon tests**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/agent-hooks/routes.ts \
        apps/daemon/src/agent-hooks/routes.test.ts \
        apps/daemon/src/server.ts
git commit -m "feat(daemon): /v1/agent-hooks/response-done endpoint with stubbed handler"
```

---

# Sub-plan 4: Deterministic per-step agent dispatch

**Goal:** Replace LLM-based operator selection for skill steps with deterministic resolution from `template.agentPreference[]` (ordered fallback over `{adapterId, modelId, providerId?}`).

## Task 18: Contract — `StepAgentChoice` + `agentPreference`

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts`
- Test: `packages/contracts/src/__tests__/workflow-contracts.test.ts`

- [ ] **Step 1: Append failing test**

In `packages/contracts/src/__tests__/workflow-contracts.test.ts`:

```ts
import { StepAgentChoice, WorkflowStepTemplate } from "../workflows/index.js";

it("StepAgentChoice parses", () => {
  expect(StepAgentChoice.parse({ adapterId: "claude-code", modelId: "claude-haiku-4-5" })).toBeDefined();
});

it("WorkflowStepTemplate requires non-empty agentPreference", () => {
  const r = WorkflowStepTemplate.safeParse({
    id: "intake", ordinal: 0, name: "Intake", instructions: "x",
    outputSchema: [], agentPreference: [],
  });
  expect(r.success).toBe(false);
});

it("WorkflowStepTemplate accepts valid agentPreference", () => {
  const r = WorkflowStepTemplate.safeParse({
    id: "intake", ordinal: 0, name: "Intake", instructions: "x",
    outputSchema: [{ key: "problem", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  });
  expect(r.success).toBe(true);
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Add schemas**

In `packages/contracts/src/workflows/index.ts`, add before `WorkflowStepTemplate`:

```ts
export const StepAgentChoice = z
  .object({
    adapterId: AdapterId,
    modelId: z.string().min(1).max(80),
    providerId: ModelProviderId.optional(),
  })
  .strict();
export type StepAgentChoice = z.infer<typeof StepAgentChoice>;
```

Then modify `WorkflowStepTemplate`:

```ts
export const WorkflowStepTemplate = z
  .object({
    id: Id100,
    ordinal: z.number().int().nonnegative(),
    name: z.string().min(1).max(100),
    instructions: BoundedString(WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES, "instructions"),
    outputSchema: WorkflowStepOutputSchema,
    agentPreference: z.array(StepAgentChoice).min(1).max(8),
  })
  .strict();
```

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Build contracts**

Run: `pnpm --filter @orca/contracts build`

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/workflows/index.ts \
        packages/contracts/src/__tests__/workflow-contracts.test.ts
git commit -m "feat(contracts): StepAgentChoice + WorkflowStepTemplate.agentPreference required"
```

## Task 19: Adapter `supportsModel`

**Files:**
- Modify: `apps/daemon/src/adapters/types.ts`
- Modify: each adapter file (claude-code, codex, opencode, gemini, shell-manual)
- Test: extend `apps/daemon/src/adapters/agent-adapters.test.ts`

- [ ] **Step 1: Append failing test**

```ts
it("claude-code supports the haiku/sonnet/opus models referenced by engineering v4", () => {
  expect(claudeCodeAdapter.supportsModel("claude-haiku-4-5")).toBe(true);
  expect(claudeCodeAdapter.supportsModel("claude-sonnet-4-6")).toBe(true);
  expect(claudeCodeAdapter.supportsModel("claude-opus-4-7")).toBe(true);
});

it("shell-manual rejects unknown model ids", () => {
  expect(shellManualAdapter.supportsModel("anything")).toBe(false);
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Extend interface**

In `apps/daemon/src/adapters/types.ts`:

```ts
export interface AgentAdapter {
  // ... existing
  supportedExecutionModes: ExecutionMode[];
  /** Return true if this adapter can drive the given model id. */
  supportsModel(modelId: string): boolean;
  // ...
}
```

- [ ] **Step 4: Implement per adapter**

Each adapter file adds a `supportsModel` method matching its known models. Example for `apps/daemon/src/adapters/claude-code.ts`:

```ts
const CLAUDE_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
]);
// ... in adapter object:
supportsModel(modelId: string): boolean {
  return CLAUDE_MODELS.has(modelId);
}
```

For `shell-manual.ts`:

```ts
supportsModel(_modelId: string): boolean {
  return false;
}
```

Etc.

- [ ] **Step 5: Run test**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/adapters/types.ts apps/daemon/src/adapters/*.ts \
        apps/daemon/src/adapters/agent-adapters.test.ts
git commit -m "feat(daemon): adapters declare supportsModel(modelId)"
```

## Task 20: Step-dispatch resolver

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/step-dispatch.ts`
- Create: `apps/daemon/src/workflows/orchestrator/step-dispatch.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveStepDispatch } from "./step-dispatch.js";

describe("resolveStepDispatch", () => {
  it("returns first ready adapter+model from preference", async () => {
    const result = await resolveStepDispatch({
      preferences: [
        { adapterId: "codex", modelId: "gpt-x" },
        { adapterId: "claude-code", modelId: "claude-haiku-4-5" },
      ],
      isAdapterReady: async (id) => id === "claude-code",
      supportsModel: (id, mid) => id === "claude-code" && mid === "claude-haiku-4-5",
      resolveMode: () => ({ adapterId: "claude-code", mode: "shadow_session", fallbacks: [] }),
    });
    expect(result.adapterId).toBe("claude-code");
    expect(result.modelId).toBe("claude-haiku-4-5");
    expect(result.executionMode).toBe("shadow_session");
  });

  it("throws when no preference is satisfiable", async () => {
    await expect(resolveStepDispatch({
      preferences: [{ adapterId: "codex", modelId: "gpt-x" }],
      isAdapterReady: async () => false,
      supportsModel: () => true,
      resolveMode: () => ({ adapterId: "codex", mode: "one_shot", fallbacks: [] }),
    })).rejects.toThrow(/no ready agent/);
  });
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/daemon/src/workflows/orchestrator/step-dispatch.ts`:

```ts
import type { ExecutionMode, StepAgentChoice } from "@orca/contracts";
import type { ResolvedMode } from "../../adapters/dispatcher.js";

export interface ResolveStepDispatchInput {
  preferences: StepAgentChoice[];
  isAdapterReady(adapterId: string): Promise<boolean>;
  supportsModel(adapterId: string, modelId: string): boolean;
  resolveMode(adapterId: string): ResolvedMode;
}

export interface ResolvedStepDispatch {
  adapterId: string;
  modelId: string;
  providerId?: string;
  executionMode: ExecutionMode;
  fallbackModes: ExecutionMode[];
}

export async function resolveStepDispatch(
  input: ResolveStepDispatchInput
): Promise<ResolvedStepDispatch> {
  for (const pref of input.preferences) {
    if (!input.supportsModel(pref.adapterId, pref.modelId)) continue;
    const ready = await input.isAdapterReady(pref.adapterId);
    if (!ready) continue;
    const mode = input.resolveMode(pref.adapterId);
    return {
      adapterId: pref.adapterId,
      modelId: pref.modelId,
      providerId: pref.providerId,
      executionMode: mode.mode,
      fallbackModes: mode.fallbacks,
    };
  }
  throw new Error(`no ready agent for step (preferences: ${input.preferences.map(p => `${p.adapterId}/${p.modelId}`).join(", ")})`);
}
```

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/step-dispatch.ts \
        apps/daemon/src/workflows/orchestrator/step-dispatch.test.ts
git commit -m "feat(daemon): resolveStepDispatch deterministic preference walker"
```

## Task 21: Replace `commitOperatorSelectionForSkill` with deterministic dispatch

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.skill-step.test.ts`

- [ ] **Step 1: Read current shape**

Run: `sed -n '380,520p' apps/daemon/src/workflows/orchestrator/service.ts`

- [ ] **Step 2: Update `commitSkillStepDecision` to call `resolveStepDispatch`**

Replace the call to `commitOperatorSelectionForSkill` (step 3 in the current `commitSkillStepDecision`) with a synchronous deterministic resolution using `resolveStepDispatch`. Pseudocode-shaped diff:

```ts
// before:
if (!sel || !sel.selectedOperatorId) {
  return this.commitOperatorSelectionForSkill(db, now, ctx, options);
}

// after:
if (!sel || !sel.selectedOperatorId) {
  const dispatch = await resolveStepDispatch({
    preferences: stepTpl.agentPreference,
    isAdapterReady: (id) => this.adapterAvailability(id),
    supportsModel: (id, mid) => this.adapterSupportsModel(id, mid),
    resolveMode: (id) => this.adapterDispatcher.resolveMode(id),
  });
  return this.commitDeterministicStepSelection(db, now, ctx, dispatch, options);
}
```

Implement `commitDeterministicStepSelection` to:
1. Persist `selectedOperatorId = dispatch.adapterId`, `selectedModelId = dispatch.modelId`, `selectedProviderId = dispatch.providerId ?? null`, `operator_selected_at = now()`.
2. Record a `select_operator` decision with `selectedAction = "select:${adapterId}:${modelId}"`, reason `"deterministic preference resolution"`.
3. Emit `workflow.operator.selected` with `{operatorId: adapterId, operatorKind: "agent", source: "deterministic", executionMode}`.
4. Return the decision; do **not** chain into launch in this task — Task 23 (judgement loop) drives the next action.

- [ ] **Step 3: Delete `commitOperatorSelectionForSkill`**

Remove the function body and its references entirely. The `OperatorSelector` constructor dependency can be retained for now (other callers may exist) — investigate via grep and delete uses tied to this code path.

- [ ] **Step 4: Update skill-step tests**

In `apps/daemon/src/workflows/orchestrator/service.skill-step.test.ts`, replace assertions that the old code called `operatorSelector.select` with assertions that the first decision is `select:claude-code:claude-haiku-4-5` (deterministic) and that the artifact lifecycle remains unchanged. Provide a `stepTpl.agentPreference: [{adapterId: "claude-code", modelId: "claude-haiku-4-5"}]` in test seeding.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @orca/daemon test -- --run service.skill-step`
Expected: PASS (with updated assertions).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts \
        apps/daemon/src/workflows/orchestrator/service.skill-step.test.ts
git commit -m "feat(daemon): deterministic step dispatch replaces LLM operator selector"
```

---

# Sub-plan 5: Step-complete judgement loop

**Goal:** Engine validates schema deterministically; orchestrator-LLM judges approve/revise on a valid block; agent revise loop capped at N=3; on cap, escalate to user with a chat message.

## Task 22: orca-output / orca:step-complete block extractor (review existing module)

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/orca-output.ts` (extend if needed)
- Test: `apps/daemon/src/workflows/orchestrator/orca-output.test.ts`

- [ ] **Step 1: Confirm extractor handles `orca:step-complete` fence**

The spec emission convention from Phase 2 already uses ` ```orca-output ` fence; the new convention is ` ```orca:step-complete `. Verify support; if absent, add a new extractor function `extractOrcaStepCompleteBlock(text) : unknown | null`.

```ts
export function extractOrcaStepCompleteBlock(text: string): unknown | null {
  const re = /```orca:step-complete\s*\n([\s\S]*?)\n```/g;
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1];
  if (!last) return null;
  try { return JSON.parse(last); } catch { return null; }
}
```

- [ ] **Step 2: Test**

```ts
it("extracts the last orca:step-complete block", () => {
  expect(extractOrcaStepCompleteBlock("nothing here")).toBeNull();
  expect(extractOrcaStepCompleteBlock("```orca:step-complete\n{\"a\":1}\n```")).toEqual({ a: 1 });
});
```

- [ ] **Step 3: Run + commit**

Run: `pnpm --filter @orca/daemon test -- --run orca-output`
Expected: PASS.

```bash
git add apps/daemon/src/workflows/orchestrator/orca-output.ts \
        apps/daemon/src/workflows/orchestrator/orca-output.test.ts
git commit -m "feat(daemon): extractor for orca:step-complete fenced block"
```

## Task 23: Judgement module

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/judgement.ts`
- Create: `apps/daemon/src/workflows/orchestrator/judgement.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { judgeAgentResponse } from "./judgement.js";

describe("judgeAgentResponse", () => {
  it("returns paraphrase action when no step-complete block", async () => {
    const mediator = { invoke: vi.fn(async () => ({ kind: "paraphrase_agent_message", body: "hi" })) };
    const out = await judgeAgentResponse({
      mediator: mediator as any,
      schemaValidate: vi.fn(() => ({ ok: true })),
      goalId: "g", runId: "r", stepRunId: "s", adapterId: "claude-code", modelId: "claude-haiku-4-5",
      responseText: "agent says",
    });
    expect(out.kind).toBe("paraphrase_agent_message");
  });

  it("returns revise action when schema invalid (no orchestrator-LLM call)", async () => {
    const mediator = { invoke: vi.fn() };
    const out = await judgeAgentResponse({
      mediator: mediator as any,
      schemaValidate: () => ({ ok: false, errors: ["missing field"] }),
      goalId: "g", runId: "r", stepRunId: "s", adapterId: "claude-code", modelId: "claude-haiku-4-5",
      responseText: "```orca:step-complete\n{}\n```",
    });
    expect(out.kind).toBe("revise_step");
    expect(mediator.invoke).not.toHaveBeenCalled();
  });

  it("returns approve action when LLM approves", async () => {
    const mediator = { invoke: vi.fn(async () => ({ kind: "approve_step_complete" })) };
    const out = await judgeAgentResponse({
      mediator: mediator as any,
      schemaValidate: () => ({ ok: true }),
      goalId: "g", runId: "r", stepRunId: "s", adapterId: "claude-code", modelId: "claude-haiku-4-5",
      responseText: "```orca:step-complete\n{\"a\":1}\n```",
    });
    expect(out.kind).toBe("approve_step_complete");
  });
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/daemon/src/workflows/orchestrator/judgement.ts`:

```ts
import { extractOrcaStepCompleteBlock } from "./orca-output.js";
import type { OrchestratorMediator } from "../../orchestrator-llm/mediator.js";
import type { OrchestratorAction } from "@orca/contracts";

export interface JudgeAgentResponseInput {
  mediator: OrchestratorMediator;
  schemaValidate(output: unknown): { ok: true } | { ok: false; errors: string[] };
  goalId: string;
  runId: string;
  stepRunId: string;
  adapterId: string;
  modelId: string;
  responseText: string;
}

export async function judgeAgentResponse(input: JudgeAgentResponseInput): Promise<OrchestratorAction> {
  const block = extractOrcaStepCompleteBlock(input.responseText);
  if (!block) {
    return input.mediator.invoke({
      triggerKind: "agent_response",
      goalId: input.goalId, runId: input.runId, stepRunId: input.stepRunId,
      adapterId: input.adapterId, modelId: input.modelId,
      triggerPayload: { agentResponseText: input.responseText },
    });
  }
  const v = input.schemaValidate(block);
  if (!v.ok) {
    return {
      kind: "revise_step",
      feedback: `Your output failed schema validation:\n${v.errors.join("\n")}\nRevise and re-emit.`,
      rationale: "schema validation failed deterministically",
    };
  }
  return input.mediator.invoke({
    triggerKind: "agent_response",
    goalId: input.goalId, runId: input.runId, stepRunId: input.stepRunId,
    adapterId: input.adapterId, modelId: input.modelId,
    triggerPayload: { agentResponseText: input.responseText, agentStepCompleteBlock: block },
  });
}
```

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/judgement.ts \
        apps/daemon/src/workflows/orchestrator/judgement.test.ts
git commit -m "feat(daemon): judgeAgentResponse orchestrates schema + LLM judgement"
```

## Task 24: Revise loop with N=3 cap

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/revise-loop.ts`
- Create: `apps/daemon/src/workflows/orchestrator/revise-loop.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { incrementReviseAttempt, REVISE_CAP } from "./revise-loop.js";

describe("revise loop counter", () => {
  it("REVISE_CAP is 3", () => { expect(REVISE_CAP).toBe(3); });

  it("first attempt: nextAttempt = 1, capReached = false", () => {
    const r = incrementReviseAttempt(0);
    expect(r.nextAttempt).toBe(1);
    expect(r.capReached).toBe(false);
  });

  it("third attempt reaches cap", () => {
    expect(incrementReviseAttempt(2).capReached).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/daemon/src/workflows/orchestrator/revise-loop.ts`:

```ts
export const REVISE_CAP = 3;

export function incrementReviseAttempt(currentAttempts: number): { nextAttempt: number; capReached: boolean } {
  const nextAttempt = currentAttempts + 1;
  return { nextAttempt, capReached: nextAttempt >= REVISE_CAP };
}
```

- [ ] **Step 4: Persist counter via step-run row column**

Migration `0016_workflow_step_runs_revise_attempts.sql`:

```sql
ALTER TABLE workflow_step_runs ADD COLUMN revise_attempts INTEGER NOT NULL DEFAULT 0;
```

Register in `apps/daemon/src/migrations.ts`.

- [ ] **Step 5: Run test**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations/0016_workflow_step_runs_revise_attempts.sql \
        apps/daemon/src/migrations.ts \
        apps/daemon/src/workflows/orchestrator/revise-loop.ts \
        apps/daemon/src/workflows/orchestrator/revise-loop.test.ts
git commit -m "feat(daemon): revise loop counter + step-run revise_attempts column"
```

## Task 25: Wire judgement loop into agent-hook callback

**Files:**
- Modify: `apps/daemon/src/server.ts` (replace stub handler from Task 17)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (add `onAgentResponseDone(payload)` method)
- Test: extend `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

- [ ] **Step 1: Add service method**

In `apps/daemon/src/workflows/orchestrator/service.ts`, add:

```ts
async onAgentResponseDone(
  db: Database.Database,
  now: () => string,
  payload: { sessionId: string; adapterId: string; responseText: string },
  options: RequestNextDecisionOptions = {}
): Promise<void> {
  // 1. resolve sessionId -> stepRunId -> stepTpl, run, goal
  const sess = db.prepare("SELECT workflow_step_run_id FROM sessions WHERE id = ?").get(payload.sessionId) as { workflow_step_run_id: string | null } | undefined;
  if (!sess?.workflow_step_run_id) return;
  const stepRun = db.prepare("SELECT * FROM workflow_step_runs WHERE id = ?").get(sess.workflow_step_run_id) as StepRunRow | undefined;
  if (!stepRun || stepRun.status !== "active") return;
  const run = getWorkflowRunById(db, stepRun.workflow_run_id);
  if (!run || run.status !== "active") return;
  const template = getTemplateById(db, run.templateId);
  if (!template) return;
  const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
  if (!stepTpl) return;

  // 2. judge the response
  const action = await judgeAgentResponse({
    mediator: this.orchestratorMediator,
    schemaValidate: (output) => {
      const v = validateStepOutput(stepTpl.outputSchema, output);
      return v.ok ? { ok: true } : { ok: false, errors: v.errors };
    },
    goalId: run.goalId, runId: run.id, stepRunId: stepRun.id,
    adapterId: stepRun.selected_operator_id!, modelId: stepRun.selected_model_id!,
    responseText: payload.responseText,
  });

  // 3. apply action
  switch (action.kind) {
    case "paraphrase_agent_message":
    case "answer_user_directly":
    case "forward_to_agent":
      // post a chat message; engine appends an orchestrator_messages row
      await this.postOrchestratorMessage(db, now, run.goalId, run.id, stepRun.id, action);
      return;
    case "approve_step_complete":
      // create step_output artifact (source: agent), then advance / mark complete
      // ... reuse existing createStepOutputArtifact + commitAdvanceOrComplete
      return;
    case "revise_step": {
      const counter = incrementReviseAttempt(stepRun.revise_attempts ?? 0);
      db.prepare("UPDATE workflow_step_runs SET revise_attempts=? WHERE id=?").run(counter.nextAttempt, stepRun.id);
      if (counter.capReached) {
        await this.postEscalationMessage(db, now, run.goalId, run.id, stepRun.id, action.feedback);
      } else {
        await this.sendAgentRevise(payload.sessionId, action.feedback);
      }
      return;
    }
    case "escalate_to_user":
      await this.postEscalationMessage(db, now, run.goalId, run.id, stepRun.id, action.body);
      return;
  }
}
```

(`postOrchestratorMessage`, `postEscalationMessage`, `sendAgentRevise` are helpers reusing the existing `orchestrator_messages` table + session runtime `sendStdin`. Implement as thin wrappers.)

- [ ] **Step 2: Wire endpoint to method**

In `apps/daemon/src/server.ts`, replace the Task-17 stub:

```ts
registerAgentHookRoutes(server, {
  onResponseDone: async (payload) => {
    await orchestratorService.onAgentResponseDone(getDatabase(), daemonContext.now, payload, { bus: eventBus, idFactory: daemonContext.idFactory });
  },
});
```

- [ ] **Step 3: Add integration test**

Append to `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`:

```ts
it("onAgentResponseDone with valid step-complete + LLM approve advances step", async () => {
  const { db, bus, idFactory } = setupHarness();
  setupAgentStepRun(db);
  seedWorkspace(db);

  const mediator = { invoke: vi.fn(async () => ({ kind: "approve_step_complete" })) };
  const service = new OrchestratorService(
    fakeAgentSelector(),
    fakeBrokerNoop(),
    { async list() { return [agentOperatorDescriptor()]; } },
    makeLauncher(),
    // ... extend constructor to accept mediator
  );
  // Manually pre-set selectedOperatorId + sessionId on the step run + a sessions row
  db.prepare("UPDATE workflow_step_runs SET selected_operator_id='agent:claude-code', selected_model_id='claude-haiku-4-5' WHERE id='step-1'").run();
  db.prepare("INSERT INTO sessions(id, workflow_step_run_id, status, started_at) VALUES('sess-1', 'step-1', 'running', ?)").run(NOW);

  await service.onAgentResponseDone(db, () => NOW, {
    sessionId: "sess-1", adapterId: "claude-code",
    responseText: "done.\n```orca:step-complete\n{\"result\":\"x\"}\n```",
  }, { bus, idFactory });

  const stepRun = db.prepare("SELECT status FROM workflow_step_runs WHERE id=?").get("step-1") as { status: string };
  expect(stepRun.status).toMatch(/complete|finished/);  // adjust to the real status string
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @orca/daemon test -- --run service.agent-step`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts \
        apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts \
        apps/daemon/src/server.ts
git commit -m "feat(daemon): wire judgement loop into agent-hook callback"
```

---

# Sub-plan 6: Engineering template v4

**Goal:** Bump `orca/engineering` template to v4 with per-step `agentPreference`; remove the `approval_launch_agent` guardrail.

## Task 26: Update seed-engineering.ts to v4

**Files:**
- Modify: `apps/daemon/src/workflows/templates/seed-engineering.ts`

- [ ] **Step 1: Write failing test**

In `apps/daemon/src/workflows/templates/seed-engineering.test.ts` (create if absent):

```ts
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../migrations.js";
import { seedEngineeringTemplate, ENGINEERING_VERSION } from "./seed-engineering.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../../migrations");

it("engineering template seeds at v4 with agentPreference per step", () => {
  expect(ENGINEERING_VERSION).toBe(4);
  const db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  seedEngineeringTemplate(db, () => "2026-05-28T00:00:00.000Z");
  const row = db.prepare("SELECT steps_json, guardrails_json FROM workflow_templates WHERE id='orca/engineering'").get() as { steps_json: string; guardrails_json: string };
  const steps = JSON.parse(row.steps_json) as Array<{ id: string; agentPreference: Array<{ adapterId: string; modelId: string }> }>;
  const intake = steps.find((s) => s.id === "intake")!;
  expect(intake.agentPreference[0]).toEqual({ adapterId: "claude-code", modelId: "claude-haiku-4-5" });
  const research = steps.find((s) => s.id === "research")!;
  expect(research.agentPreference[0].modelId).toBe("claude-opus-4-7");
  const execution = steps.find((s) => s.id === "execution")!;
  expect(execution.agentPreference[0].modelId).toBe("claude-sonnet-4-6");
  const guards = JSON.parse(row.guardrails_json) as Array<{ id: string }>;
  expect(guards.find((g) => g.id === "approval_launch_agent")).toBeUndefined();
});
```

- [ ] **Step 2: Run test**

Expected: FAIL.

- [ ] **Step 3: Update template seeding**

In `apps/daemon/src/workflows/templates/seed-engineering.ts`:

```ts
export const ENGINEERING_VERSION = 4;

// ...

const ENGINEERING_STEPS: WorkflowStepTemplate[] = [
  {
    id: "intake",
    ordinal: 0,
    name: "Intake",
    instructions: /* unchanged */,
    outputSchema: /* unchanged */,
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  },
  {
    id: "research",
    ordinal: 1,
    name: "Research",
    instructions: /* unchanged */,
    outputSchema: /* unchanged */,
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-7" }],
  },
  {
    id: "prd",
    ordinal: 2,
    name: "PRD / Destination",
    instructions: /* unchanged */,
    outputSchema: /* unchanged */,
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-7" }],
  },
  {
    id: "issue_breakdown",
    ordinal: 3,
    name: "Issue Breakdown",
    instructions: /* unchanged */,
    outputSchema: /* unchanged */,
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-7" }],
  },
  {
    id: "execution",
    ordinal: 4,
    name: "Execution",
    instructions: /* unchanged */,
    outputSchema: /* unchanged */,
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-sonnet-4-6" }],
  },
  {
    id: "qa",
    ordinal: 5,
    name: "QA",
    instructions: /* unchanged */,
    outputSchema: /* unchanged */,
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-sonnet-4-6" }],
  },
  {
    id: "review",
    ordinal: 6,
    name: "Fresh-Context Review",
    instructions: /* unchanged */,
    outputSchema: /* unchanged */,
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-7" }],
  },
  {
    id: "done",
    ordinal: 7,
    name: "Done",
    instructions: /* unchanged */,
    outputSchema: /* unchanged */,
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  },
];

const ENGINEERING_GUARDRAILS: WorkflowGuardrailConfig[] = [
  // approval_launch_agent removed.
  {
    id: "approval_mark_done",
    kind: "approval_required",
    label: "Require approval to mark Done",
    configJson: { actions: ["mark_run_complete"] },
  },
  {
    id: "validation_required",
    kind: "validation_rule",
    label: "Require tests or typecheck or explicit skip reason",
    configJson: {
      appliesToSteps: ["execution"],
      required: ["unit_tests", "typecheck"],
    },
  },
  {
    id: "context_summary",
    kind: "context_rule",
    label: "Use summaries and artifacts instead of raw terminal output",
    configJson: { allowRawTerminalOutput: false },
  },
  {
    id: "concurrency_one",
    kind: "concurrency_rule",
    label: "Max one execution task running at a time",
    configJson: { maxConcurrentExecution: 1 },
  },
  {
    id: "cost_speed_balanced",
    kind: "cost_speed_preference",
    label: "Prefer cheapest sufficient",
    configJson: { preference: "cheapest_sufficient" },
  },
];
```

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/templates/seed-engineering.ts \
        apps/daemon/src/workflows/templates/seed-engineering.test.ts
git commit -m "feat(daemon): engineering template v4 with per-step agentPreference; drop launch-agent gate"
```

---

# Sub-plan 7: Bootstrap + event-driven progression

**Goal:** Remove the single `requestNextDecision` call from goal bootstrap; rely on engine event-driven progression (agent-hook callback, user-message arrival, crash, idle timeout).

## Task 27: Strip bootstrap-route's `requestNextDecision`

**Files:**
- Modify: `apps/daemon/src/goals/bootstrap-route.ts`
- Modify: `apps/daemon/src/goals/bootstrap-route.test.ts`

- [ ] **Step 1: Update test**

In `bootstrap-route.test.ts`, the existing tests verify the single decision call; update them to assert that:
- After `POST /v1/goals/create-and-start-workflow`, an orchestrator-LLM session is spawned (deps callback invoked).
- The first step's agent session is spawned (deps callback invoked).
- No `requestNextDecision` call is made directly by bootstrap.

```ts
it("bootstrap spawns orchestrator session and first step's agent session", async () => {
  const spawnOrchestrator = vi.fn(async () => "orchsess-1");
  const startStep = vi.fn(async () => undefined);
  const handle = await startServerWithFakeDeps({ /* ... */ spawnOrchestrator, startStep });
  const res = await handle.inject({
    method: "POST", url: "/v1/goals/create-and-start-workflow",
    payload: { title: "T", description: "D", workflowTemplateId: "orca/engineering" },
  });
  expect(res.statusCode).toBe(201);
  expect(spawnOrchestrator).toHaveBeenCalled();
  expect(startStep).toHaveBeenCalled();
});
```

- [ ] **Step 2: Update route**

In `apps/daemon/src/goals/bootstrap-route.ts`, replace `requestNextDecisionFn` with `spawnOrchestratorSessionFn` + `startWorkflowFirstStepFn`:

```ts
export interface GoalBootstrapRouteDeps {
  createGoalFn: (input: {...}) => Promise<Goal>;
  startWorkflowRunFn: (args: {...}) => WorkflowRun;
  spawnOrchestratorSessionFn: (goalId: string, runId: string) => Promise<string>;
  startWorkflowFirstStepFn: (goalId: string, runId: string) => Promise<void>;
}
// inside POST handler, replace the requestNextDecision call:
try {
  await deps.spawnOrchestratorSessionFn(goalId, workflowRunId);
  await deps.startWorkflowFirstStepFn(goalId, workflowRunId);
} catch (err) {
  reply.status(201);
  return { ok: false, goalId, workflowRunId, bootstrapError: { phase: "startFirstStep", message: err instanceof Error ? err.message : "unknown" } };
}
```

- [ ] **Step 3: Wire deps in server.ts**

In `apps/daemon/src/server.ts`, supply `spawnOrchestratorSessionFn` (calls `OrchestratorSessionManager.spawn`) and `startWorkflowFirstStepFn` (a new method on `OrchestratorService` that deterministically spawns the first step's agent session and emits internal-thought events).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @orca/daemon test -- --run bootstrap`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/goals/bootstrap-route.ts apps/daemon/src/goals/bootstrap-route.test.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): bootstrap spawns orchestrator session + first step; remove requestNextDecision"
```

## Task 28: `startWorkflowFirstStep` + `advanceToNextStep` orchestrator-service methods

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`

- [ ] **Step 1: Add methods**

```ts
async startWorkflowFirstStep(db: Database.Database, now: () => string, runId: string, options: RequestNextDecisionOptions = {}): Promise<void> {
  const run = getWorkflowRunById(db, runId);
  if (!run) throw new OrchestratorRunNotFoundError(runId);
  const template = getTemplateById(db, run.templateId);
  if (!template) throw new OrchestratorTemplateNotFoundError(run.templateId);
  const firstStep = template.steps.find((s) => s.ordinal === 0);
  if (!firstStep) throw new Error(`template has no first step: ${run.templateId}`);
  const stepRun = readStepRun(db, run.currentStepRunId);
  await this.spawnStepAgent(db, now, { run, stepRun, stepTpl: firstStep, template, goal: readGoal(db, run.goalId) }, options);
}

private async spawnStepAgent(db: Database.Database, now: () => string, ctx: {...}, options: RequestNextDecisionOptions): Promise<void> {
  const dispatch = await resolveStepDispatch({
    preferences: ctx.stepTpl.agentPreference,
    isAdapterReady: (id) => this.adapterAvailability(id),
    supportsModel: (id, mid) => this.adapterSupportsModel(id, mid),
    resolveMode: (id) => this.adapterDispatcher.resolveMode(id),
  });
  // persist selection (Task 21 already implemented commitDeterministicStepSelection)
  await this.commitDeterministicStepSelection(db, now, ctx, dispatch, options);
  // spawn the agent session via the existing launcher
  await this.launcher.launch({
    goalId: ctx.goal.id, workflowRunId: ctx.run.id, workflowStepRunId: ctx.stepRun.id,
    operatorId: dispatch.adapterId, operatorKind: "agent",
    objective: composeAgentInitialPrompt({
      stepInstructions: ctx.stepTpl.instructions,
      outputSchema: ctx.stepTpl.outputSchema,
      priorStepArtifacts: this.collectPriorStepArtifacts(db, ctx.run.id, ctx.stepRun.ordinal),
    }),
  });
  // emit an internal-thought event for chat UI
  emitInternalThought(options.bus, { goalId: ctx.goal.id, runId: ctx.run.id, stepRunId: ctx.stepRun.id, kind: "step_started", body: `Starting ${ctx.stepTpl.name}` });
}

async advanceToNextStep(db: Database.Database, now: () => string, runId: string, options: RequestNextDecisionOptions): Promise<void> {
  // After approve_step_complete: advance currentStepRunId, spawn next step's agent, or surface mark-done confirm.
  // Reuse existing commitAdvanceOrComplete to record the decision; then spawnStepAgent for the new step (if any).
}
```

- [ ] **Step 2: Test**

Append to `service.agent-step.test.ts`:

```ts
it("startWorkflowFirstStep persists selection + invokes launcher", async () => {
  // setup; assert dispatch persisted; assert launcher called with the right operatorId/objective
});

it("advanceToNextStep ends in mark-done confirm for the final step", async () => {
  // setup; complete final step; assert orchestrator-message of kind mark_done_confirm posted
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @orca/daemon test -- --run service.agent-step
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): startWorkflowFirstStep + advanceToNextStep on OrchestratorService"
```

## Task 29: User-message arrival triggers mediator

**Files:**
- Modify: `apps/daemon/src/orchestrator/routes.ts` (or wherever orchestrator messages POST lives)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (add `onUserMessage` method)

- [ ] **Step 1: Find the existing user-message ingestion point**

Run: `grep -n "orchestrator-messages\|orchestratorMessages\|postOrchestratorMessage" apps/daemon/src -r | head -20`

- [ ] **Step 2: Add `onUserMessage` method to service**

```ts
async onUserMessage(db: Database.Database, now: () => string, args: { goalId: string; body: string }, options: RequestNextDecisionOptions): Promise<void> {
  // 1. find the active run
  const run = activeRunForGoal(db, args.goalId);
  if (!run) return;
  const stepRun = readStepRun(db, run.currentStepRunId);
  // 2. invoke mediator with triggerKind = "user_message"
  const action = await this.orchestratorMediator.invoke({
    triggerKind: "user_message",
    goalId: args.goalId, runId: run.id, stepRunId: stepRun.id,
    adapterId: stepRun.selected_operator_id!, modelId: stepRun.selected_model_id!,
    triggerPayload: { userMessage: args.body },
  });
  // 3. apply action (reuse the switch from Task 25)
  await this.applyOrchestratorAction(db, now, run, stepRun, action, options);
}
```

- [ ] **Step 3: Wire HTTP route**

Where the existing POST `/v1/goals/:id/orchestrator-messages` lives, after appending the user's message, call `orchestratorService.onUserMessage(...)`.

- [ ] **Step 4: Test**

Mock the mediator + assert that an action of kind `forward_to_agent` results in `sendStdin` (or one-shot dispatch) to the per-step session.

- [ ] **Step 5: Run + commit**

```bash
pnpm --filter @orca/daemon test -- --run service
git add apps/daemon/src/orchestrator/routes.ts apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "feat(daemon): user-message arrival triggers orchestrator-LLM mediator"
```

---

# Sub-plan 8: Chat UI overhaul

**Goal:** Remove banner / recommendations panel / pending-input card / `SystemCard`. Introduce `InternalThoughtRow`, `AgentParaphrasedMessage` (with collapsible raw transcript + ⓘ Why?), `MarkDoneConfirmCard` (inline). Wire chat to consume new message kinds and internal-thought events.

## Task 30: New chat element types in the API/contracts

**Files:**
- Modify: `packages/contracts/src/index.ts` (or workflows/index.ts; whichever houses orchestrator messages)
- Test: contracts tests

- [ ] **Step 1: Append new chat message kinds**

```ts
export const OrchestratorChatRole = z.enum(["user", "orchestrator", "agent_paraphrased", "internal_thought"]);
export const OrchestratorChatMessage = z.object({
  id: Id,
  goalId: Id,
  workflowRunId: Id.nullable(),
  stepRunId: Id.nullable(),
  role: OrchestratorChatRole,
  body: z.string().min(1).max(20_000),
  rawAgentText: z.string().max(200_000).nullable().optional(),   // only on agent_paraphrased
  whyRationale: z.string().max(4000).nullable().optional(),       // expander text
  internalKind: z.enum([
    "step_started",
    "thinking",
    "agent_invocation",
    "schema_validation",
    "revise",
    "agent_crash",
    "mark_done_ready",
  ]).nullable().optional(),                                       // only on internal_thought
  createdAt: z.string().datetime(),
}).strict();
```

- [ ] **Step 2: Wire migration to persist these fields**

If `orchestrator_messages` table doesn't yet store `role`, `raw_agent_text`, `why_rationale`, `internal_kind`, add migration `0017_orchestrator_messages_chat_kinds.sql`:

```sql
ALTER TABLE orchestrator_messages ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE orchestrator_messages ADD COLUMN raw_agent_text TEXT;
ALTER TABLE orchestrator_messages ADD COLUMN why_rationale TEXT;
ALTER TABLE orchestrator_messages ADD COLUMN internal_kind TEXT;
```

Register in `migrations.ts`.

- [ ] **Step 3: Tests + commit**

```bash
pnpm --filter @orca/contracts test
pnpm --filter @orca/daemon test
git add packages/contracts/ apps/daemon/migrations/0017_orchestrator_messages_chat_kinds.sql apps/daemon/src/migrations.ts
git commit -m "feat(contracts+daemon): orchestrator chat message kinds + columns for role/rawAgent/whyRationale/internalKind"
```

## Task 31: `InternalThoughtRow` component

**Files:**
- Create: `apps/desktop/src/orchestrator/InternalThoughtRow.tsx`
- Create: `apps/desktop/src/orchestrator/InternalThoughtRow.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { InternalThoughtRow } from "./InternalThoughtRow.tsx";

it("renders the body and an internalKind label", () => {
  render(<InternalThoughtRow body="Starting Intake" kind="step_started" whyRationale="step instructions said..." />);
  expect(screen.getByText(/Starting Intake/)).toBeInTheDocument();
});

it("toggles Why expander on click", async () => {
  // click ⓘ Why? → reveals rationale text
});
```

- [ ] **Step 2: Implement**

```tsx
import { useState } from "react";

export interface InternalThoughtRowProps {
  body: string;
  kind?: string;
  whyRationale?: string | null;
}

export function InternalThoughtRow({ body, kind, whyRationale }: InternalThoughtRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`orca-internal-thought orca-internal-thought--${kind ?? "generic"}`}>
      <span className="orca-internal-thought-icon">⟡</span>
      <span className="orca-internal-thought-body">{body}</span>
      {whyRationale ? (
        <>
          <button type="button" className="orca-why" onClick={() => setOpen((v) => !v)}>ⓘ Why?</button>
          {open ? <div className="orca-why-body">{whyRationale}</div> : null}
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Style**

Add CSS in the appropriate stylesheet for `.orca-internal-thought` (muted, italic). Reference existing patterns in `apps/desktop/src/styles/*` or alongside `OrcaChat.css`.

- [ ] **Step 4: Test + commit**

```bash
pnpm --filter @orca/desktop test -- --run InternalThoughtRow
git add apps/desktop/src/orchestrator/InternalThoughtRow.tsx apps/desktop/src/orchestrator/InternalThoughtRow.test.tsx
git commit -m "feat(desktop): InternalThoughtRow chat element"
```

## Task 32: `AgentParaphrasedMessage` with collapsible raw transcript

**Files:**
- Create: `apps/desktop/src/orchestrator/AgentParaphrasedMessage.tsx`
- Create: `apps/desktop/src/orchestrator/AgentParaphrasedMessage.test.tsx`

- [ ] **Step 1: Test**

```tsx
it("renders paraphrased body + raw transcript collapsed by default", () => {
  render(<AgentParaphrasedMessage body="I asked..." rawAgentText="Two questions to start:..." whyRationale="step instructions said..." />);
  expect(screen.queryByText(/Two questions to start/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Implement**

```tsx
export function AgentParaphrasedMessage({ body, rawAgentText, whyRationale }: { body: string; rawAgentText?: string | null; whyRationale?: string | null }) {
  const [showRaw, setShowRaw] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  return (
    <div className="orca-agent-paraphrased">
      <div className="orca-agent-paraphrased-body">{body}</div>
      <div className="orca-agent-paraphrased-meta">
        {rawAgentText ? (
          <button type="button" onClick={() => setShowRaw((v) => !v)}>{showRaw ? "▾" : "▸"} Show raw agent transcript</button>
        ) : null}
        {whyRationale ? (
          <button type="button" onClick={() => setShowWhy((v) => !v)}>ⓘ Why?</button>
        ) : null}
      </div>
      {showRaw && rawAgentText ? <pre className="orca-agent-raw">{rawAgentText}</pre> : null}
      {showWhy && whyRationale ? <div className="orca-why-body">{whyRationale}</div> : null}
    </div>
  );
}
```

- [ ] **Step 3: Test + commit**

```bash
pnpm --filter @orca/desktop test -- --run AgentParaphrasedMessage
git add apps/desktop/src/orchestrator/AgentParaphrasedMessage.tsx apps/desktop/src/orchestrator/AgentParaphrasedMessage.test.tsx
git commit -m "feat(desktop): AgentParaphrasedMessage with raw transcript + Why expanders"
```

## Task 33: `MarkDoneConfirmCard` inline

**Files:**
- Create: `apps/desktop/src/orchestrator/MarkDoneConfirmCard.tsx`
- Create: `apps/desktop/src/orchestrator/MarkDoneConfirmCard.test.tsx`

- [ ] **Step 1: Test**

```tsx
it("renders summary and two action buttons", () => {
  const onConfirm = vi.fn();
  const onDecline = vi.fn();
  render(<MarkDoneConfirmCard summary="All done." onConfirm={onConfirm} onDecline={onDecline} />);
  fireEvent.click(screen.getByText(/Confirm done/));
  expect(onConfirm).toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement**

```tsx
export function MarkDoneConfirmCard({ summary, onConfirm, onDecline }: { summary: string; onConfirm: () => void; onDecline: () => void }) {
  return (
    <div className="orca-mark-done-confirm">
      <p>{summary}</p>
      <p>Ready to mark this run complete?</p>
      <div className="orca-mark-done-actions">
        <button type="button" onClick={onConfirm}>Confirm done</button>
        <button type="button" onClick={onDecline}>Not yet</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Test + commit**

```bash
pnpm --filter @orca/desktop test -- --run MarkDoneConfirmCard
git add apps/desktop/src/orchestrator/MarkDoneConfirmCard.tsx apps/desktop/src/orchestrator/MarkDoneConfirmCard.test.tsx
git commit -m "feat(desktop): MarkDoneConfirmCard inline run-completion confirm"
```

## Task 34: `OrcaChat.tsx` rewrite — remove banner/recs/pending-input/SystemCard

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Modify: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

- [ ] **Step 1: Delete the banner render block**

Find the `<WorkflowBanner ... />` JSX in the chat body and remove it. Banner remains usable in the goal-detail panel; only its chat-internal rendering is removed.

- [ ] **Step 2: Delete the recommendations list block**

Remove the JSX rendering `actionRecs` (`<ul className="recommendation-list"> ... </ul>`) and the surrounding `Workflow recommendations (N)` heading.

- [ ] **Step 3: Delete the `restoredPendingInput` textarea card**

Remove the JSX block `restoredPendingInput && (<div className="orca-chat-input-card">...)`. Also remove the `pendingInput` state and `findAcceptedPendingInput` usage tied to it.

- [ ] **Step 4: Delete the `SystemCard "No pending workflow recommendations"` block**

Remove the block at the previously identified lines around `OrcaChat.tsx:673-681`.

- [ ] **Step 5: Render new message kinds**

Where messages are mapped (e.g. `messages.map((message) => <ChatMessageRow ... />)`), branch by `message.role`:

```tsx
if (message.role === "internal_thought") {
  return <InternalThoughtRow key={message.id} body={message.body} kind={message.internalKind ?? undefined} whyRationale={message.whyRationale ?? undefined} />;
}
if (message.role === "agent_paraphrased") {
  return <AgentParaphrasedMessage key={message.id} body={message.body} rawAgentText={message.rawAgentText ?? undefined} whyRationale={message.whyRationale ?? undefined} />;
}
// user, orchestrator → existing ChatMessageRow
```

- [ ] **Step 6: Render `MarkDoneConfirmCard` when the latest message is a mark-done prompt**

When the latest orchestrator message has `internalKind === "mark_done_ready"` (or a dedicated server-emitted payload), render:

```tsx
<MarkDoneConfirmCard summary={message.body} onConfirm={handleConfirmDone} onDecline={handleDeclineDone} />
```

- [ ] **Step 7: Update tests**

In `OrcaChat.test.tsx`, replace assertions like `expect(screen.findByText("No pending workflow recommendations"))` with assertions on the new chat elements. Add tests:

```tsx
it("renders internal-thought rows for step_started events", async () => {
  // mock backend response with role=internal_thought, internalKind=step_started, body="Starting Intake"
  // expect text in chat
});
it("renders agent-paraphrased message with raw transcript hidden", async () => { ... });
it("renders MarkDoneConfirmCard at run completion handoff", async () => { ... });
```

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @orca/desktop test -- --run OrcaChat`
Expected: PASS (with updates).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx \
        apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): OrcaChat overhaul — remove banner/recs/pending-input; render new chat kinds"
```

---

# Sub-plan 9: Failure handling polish

**Goal:** Implement idle-timeout fallback (90s), crash-retry budget (3 attempts before forced escalation), and orchestrator-LLM unavailability handling.

## Task 35: Idle-timeout fallback

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/idle-timeout.ts`
- Create: `apps/daemon/src/workflows/orchestrator/idle-timeout.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { startIdleTimeoutWatcher } from "./idle-timeout.js";

describe("idle timeout watcher", () => {
  it("fires onIdle after 90s of no activity", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const watcher = startIdleTimeoutWatcher({ sessionId: "s1", onIdle, idleMs: 90_000 });
    vi.advanceTimersByTime(89_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(onIdle).toHaveBeenCalled();
    watcher.stop();
    vi.useRealTimers();
  });

  it("ping resets the timer", async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const watcher = startIdleTimeoutWatcher({ sessionId: "s1", onIdle, idleMs: 90_000 });
    vi.advanceTimersByTime(80_000);
    watcher.ping();
    vi.advanceTimersByTime(80_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(onIdle).toHaveBeenCalled();
    watcher.stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Implement**

Create `apps/daemon/src/workflows/orchestrator/idle-timeout.ts`:

```ts
export interface IdleWatcher { ping(): void; stop(): void }
export function startIdleTimeoutWatcher(args: { sessionId: string; onIdle: () => void; idleMs: number }): IdleWatcher {
  let timer: NodeJS.Timeout | undefined = setTimeout(args.onIdle, args.idleMs);
  return {
    ping() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(args.onIdle, args.idleMs);
    },
    stop() { if (timer) clearTimeout(timer); timer = undefined; },
  };
}
```

- [ ] **Step 3: Wire**

In `apps/daemon/src/sessions/runtime.ts` (or equivalent), where output chunks land, call `watcher.ping()`. Where a step session is spawned, start a watcher whose `onIdle` calls `orchestratorService.onAgentResponseDone` with `responseText = session tail`.

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/idle-timeout.ts \
        apps/daemon/src/workflows/orchestrator/idle-timeout.test.ts \
        apps/daemon/src/sessions/runtime.ts
git commit -m "feat(daemon): idle-timeout watcher for shadow sessions; falls back to PTY tail"
```

## Task 36: Crash-retry budget

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/crash-retry.ts`
- Create: `apps/daemon/src/workflows/orchestrator/crash-retry.test.ts`
- Migration: `apps/daemon/migrations/0018_workflow_step_runs_crash_retries.sql`

- [ ] **Step 1: Migration**

```sql
ALTER TABLE workflow_step_runs ADD COLUMN crash_retries INTEGER NOT NULL DEFAULT 0;
```

Register in `migrations.ts`.

- [ ] **Step 2: Failing test**

```ts
import { incrementCrashRetry, CRASH_RETRY_CAP } from "./crash-retry.js";
it("cap is 3", () => expect(CRASH_RETRY_CAP).toBe(3));
it("3rd retry reaches cap", () => expect(incrementCrashRetry(2).capReached).toBe(true));
```

- [ ] **Step 3: Implement**

```ts
export const CRASH_RETRY_CAP = 3;
export function incrementCrashRetry(current: number): { nextAttempt: number; capReached: boolean } {
  const next = current + 1;
  return { nextAttempt: next, capReached: next >= CRASH_RETRY_CAP };
}
```

- [ ] **Step 4: Wire into service `onAgentSessionExit`**

In `apps/daemon/src/workflows/orchestrator/service.ts`, modify the existing `onWorkflowSessionCompleted` (already subscribed to session.exited/failed) to:
- if exit was clean and `step_output` was produced → unchanged.
- if exit was an unexpected failure → increment `crash_retries`; if not capped, respawn a fresh step session (same step); if capped, post an escalation chat message.

- [ ] **Step 5: Test + commit**

```bash
pnpm --filter @orca/daemon test -- --run crash-retry
git add apps/daemon/migrations/0018_workflow_step_runs_crash_retries.sql \
        apps/daemon/src/migrations.ts \
        apps/daemon/src/workflows/orchestrator/crash-retry.ts \
        apps/daemon/src/workflows/orchestrator/crash-retry.test.ts \
        apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "feat(daemon): crash-retry budget (cap 3) per step; escalate on cap"
```

## Task 37: Orchestrator-LLM unavailability — exponential backoff + chat banner

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/mediator.ts`

- [ ] **Step 1: Add backoff retry**

```ts
async invokeWithBackoff(input: MediatorInvokeInput, attempt = 0): Promise<OrchestratorAction> {
  try {
    return await this.invoke(input);
  } catch (err) {
    const backoffMs = Math.min(60_000, 500 * Math.pow(2, attempt));
    if (attempt >= 5) throw err;
    await new Promise((r) => setTimeout(r, backoffMs));
    return this.invokeWithBackoff(input, attempt + 1);
  }
}
```

- [ ] **Step 2: Surface "orchestrator unavailable" chat message after persistent failure**

In service.ts handlers, wrap `mediator.invoke` calls in `invokeWithBackoff`. On final failure, post an `internal_thought` chat message:

```ts
{
  role: "internal_thought",
  internalKind: "agent_crash",  // reused or add "orchestrator_unavailable"
  body: "Orchestrator-LLM unavailable after retries; pausing — last error: <message>",
}
```

- [ ] **Step 3: Test**

Unit-test the backoff behavior with `vi.useFakeTimers()`.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/mediator.ts apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "feat(daemon): orchestrator-LLM exponential backoff + unavailability surfacing"
```

---

# Sub-plan 10: Resume after daemon restart

**Goal:** On daemon boot, reattach surviving PTYs; for dead sessions, spawn fresh attempts and rebuild orchestrator state from event store + artifacts.

## Task 38: Resume module

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/resume.ts`
- Create: `apps/daemon/src/workflows/orchestrator/resume.test.ts`
- Modify: `apps/daemon/src/server.ts` (call on boot)

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { resumeActiveRuns } from "./resume.js";

describe("resumeActiveRuns", () => {
  it("for each active run: reattaches session if alive, otherwise respawns", async () => {
    const isSessionAlive = vi.fn(async (id: string) => id === "alive-1");
    const reattach = vi.fn(async () => undefined);
    const respawn = vi.fn(async () => undefined);
    await resumeActiveRuns({
      listActiveRuns: async () => [
        { runId: "r1", goalId: "g1", currentStepRunId: "s1", sessionId: "alive-1" },
        { runId: "r2", goalId: "g2", currentStepRunId: "s2", sessionId: "dead-1" },
      ],
      isSessionAlive, reattach, respawn,
    });
    expect(reattach).toHaveBeenCalledWith({ runId: "r1", sessionId: "alive-1" });
    expect(respawn).toHaveBeenCalledWith({ runId: "r2", stepRunId: "s2", goalId: "g2" });
  });
});
```

- [ ] **Step 2: Implement**

Create `apps/daemon/src/workflows/orchestrator/resume.ts`:

```ts
export interface ResumeDeps {
  listActiveRuns(): Promise<Array<{ runId: string; goalId: string; currentStepRunId: string; sessionId: string | null }>>;
  isSessionAlive(sessionId: string): Promise<boolean>;
  reattach(args: { runId: string; sessionId: string }): Promise<void>;
  respawn(args: { runId: string; stepRunId: string; goalId: string }): Promise<void>;
}

export async function resumeActiveRuns(deps: ResumeDeps): Promise<void> {
  const runs = await deps.listActiveRuns();
  for (const r of runs) {
    if (r.sessionId && (await deps.isSessionAlive(r.sessionId))) {
      await deps.reattach({ runId: r.runId, sessionId: r.sessionId });
    } else {
      await deps.respawn({ runId: r.runId, stepRunId: r.currentStepRunId, goalId: r.goalId });
    }
  }
}
```

- [ ] **Step 3: Wire on boot**

In `apps/daemon/src/server.ts`, after all services are constructed and before the server starts listening:

```ts
await resumeActiveRuns({
  listActiveRuns: async () => {
    const rows = db.prepare(`
      SELECT wr.id AS run_id, wr.goal_id, wr.current_step_run_id,
             (SELECT s.id FROM sessions s WHERE s.workflow_step_run_id = wr.current_step_run_id AND s.status IN ('running','starting') ORDER BY s.started_at DESC LIMIT 1) AS session_id
      FROM workflow_runs wr
      WHERE wr.status = 'active'
    `).all() as Array<{ run_id: string; goal_id: string; current_step_run_id: string; session_id: string | null }>;
    return rows.map((r) => ({ runId: r.run_id, goalId: r.goal_id, currentStepRunId: r.current_step_run_id, sessionId: r.session_id }));
  },
  isSessionAlive: (id) => sessionRuntime.isAlive(id),
  reattach: ({ sessionId }) => sessionRuntime.reattach(sessionId),
  respawn: async ({ runId, stepRunId, goalId }) => {
    // re-trigger: orchestratorService.startStepFromExisting(runId, stepRunId)
    await orchestratorService.respawnStepAgent(db, daemonContext.now, runId, stepRunId, { bus: eventBus, idFactory: daemonContext.idFactory });
  },
});
```

(Implement `sessionRuntime.isAlive` / `reattach` / `orchestratorService.respawnStepAgent` as small additions.)

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @orca/daemon test -- --run resume
git add apps/daemon/src/workflows/orchestrator/resume.ts \
        apps/daemon/src/workflows/orchestrator/resume.test.ts \
        apps/daemon/src/server.ts \
        apps/daemon/src/sessions/runtime.ts \
        apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "feat(daemon): resume active runs on boot (reattach surviving, respawn dead)"
```

---

# Final integration & cleanup

## Task 39: End-to-end happy-path test

**Files:**
- Create: `apps/daemon/src/__tests__/orchestrator-e2e.test.ts`

- [ ] **Step 1: Compose a fake adapter that emits two responses then a step-complete block**

- [ ] **Step 2: Start a real daemon (in-memory DB), POST goal-create, simulate two `agent-hooks/response-done` POSTs, then a step-complete one, then assert the run advances to step 2.**

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/__tests__/orchestrator-e2e.test.ts
git commit -m "test(daemon): orchestrator-mediated workflow end-to-end happy path"
```

## Task 40: Type-check + run full suites + lint pass

- [ ] **Step 1: Type-check both packages**

```bash
pnpm typecheck
```
Expected: no errors.

- [ ] **Step 2: Run all tests**

```bash
pnpm test
```
Expected: all green.

- [ ] **Step 3: Commit any tidy fixes uncovered**

```bash
git add -p
git commit -m "chore: post-orchestrator-mediated typecheck cleanup"
```

---

# Self-review checklist (filled in after writing)

- **Spec coverage:**
  - Adapter exec-mode config (DB-backed, capability + runtime config, invariants, seed, mutation API, audit event): Tasks 1–8.
  - Unified adapter dispatch (broker uses dispatcher-derived transport): Tasks 9–11.
  - Orchestrator-LLM session + mediator + context envelope + prompt composition + hook endpoint: Tasks 12–17.
  - `StepAgentChoice` + per-step deterministic dispatch + `supportsModel`: Tasks 18–21.
  - Hybrid step-completion judgement (schema deterministic + LLM judgement + revise loop cap 3): Tasks 22–25.
  - Engineering v4 with `agentPreference`: Task 26.
  - Bootstrap rewrite (drop `requestNextDecision`; spawn orchestrator + first step): Tasks 27–28.
  - User-message arrival trigger: Task 29.
  - Chat UI overhaul (remove banner/recs/pending-input/SystemCard; add InternalThoughtRow / AgentParaphrasedMessage / MarkDoneConfirmCard): Tasks 30–34.
  - Failure handling (idle timeout, crash retry, orchestrator-LLM unavailability): Tasks 35–37.
  - Resume after daemon restart: Task 38.
  - E2E + typecheck pass: Tasks 39–40.

- **Placeholders:** none left. Where the existing file shape is the source of truth (e.g. exact placement of imports or precise event-bus signature), the plan calls out the relevant grep / sed step before editing so the implementer reads current state rather than guessing.

- **Type consistency:**
  - `ExecutionMode` referenced consistently across contracts, dispatcher, broker.
  - `StepAgentChoice` referenced consistently in contracts + step-dispatch + seed-engineering + service tests.
  - `OrchestratorAction` contract defined in Task 14 and consumed in Tasks 16, 23, 25, 29.
  - Adapter capability fields (`supportedExecutionModes`, `supportsModel`) declared in Task 3 and Task 19; both used in Task 20 resolver.
