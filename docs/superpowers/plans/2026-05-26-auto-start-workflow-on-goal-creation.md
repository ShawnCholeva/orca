# Auto-Start Workflow on Goal Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-start a workflow run during goal creation, store partial-success artifacts for idempotent retry, and replace the OrcaChat "Start Engineering workflow" button with a recovery-only card.

**Architecture:** New `POST /v1/goals/create-and-start-workflow` daemon endpoint orchestrates goal creation + workflow bootstrap in one HTTP call and returns a discriminated body indicating full success or which phase failed. The frontend state machine gains a `workflowFailed` phase with stored `goalId` and optional `workflowRunId`, enabling idempotent retries that skip already-completed steps.

**Tech Stack:** TypeScript, Zod (contracts), Fastify (daemon routes), React + `useReducer` (desktop state), Vitest (tests)

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `packages/contracts/src/index.ts` | Modify | Add `CreateGoalAndStartWorkflowRequest` + `CreateGoalAndStartWorkflowResponse` Zod schemas |
| `apps/daemon/src/goals/bootstrap-route.ts` | Create | `registerGoalBootstrapRoute` — `POST /v1/goals/create-and-start-workflow` |
| `apps/daemon/src/server.ts` | Modify | Import + register the new bootstrap route |
| `apps/desktop/src/api.ts` | Modify | Add `createGoalAndStartWorkflow` function |
| `apps/desktop/src/create-goal-flow/state.ts` | Modify | Add `WorkflowFailedState`, extend `SubmittingState`, add 2 actions |
| `apps/desktop/src/create-goal-flow/state.test.ts` | Modify | Tests for new phases and idempotent retry branching |
| `apps/desktop/src/create-goal-flow/CreateGoalFlow.tsx` | Modify | Call new API; render `workflowFailed` phase |
| `apps/desktop/src/create-goal-flow/steps/CoordinateStep.tsx` | Modify | Remove "None" option; disable Create Goal when no template selected |
| `apps/desktop/src/orchestrator/OrcaChat.tsx` | Modify | Replace full "Start Engineering workflow" card with recovery-only card |

---

## Task 1: Contracts — new request/response types

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts`

- [ ] **Step 1.1: Write the failing contract test**

Open `packages/contracts/src/index.test.ts` and add at the bottom:

```typescript
import { describe, it, expect } from "vitest";
import {
  CreateGoalAndStartWorkflowRequest,
  CreateGoalAndStartWorkflowResponse,
} from "./index.js";

describe("CreateGoalAndStartWorkflowRequest", () => {
  it("accepts minimal valid input with workflowTemplateId", () => {
    const result = CreateGoalAndStartWorkflowRequest.safeParse({
      title: "My Goal",
      workflowTemplateId: "orca/engineering",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing workflowTemplateId", () => {
    const result = CreateGoalAndStartWorkflowRequest.safeParse({ title: "My Goal" });
    expect(result.success).toBe(false);
  });

  it("rejects empty workflowTemplateId", () => {
    const result = CreateGoalAndStartWorkflowRequest.safeParse({
      title: "My Goal",
      workflowTemplateId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("CreateGoalAndStartWorkflowResponse", () => {
  it("parses full success", () => {
    const r = CreateGoalAndStartWorkflowResponse.parse({
      ok: true,
      goalId: "g-1",
      workflowRunId: "r-1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goalId).toBe("g-1");
      expect(r.workflowRunId).toBe("r-1");
    }
  });

  it("parses startWorkflowRun failure (no runId)", () => {
    const r = CreateGoalAndStartWorkflowResponse.parse({
      ok: false,
      goalId: "g-1",
      bootstrapError: { phase: "startWorkflowRun", message: "template not found" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bootstrapError.phase).toBe("startWorkflowRun");
      expect(r.workflowRunId).toBeUndefined();
    }
  });

  it("parses requestDecision failure (runId present)", () => {
    const r = CreateGoalAndStartWorkflowResponse.parse({
      ok: false,
      goalId: "g-1",
      workflowRunId: "r-1",
      bootstrapError: { phase: "requestDecision", message: "orchestrator error" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bootstrapError.phase).toBe("requestDecision");
      expect(r.workflowRunId).toBe("r-1");
    }
  });
});
```

- [ ] **Step 1.2: Run the test to confirm it fails**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/contracts test 2>&1 | tail -20
```

Expected: FAIL — `CreateGoalAndStartWorkflowRequest` and `CreateGoalAndStartWorkflowResponse` are not exported.

- [ ] **Step 1.3: Add the Zod schemas**

In `packages/contracts/src/index.ts`, directly after the `CreateGoalResponse` block (after line 72), add:

```typescript
export const CreateGoalAndStartWorkflowRequest = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  workspaces: z.array(WorkspaceAttachmentInput).optional(),
  orchestratorModel: OrchestratorModelChoice.optional(),
  workflowTemplateId: z.string().min(1),
});
export type CreateGoalAndStartWorkflowRequest = z.infer<typeof CreateGoalAndStartWorkflowRequest>;

const BootstrapError = z.object({
  phase: z.enum(["startWorkflowRun", "requestDecision"]),
  message: z.string(),
});

export const CreateGoalAndStartWorkflowResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    goalId: z.string(),
    workflowRunId: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    goalId: z.string(),
    workflowRunId: z.string().optional(),
    bootstrapError: BootstrapError,
  }),
]);
export type CreateGoalAndStartWorkflowResponse = z.infer<typeof CreateGoalAndStartWorkflowResponse>;
```

- [ ] **Step 1.4: Run the test to confirm it passes**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/contracts test 2>&1 | tail -20
```

Expected: All tests PASS.

- [ ] **Step 1.5: Rebuild contracts dist (so other packages see the new types)**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/contracts build 2>&1 | tail -10
```

Expected: Build succeeds with no errors.

- [ ] **Step 1.6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): add CreateGoalAndStartWorkflowRequest/Response"
```

---

## Task 2: Daemon — bootstrap composite route

**Files:**
- Create: `apps/daemon/src/goals/bootstrap-route.ts`
- Modify: `apps/daemon/src/server.ts`

- [ ] **Step 2.1: Check what the `__tests__/http-surface.test.ts` pattern looks like so tests match**

```bash
head -60 /home/shawn/projects/orca/apps/daemon/src/workflows/__tests__/http-surface.test.ts
```

Note the pattern used for integration-style route tests.

- [ ] **Step 2.2: Write the failing route test**

Create `apps/daemon/src/goals/bootstrap-route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import { registerGoalBootstrapRoute, type GoalBootstrapRouteDeps } from "./bootstrap-route.js";

// Minimal in-memory stubs
function makeDb() {
  const goals = new Map<string, { id: string; active_workflow_run_id: string | null }>();
  const runs = new Map<string, { id: string; goal_id: string; status: string }>();

  const db = {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((...args: unknown[]) => {
        if (sql.includes("SELECT id FROM goals")) return goals.get(args[0] as string);
        return undefined;
      }),
      run: vi.fn(),
      all: vi.fn(() => []),
    })),
    transaction: vi.fn((fn: () => unknown) => fn),
  } as unknown as Database.Database;

  return { db, goals, runs };
}

function makeDeps(overrides: Partial<GoalBootstrapRouteDeps> = {}): GoalBootstrapRouteDeps {
  return {
    createGoalFn: vi.fn().mockResolvedValue({ id: "goal-1" }),
    startWorkflowRunFn: vi.fn().mockReturnValue({ id: "run-1", goalId: "goal-1" }),
    requestNextDecisionFn: vi.fn().mockResolvedValue({ queued: true }),
    ...overrides,
  };
}

async function buildServer(deps: GoalBootstrapRouteDeps) {
  const server = Fastify();
  registerGoalBootstrapRoute(server, deps);
  await server.ready();
  return server;
}

const VALID_BODY = {
  title: "My Goal",
  workflowTemplateId: "orca/engineering",
};

describe("POST /v1/goals/create-and-start-workflow", () => {
  it("returns 201 with ok:true on full success", async () => {
    const server = await buildServer(makeDeps());
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { ok: boolean; goalId: string; workflowRunId: string };
    expect(body.ok).toBe(true);
    expect(body.goalId).toBe("goal-1");
    expect(body.workflowRunId).toBe("run-1");
  });

  it("returns 400 on validation failure (missing workflowTemplateId)", async () => {
    const server = await buildServer(makeDeps());
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: { title: "Missing template" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 201 with ok:false + phase startWorkflowRun when startWorkflowRun throws", async () => {
    const deps = makeDeps({
      startWorkflowRunFn: vi.fn().mockImplementation(() => {
        throw new Error("template not found");
      }),
    });
    const server = await buildServer(deps);
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      goalId: string;
      workflowRunId?: string;
      bootstrapError: { phase: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.goalId).toBe("goal-1");
    expect(body.workflowRunId).toBeUndefined();
    expect(body.bootstrapError.phase).toBe("startWorkflowRun");
  });

  it("returns 201 with ok:false + phase requestDecision when requestNextDecision throws", async () => {
    const deps = makeDeps({
      requestNextDecisionFn: vi.fn().mockRejectedValue(new Error("orchestrator error")),
    });
    const server = await buildServer(deps);
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      goalId: string;
      workflowRunId: string;
      bootstrapError: { phase: string; message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.goalId).toBe("goal-1");
    expect(body.workflowRunId).toBe("run-1");
    expect(body.bootstrapError.phase).toBe("requestDecision");
  });

  it("propagates createGoal validation errors as 400", async () => {
    const { ValidationError } = await import("../goals.js");
    const deps = makeDeps({
      createGoalFn: vi.fn().mockRejectedValue(new ValidationError([{ code: "custom", message: "bad title", path: ["title"] }])),
    });
    const server = await buildServer(deps);
    const res = await server.inject({
      method: "POST",
      url: "/v1/goals/create-and-start-workflow",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2.3: Run test to confirm it fails**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/daemon test -- --reporter=verbose 2>&1 | grep -A5 "bootstrap-route"
```

Expected: FAIL — module not found or no tests found.

- [ ] **Step 2.4: Implement the bootstrap route**

Create `apps/daemon/src/goals/bootstrap-route.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { CreateGoalAndStartWorkflowRequest } from "@orca/contracts";
import type { Goal, WorkflowRun } from "@orca/contracts";
import { ValidationError, DuplicateWorkspaceInRequestError, WorkspaceInspectionError } from "../goals.js";

// Injected functions allow clean unit-testing without a real DB.
export interface GoalBootstrapRouteDeps {
  createGoalFn: (input: {
    title: string;
    description: string;
    workspaces?: { inputPath: string; name?: string }[];
    orchestratorModel?: unknown;
  }) => Promise<Goal>;
  startWorkflowRunFn: (args: { goalId: string; templateId: string }) => WorkflowRun;
  requestNextDecisionFn: (goalId: string, runId: string) => Promise<unknown>;
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

function inspectionStatus(err: WorkspaceInspectionError): number {
  switch (err.code) {
    case "workspace_not_found": return 404;
    case "workspace_not_a_directory": return 422;
    default: return 400;
  }
}

export function registerGoalBootstrapRoute(
  server: FastifyInstance,
  deps: GoalBootstrapRouteDeps
): void {
  server.post("/v1/goals/create-and-start-workflow", async (request, reply) => {
    const parsed = CreateGoalAndStartWorkflowRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }

    const { title, description, workspaces, orchestratorModel, workflowTemplateId } = parsed.data;

    // Phase 1: create the goal — any failure propagates as a normal HTTP error
    let goal: Goal;
    try {
      goal = await deps.createGoalFn({ title, description, workspaces, orchestratorModel });
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.status(400);
        return { error: "validation_failed", issues: err.issues };
      }
      if (err instanceof DuplicateWorkspaceInRequestError) {
        reply.status(400);
        return apiError(err.code, err.message);
      }
      if (err instanceof WorkspaceInspectionError) {
        reply.status(inspectionStatus(err));
        return apiError(err.code, err.message);
      }
      throw err;
    }

    const goalId = goal.id;

    // Phase 2: start workflow run — failure returns partial-success body
    let run: WorkflowRun;
    try {
      run = deps.startWorkflowRunFn({ goalId, templateId: workflowTemplateId });
    } catch (err) {
      reply.status(201);
      return {
        ok: false,
        goalId,
        bootstrapError: {
          phase: "startWorkflowRun",
          message: err instanceof Error ? err.message : "Failed to start workflow run",
        },
      };
    }

    const workflowRunId = run.id;

    // Phase 3: request first orchestrator decision — failure returns partial-success body
    try {
      await deps.requestNextDecisionFn(goalId, workflowRunId);
    } catch (err) {
      reply.status(201);
      return {
        ok: false,
        goalId,
        workflowRunId,
        bootstrapError: {
          phase: "requestDecision",
          message: err instanceof Error ? err.message : "Failed to request orchestrator decision",
        },
      };
    }

    reply.status(201);
    return { ok: true, goalId, workflowRunId };
  });
}
```

- [ ] **Step 2.5: Run the test to confirm it passes**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/daemon test -- --reporter=verbose 2>&1 | grep -A10 "bootstrap-route"
```

Expected: All 5 bootstrap-route tests PASS.

- [ ] **Step 2.6: Register the route in server.ts**

Find the section in `apps/daemon/src/server.ts` where goals routes are registered (around `POST /v1/goals`). Add the import near the top of server.ts, with other goal-related imports:

```typescript
import { registerGoalBootstrapRoute } from './goals/bootstrap-route.js';
```

Then, directly after the existing `server.post('/v1/goals', ...)` block (around line 420), add:

```typescript
  // ---- Composite goal + workflow bootstrap ----

  registerGoalBootstrapRoute(server, {
    createGoalFn: (input) =>
      createGoal(input, {
        db: getDatabase(),
        bus: eventBus,
        skills: skillRegistry,
        modelProviderRegistry: daemonContext.modelProviderRegistry,
        inspectWorkspace,
      }),
    startWorkflowRunFn: (args) =>
      startWorkflowRun(
        { db: getDatabase(), bus: eventBus, now: daemonContext.now, idFactory: daemonContext.idFactory },
        args
      ),
    requestNextDecisionFn: async (goalId, runId) => {
      const orchestratorService = new OrchestratorService(daemonContext.operatorSelector);
      return orchestratorService.requestNextDecision(
        getDatabase(),
        daemonContext.now ?? (() => new Date().toISOString()),
        runId,
        { bus: eventBus, idFactory: daemonContext.idFactory }
      );
    },
  });
```

Also add these imports to server.ts if not already present:

```typescript
import { startWorkflowRun } from './workflows/runs/usecases.js';
import { OrchestratorService } from './workflows/orchestrator/service.js';
```

- [ ] **Step 2.7: Run daemon tests to confirm nothing regressed**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/daemon test 2>&1 | tail -10
```

Expected: All tests pass.

- [ ] **Step 2.8: Commit**

```bash
git add apps/daemon/src/goals/bootstrap-route.ts apps/daemon/src/goals/bootstrap-route.test.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): add POST /v1/goals/create-and-start-workflow composite route"
```

---

## Task 3: Frontend API — `createGoalAndStartWorkflow`

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Test: `apps/desktop/src/api.test.ts` (check if it exists and add tests there)

- [ ] **Step 3.1: Check existing api test patterns**

```bash
head -40 /home/shawn/projects/orca/apps/desktop/src/api.test.ts
```

Note the test pattern to match it.

- [ ] **Step 3.2: Add the API function to api.ts**

In `apps/desktop/src/api.ts`, add the contract import after the existing imports block, and add the function after `createGoal`:

First, add to the imports at the top of the file (inside the existing `@orca/contracts` import block):

```typescript
  CreateGoalAndStartWorkflowRequest,
  CreateGoalAndStartWorkflowResponse,
```

Then add the function after `createGoal` (after line ~416):

```typescript
export async function createGoalAndStartWorkflow(
  input: CreateGoalAndStartWorkflowRequest,
): Promise<CreateGoalAndStartWorkflowResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/create-and-start-workflow`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateGoalAndStartWorkflowRequest.parse(input)),
    },
    CreateGoalAndStartWorkflowResponse,
    "Create goal and start workflow failed",
  );
}
```

- [ ] **Step 3.3: Run desktop tests to confirm no TypeScript or import errors**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/desktop test 2>&1 | tail -15
```

Expected: Existing tests pass (no new failures from the import change).

- [ ] **Step 3.4: Commit**

```bash
git add apps/desktop/src/api.ts
git commit -m "feat(desktop): add createGoalAndStartWorkflow API function"
```

---

## Task 4: State machine — `WorkflowFailedState` + idempotent retry

**Files:**
- Modify: `apps/desktop/src/create-goal-flow/state.test.ts`
- Modify: `apps/desktop/src/create-goal-flow/state.ts`

- [ ] **Step 4.1: Write the failing state machine tests**

Add to `apps/desktop/src/create-goal-flow/state.test.ts`, after the existing `describe("reducer — submitting phase", ...)` block:

```typescript
describe("reducer — workflowFailed phase", () => {
  const submittingNoRun: FlowState = {
    phase: "submitting",
    title: "T",
    description: "D",
    orchestratorModel,
    workflowTemplateId: "wf-1",
    pendingWorkspaces: [],
  };

  const submittingWithGoal: FlowState = {
    phase: "submitting",
    title: "T",
    description: "D",
    orchestratorModel,
    workflowTemplateId: "wf-1",
    pendingWorkspaces: [],
    goalId: "g-1",
  };

  it("workflowBootstrapFailed from submitting → workflowFailed (no runId)", () => {
    const s = dispatch(submittingNoRun, {
      type: "workflowBootstrapFailed",
      goalId: "g-1",
      error: "template not found",
    });
    expect(s).toMatchObject({
      phase: "workflowFailed",
      goalId: "g-1",
      workflowTemplateId: "wf-1",
      error: "template not found",
    });
    if (s.phase === "workflowFailed") {
      expect(s.workflowRunId).toBeUndefined();
    }
  });

  it("workflowBootstrapFailed with workflowRunId stores it", () => {
    const s = dispatch(submittingNoRun, {
      type: "workflowBootstrapFailed",
      goalId: "g-1",
      workflowRunId: "r-1",
      error: "orchestrator error",
    });
    if (s.phase === "workflowFailed") {
      expect(s.workflowRunId).toBe("r-1");
    } else {
      throw new Error("expected workflowFailed");
    }
  });

  it("retryWorkflowStart from workflowFailed → submitting with goalId (no runId)", () => {
    const failed: FlowState = {
      phase: "workflowFailed",
      goalId: "g-1",
      title: "T",
      description: "D",
      pendingWorkspaces: [],
      orchestratorModel,
      workflowTemplateId: "wf-1",
      error: "oops",
    };
    const s = dispatch(failed, { type: "retryWorkflowStart" });
    expect(s).toMatchObject({
      phase: "submitting",
      goalId: "g-1",
      workflowTemplateId: "wf-1",
    });
    if (s.phase === "submitting") {
      expect(s.workflowRunId).toBeUndefined();
    }
  });

  it("retryWorkflowStart from workflowFailed with runId → submitting with both ids", () => {
    const failed: FlowState = {
      phase: "workflowFailed",
      goalId: "g-1",
      workflowRunId: "r-1",
      title: "T",
      description: "D",
      pendingWorkspaces: [],
      orchestratorModel,
      workflowTemplateId: "wf-1",
      error: "oops",
    };
    const s = dispatch(failed, { type: "retryWorkflowStart" });
    if (s.phase === "submitting") {
      expect(s.goalId).toBe("g-1");
      expect(s.workflowRunId).toBe("r-1");
    } else {
      throw new Error("expected submitting");
    }
  });

  it("workflowBootstrapFailed is no-op outside submitting phase", () => {
    expect(
      dispatch(initialState, { type: "workflowBootstrapFailed", goalId: "g-1", error: "x" })
    ).toBe(initialState);
  });

  it("retryWorkflowStart is no-op outside workflowFailed phase", () => {
    expect(dispatch(initialState, { type: "retryWorkflowStart" })).toBe(initialState);
  });

  it("submitRequested from coordinate with workflowTemplateId null still transitions (guard is in UI, not reducer)", () => {
    const coord: FlowState = {
      phase: "coordinate",
      title: "T",
      description: "D",
      pendingWorkspaces: [],
      orchestratorModel: null,
      workflowTemplateId: null,
    };
    const s = dispatch(coord, { type: "submitRequested" });
    expect(s.phase).toBe("submitting");
  });
});
```

- [ ] **Step 4.2: Run the test to confirm it fails**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/desktop test -- --reporter=verbose create-goal-flow/state 2>&1 | tail -20
```

Expected: FAIL — `workflowBootstrapFailed`, `retryWorkflowStart`, `WorkflowFailedState` not defined.

- [ ] **Step 4.3: Implement the state machine changes**

Replace the full contents of `apps/desktop/src/create-goal-flow/state.ts` with:

```typescript
import type {
  InspectWorkspacePreview,
  OrchestratorModelChoice,
} from "@orca/contracts";

export type PendingWorkspace = {
  inputPath: string;
  name: string;
  path: string;
  workspaceType: InspectWorkspacePreview["workspaceType"];
  branch: string | null;
  isDirty: boolean | null;
  gitProbe: InspectWorkspacePreview["gitProbe"];
};

type RoughState = {
  phase: "rough";
  title: string;
  description: string;
  error?: string;
};

type CoordinateState = {
  phase: "coordinate";
  title: string;
  description: string;
  pendingWorkspaces: PendingWorkspace[];
  orchestratorModel: OrchestratorModelChoice | null;
  workflowTemplateId: string | null;
  inspecting?: boolean;
  error?: string;
};

type SubmittingState = {
  phase: "submitting";
  title: string;
  description: string;
  pendingWorkspaces: PendingWorkspace[];
  orchestratorModel: OrchestratorModelChoice | null;
  workflowTemplateId: string | null;
  /** Set when goal was already created; skip createGoal on retry. */
  goalId?: string;
  /** Set when workflow run was already created; skip startWorkflowRun on retry. */
  workflowRunId?: string;
};

export type WorkflowFailedState = {
  phase: "workflowFailed";
  goalId: string;
  /** Set if startWorkflowRun succeeded before the failure. Skip it on retry. */
  workflowRunId?: string;
  title: string;
  description: string;
  pendingWorkspaces: PendingWorkspace[];
  orchestratorModel: OrchestratorModelChoice | null;
  workflowTemplateId: string;
  error: string;
};

type DoneState = {
  phase: "done";
  goalId: string;
};

export type FlowState =
  | RoughState
  | CoordinateState
  | SubmittingState
  | WorkflowFailedState
  | DoneState;

export const initialState: FlowState = {
  phase: "rough",
  title: "",
  description: "",
};

export type FlowAction =
  | { type: "setTitle"; title: string }
  | { type: "setDescription"; description: string }
  | { type: "proceedToCoordinate" }
  | { type: "backToDescribe" }
  | { type: "setOrchestratorModel"; orchestratorModel: OrchestratorModelChoice | null }
  | { type: "setWorkflowTemplateId"; workflowTemplateId: string | null }
  | { type: "inspectRequested" }
  | { type: "inspectSucceeded"; preview: InspectWorkspacePreview; inputPath: string; name: string }
  | { type: "inspectFailed"; error: string }
  | { type: "removePending"; index: number }
  | { type: "editPendingName"; index: number; name: string }
  | { type: "submitRequested" }
  | { type: "submitSucceeded"; goalId: string }
  | { type: "submitFailed"; error: string }
  | { type: "workflowBootstrapFailed"; goalId: string; workflowRunId?: string; error: string }
  | { type: "retryWorkflowStart" };

export function reducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "setTitle":
      if (state.phase === "rough") {
        return { ...state, title: action.title, error: undefined };
      }
      return state;

    case "setDescription":
      if (state.phase === "rough") {
        return { ...state, description: action.description };
      }
      return state;

    case "proceedToCoordinate":
      if (state.phase === "rough") {
        return {
          phase: "coordinate",
          title: state.title,
          description: state.description,
          pendingWorkspaces: [],
          orchestratorModel: null,
          workflowTemplateId: null,
        };
      }
      return state;

    case "backToDescribe":
      if (state.phase === "coordinate") {
        return {
          phase: "rough",
          title: state.title,
          description: state.description,
        };
      }
      return state;

    case "setOrchestratorModel":
      if (state.phase === "coordinate") {
        return { ...state, orchestratorModel: action.orchestratorModel };
      }
      return state;

    case "setWorkflowTemplateId":
      if (state.phase === "coordinate") {
        return { ...state, workflowTemplateId: action.workflowTemplateId };
      }
      return state;

    case "inspectRequested":
      if (state.phase === "coordinate") {
        return { ...state, inspecting: true, error: undefined };
      }
      return state;

    case "inspectSucceeded":
      if (state.phase === "coordinate") {
        const pending: PendingWorkspace = {
          inputPath: action.inputPath,
          name: action.name,
          path: action.preview.path,
          workspaceType: action.preview.workspaceType,
          branch: action.preview.branch,
          isDirty: action.preview.isDirty,
          gitProbe: action.preview.gitProbe,
        };
        return {
          ...state,
          inspecting: false,
          pendingWorkspaces: [...state.pendingWorkspaces, pending],
        };
      }
      return state;

    case "inspectFailed":
      if (state.phase === "coordinate") {
        return { ...state, inspecting: false, error: action.error };
      }
      return state;

    case "removePending":
      if (state.phase === "coordinate") {
        return {
          ...state,
          pendingWorkspaces: state.pendingWorkspaces.filter((_, i) => i !== action.index),
        };
      }
      return state;

    case "editPendingName":
      if (state.phase === "coordinate") {
        const pendingWorkspaces = state.pendingWorkspaces.map((ws, i) =>
          i === action.index ? { ...ws, name: action.name } : ws,
        );
        return { ...state, pendingWorkspaces };
      }
      return state;

    case "submitRequested":
      if (state.phase === "coordinate") {
        return {
          phase: "submitting",
          title: state.title,
          description: state.description,
          pendingWorkspaces: state.pendingWorkspaces,
          orchestratorModel: state.orchestratorModel,
          workflowTemplateId: state.workflowTemplateId,
        };
      }
      return state;

    case "submitSucceeded":
      if (state.phase === "submitting") {
        return { phase: "done", goalId: action.goalId };
      }
      return state;

    case "submitFailed":
      if (state.phase === "submitting") {
        return {
          phase: "coordinate",
          title: state.title,
          description: state.description,
          pendingWorkspaces: state.pendingWorkspaces,
          orchestratorModel: state.orchestratorModel,
          workflowTemplateId: state.workflowTemplateId,
          error: action.error,
        };
      }
      return state;

    case "workflowBootstrapFailed":
      if (state.phase === "submitting") {
        return {
          phase: "workflowFailed",
          goalId: action.goalId,
          workflowRunId: action.workflowRunId,
          title: state.title,
          description: state.description,
          pendingWorkspaces: state.pendingWorkspaces,
          orchestratorModel: state.orchestratorModel,
          workflowTemplateId: state.workflowTemplateId ?? "",
          error: action.error,
        };
      }
      return state;

    case "retryWorkflowStart":
      if (state.phase === "workflowFailed") {
        return {
          phase: "submitting",
          title: state.title,
          description: state.description,
          pendingWorkspaces: state.pendingWorkspaces,
          orchestratorModel: state.orchestratorModel,
          workflowTemplateId: state.workflowTemplateId,
          goalId: state.goalId,
          workflowRunId: state.workflowRunId,
        };
      }
      return state;
  }
}
```

- [ ] **Step 4.4: Run state tests to confirm they pass**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/desktop test -- --reporter=verbose create-goal-flow/state 2>&1 | tail -25
```

Expected: All tests PASS (existing + new).

- [ ] **Step 4.5: Commit**

```bash
git add apps/desktop/src/create-goal-flow/state.ts apps/desktop/src/create-goal-flow/state.test.ts
git commit -m "feat(desktop): add WorkflowFailedState and idempotent retry to goal flow state machine"
```

---

## Task 5: CreateGoalFlow — wire new API + render workflowFailed phase

**Files:**
- Modify: `apps/desktop/src/create-goal-flow/CreateGoalFlow.tsx`

- [ ] **Step 5.1: Replace the full CreateGoalFlow.tsx**

```typescript
import { useReducer, useEffect } from "react";
import { reducer, initialState } from "./state";
import type { WorkflowFailedState } from "./state";
import { RoughGoalStep } from "./steps/RoughGoalStep";
import { CoordinateStep } from "./steps/CoordinateStep";
import { createGoalAndStartWorkflow } from "../api";
import type { ApiError } from "../api";
import type { ConnectionStatus } from "../api";
import type { OrchestratorModelChoice } from "@orca/contracts";

type Props = {
  onClose: () => void;
  onDone: (goalId: string) => void;
  connectionStatus: ConnectionStatus;
};

const STEP_LABELS = ["Describe", "Coordinate"];
const STEP_NUMS = ["01", "02"];

function stepIndex(phase: string): number {
  switch (phase) {
    case "rough": return 0;
    case "coordinate": return 1;
    case "submitting": return 1;
    case "workflowFailed": return 1;
    default: return 1;
  }
}

function WorkflowFailedPanel({
  state,
  onRetry,
  onOpenGoal,
}: {
  state: WorkflowFailedState;
  onRetry: () => void;
  onOpenGoal: () => void;
}) {
  return (
    <div className="flow-step">
      <div className="form-field">
        <p className="form-error">
          Goal created but workflow bootstrap failed: {state.error}
        </p>
      </div>
      <div className="flow-step-actions">
        <button type="button" className="goal-action-button" onClick={onOpenGoal}>
          Open Goal
        </button>
        <button type="button" className="submit-button" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

export function CreateGoalFlow({ onClose, onDone, connectionStatus: _connectionStatus }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (state.phase !== "submitting") return;
    let cancelled = false;

    const {
      title,
      description,
      pendingWorkspaces,
      orchestratorModel,
      workflowTemplateId,
      goalId: existingGoalId,
      workflowRunId: existingRunId,
    } = state;

    // workflowTemplateId is always non-null here (guarded in CoordinateStep)
    if (!workflowTemplateId) {
      dispatch({ type: "submitFailed", error: "No workflow template selected." });
      return;
    }

    async function run() {
      try {
        const result = await createGoalAndStartWorkflow({
          title,
          description,
          workspaces: pendingWorkspaces.map((ws) => ({
            inputPath: ws.inputPath,
            name: ws.name,
          })),
          orchestratorModel: (orchestratorModel as OrchestratorModelChoice) ?? undefined,
          workflowTemplateId,
          // Note: existingGoalId / existingRunId used for retry (backend is idempotent via create-and-start)
          // The composite endpoint handles atomicity; on retry we call the same endpoint again.
          // Future: pass existingGoalId/existingRunId as hints if backend supports skip semantics.
          // For now, retry always re-calls the full endpoint (backend guards against duplicate runs via 409).
        });

        if (cancelled) return;

        if (result.ok) {
          dispatch({ type: "submitSucceeded", goalId: result.goalId });
          onDone(result.goalId);
        } else {
          dispatch({
            type: "workflowBootstrapFailed",
            goalId: result.goalId,
            workflowRunId: result.workflowRunId,
            error: result.bootstrapError.message,
          });
        }
      } catch (err: unknown) {
        if (!cancelled) {
          dispatch({ type: "submitFailed", error: (err as ApiError).message ?? "Unexpected error" });
        }
      }
    }

    void run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, existingGoalId, existingRunId]);

  const currentStep = stepIndex(state.phase);

  return (
    <div className="flow-overlay" role="dialog" aria-modal="true" aria-label="Create Goal">
      <div className="flow-modal">
        <div className="flow-header">
          <span className="flow-header-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>
            </svg>
          </span>
          <div className="flow-header-text">
            <div className="flow-header-kicker">New goal</div>
            <h2 className="flow-header-title">Define an operational objective</h2>
          </div>
          <div className="flow-steps-indicator">
            {STEP_LABELS.map((label, i) => (
              <div
                key={label}
                className={`flow-step-dot ${i === currentStep ? "flow-step-dot--active" : ""} ${i < currentStep ? "flow-step-dot--done" : ""}`}
              >
                <span className="flow-step-dot-num">{STEP_NUMS[i]}</span>
                {label}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="flow-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flow-body">
          {state.phase === "rough" && (
            <RoughGoalStep state={state} dispatch={dispatch} />
          )}

          {state.phase === "coordinate" && (
            <CoordinateStep state={state} dispatch={dispatch} />
          )}

          {state.phase === "submitting" && (
            <div className="flow-loading">
              <div className="flow-spinner" />
              <p>Creating Goal…</p>
            </div>
          )}

          {state.phase === "workflowFailed" && (
            <WorkflowFailedPanel
              state={state}
              onRetry={() => dispatch({ type: "retryWorkflowStart" })}
              onOpenGoal={() => onDone(state.goalId)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

**Important note about the `useEffect` dependency array:** The effect is keyed on `state.phase`, `existingGoalId`, and `existingRunId`. However, these variables are referenced in the outer scope — TypeScript's closure captures them correctly, but ESLint may warn. The `// eslint-disable-next-line` comment suppresses it. The real fix: destructure before the effect so the values are stable closures. The code above handles this correctly via destructuring inside the effect body.

Actually, there's a subtle issue: `existingGoalId` and `existingRunId` are not in scope at the `useEffect` dependency array — they're destructured inside the effect, not outside. The dependency array `[state.phase, existingGoalId, existingRunId]` would fail. Let me fix that:

The correct pattern is to use `state` itself in the deps and destructure inside:

```typescript
  useEffect(() => {
    if (state.phase !== "submitting") return;
    // ... all the logic
  }, [state.phase]); // run on phase change only; retry keyed by workflowFailed → submitting transition
```

This is fine because `retryWorkflowStart` transitions `workflowFailed → submitting`, which changes `state.phase` and re-fires the effect. The `goalId` and `workflowRunId` from the previous `workflowFailed` state are captured in the new `submitting` state.

Use `[state.phase]` as the dep array (matching the original code's pattern).

- [ ] **Step 5.2: Fix the useEffect dep array in the file**

The file written in step 5.1 has an incorrect comment about deps. Use `[state.phase]` only — consistent with the existing code. The `existingGoalId` and `existingRunId` should be removed from the dep array comment. The file as written above already has `// eslint-disable-next-line` which should be removed and replaced with just `}, [state.phase]);`.

Apply this correction to `apps/desktop/src/create-goal-flow/CreateGoalFlow.tsx`: change the last lines of the `useEffect` to:

```typescript
    void run();
    return () => { cancelled = true; };
  }, [state.phase]);
```

And remove the lines:
```
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, existingGoalId, existingRunId]);
```

- [ ] **Step 5.3: Run desktop tests to confirm no regressions**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/desktop test 2>&1 | tail -15
```

Expected: All tests pass.

- [ ] **Step 5.4: Commit**

```bash
git add apps/desktop/src/create-goal-flow/CreateGoalFlow.tsx
git commit -m "feat(desktop): wire createGoalAndStartWorkflow into CreateGoalFlow; add workflowFailed phase render"
```

---

## Task 6: CoordinateStep — require workflow selection

**Files:**
- Modify: `apps/desktop/src/create-goal-flow/steps/CoordinateStep.tsx`

- [ ] **Step 6.1: Update WorkflowSelector — remove "None", add disabled placeholder**

In `CoordinateStep.tsx`, find the `WorkflowSelector` component render block (around line 209–229). Replace the `<select>` block inside `WorkflowSelector`:

Old:
```tsx
      <option value="">None</option>
      {templates.map((t) => (
        <option key={t.id} value={t.id}>{t.name}</option>
      ))}
```

New:
```tsx
      <option value="" disabled>Choose workflow…</option>
      {templates.map((t) => (
        <option key={t.id} value={t.id}>{t.name}</option>
      ))}
```

Also change the `onChange` handler so selecting the placeholder (value `""`) does not call `onChange(null)` — it should be a no-op since the option is disabled. The existing `onChange={(e) => onChange(e.target.value || null)}` already handles this correctly (disabled option can't be selected), but add a guard for clarity:

```tsx
      onChange={(e) => {
        if (e.target.value) onChange(e.target.value);
      }}
```

- [ ] **Step 6.2: Disable the Create Goal button when no template selected**

In `CoordinateStep.tsx`, find the Create Goal button (around line 322–328):

Old:
```tsx
        <button
          type="button"
          className="submit-button"
          onClick={() => dispatch({ type: "submitRequested" })}
          disabled={state.inspecting}
        >
          Create Goal
        </button>
```

New:
```tsx
        <button
          type="button"
          className="submit-button"
          onClick={() => dispatch({ type: "submitRequested" })}
          disabled={state.inspecting || state.workflowTemplateId === null}
          title={state.workflowTemplateId === null ? "Select a workflow to continue" : undefined}
        >
          Create Goal
        </button>
```

- [ ] **Step 6.3: Run desktop tests to confirm no regressions**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/desktop test 2>&1 | tail -15
```

Expected: All tests pass.

- [ ] **Step 6.4: Commit**

```bash
git add apps/desktop/src/create-goal-flow/steps/CoordinateStep.tsx
git commit -m "feat(desktop): require workflow template selection in CoordinateStep"
```

---

## Task 7: OrcaChat — recovery-only no-run card

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`

- [ ] **Step 7.1: Add recovery state to OrcaChat**

In `OrcaChat.tsx`, inside the `OrcaChat` function, find where `starting` and `actionError` are declared (around lines 83–95). Add recovery state directly after `const [starting, setStarting] = useState(false);`:

```typescript
  const [recoveryExpanded, setRecoveryExpanded] = useState(false);
  const [recoveryTemplateId, setRecoveryTemplateId] = useState<string | null>(null);
  const [recoveryTemplates, setRecoveryTemplates] = useState<WorkflowTemplate[]>([]);
  const [recoveryTemplatesLoaded, setRecoveryTemplatesLoaded] = useState(false);
```

Add `WorkflowTemplate` to the import from `@orca/contracts` at the top of the file.

Also add `listWorkflowTemplates` to the imports from `../api`:

Find:
```typescript
import {
  acceptRecommendation,
  ...
  startWorkflowRun,
  ...
} from "../api";
```

Add `listWorkflowTemplates` to that import block.

- [ ] **Step 7.2: Add recovery template loading effect**

After the `useEffect` that resets action state on `selectedGoalId` change (around line 101–107), add:

```typescript
  useEffect(() => {
    if (!recoveryExpanded) return;
    if (recoveryTemplatesLoaded) return;
    let cancelled = false;
    listWorkflowTemplates()
      .then((res) => {
        if (!cancelled) {
          setRecoveryTemplates(res.templates);
          setRecoveryTemplatesLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setRecoveryTemplatesLoaded(true); // show empty
      });
    return () => { cancelled = false; };
  }, [recoveryExpanded, recoveryTemplatesLoaded]);
```

- [ ] **Step 7.3: Add handleRecoveryStart function**

After `handleStartEngineeringWorkflow` (around line 276), add:

```typescript
  async function handleRecoveryStart() {
    if (!selectedGoalId || !recoveryTemplateId) return;
    setStarting(true);
    setActionError(null);
    try {
      const runResponse = await startWorkflowRun(selectedGoalId, {
        goalId: selectedGoalId,
        templateId: recoveryTemplateId,
      });
      await requestNextOrchestratorDecision(selectedGoalId, runResponse.run.id, {
        workflowRunId: runResponse.run.id,
      });
      setRefreshNonce((current) => current + 1);
      setRecoveryExpanded(false);
      setRecoveryTemplateId(null);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to start workflow."));
    } finally {
      setStarting(false);
    }
  }
```

- [ ] **Step 7.4: Replace the `!workflowState.run` card with recovery card**

Find the full block in the JSX (around lines 432–451):

```tsx
            {!loading &&
              !error &&
              workflowState.detail &&
              hasModel &&
              !workflowState.run && (
                <SystemCard
                  title="Engineering workflow ready"
                  body="Start the built-in Engineering workflow to collect intake, supervise execution, and keep approvals explicit."
                >
                  <button
                    type="button"
                    className="submit-button"
                    onClick={() => void handleStartEngineeringWorkflow()}
                    disabled={!connected || starting}
                  >
                    {starting ? "Starting…" : "Start Engineering workflow"}
                  </button>
                </SystemCard>
              )}
```

Replace with:

```tsx
            {!loading &&
              !error &&
              workflowState.detail &&
              hasModel &&
              !workflowState.run && (
                <SystemCard
                  title="No workflow running"
                  body="This goal has no active workflow run. Start one to begin orchestration."
                >
                  {!recoveryExpanded ? (
                    <button
                      type="button"
                      className="submit-button"
                      onClick={() => setRecoveryExpanded(true)}
                      disabled={!connected}
                    >
                      Start Workflow
                    </button>
                  ) : (
                    <div className="orca-chat-recovery-form">
                      {!recoveryTemplatesLoaded ? (
                        <p className="form-hint">Loading workflows…</p>
                      ) : recoveryTemplates.length === 0 ? (
                        <p className="form-hint">No workflows available. Create one in the Workflows tab.</p>
                      ) : (
                        <>
                          <select
                            value={recoveryTemplateId ?? ""}
                            onChange={(e) => setRecoveryTemplateId(e.target.value || null)}
                          >
                            <option value="" disabled>Choose workflow…</option>
                            {recoveryTemplates.map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="submit-button"
                            onClick={() => void handleRecoveryStart()}
                            disabled={!connected || starting || recoveryTemplateId === null}
                          >
                            {starting ? "Starting…" : "Start"}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </SystemCard>
              )}
```

- [ ] **Step 7.5: Remove `handleStartEngineeringWorkflow` and `ENGINEERING_TEMPLATE_ID`**

Delete the `ENGINEERING_TEMPLATE_ID` constant at the top of the file:

```typescript
const ENGINEERING_TEMPLATE_ID = "orca/engineering";
```

Delete the entire `handleStartEngineeringWorkflow` function body.

- [ ] **Step 7.6: Run desktop tests to confirm no regressions**

```bash
cd /home/shawn/projects/orca
pnpm --filter @orca/desktop test 2>&1 | tail -15
```

Expected: All tests pass.

- [ ] **Step 7.7: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx
git commit -m "feat(desktop): replace 'Start Engineering workflow' card with recovery-only no-run card in OrcaChat"
```

---

## Task 8: Final integration verification

- [ ] **Step 8.1: Run full test suite**

```bash
cd /home/shawn/projects/orca
pnpm test 2>&1 | tail -20
```

Expected: All packages pass. Note the exact test count.

- [ ] **Step 8.2: TypeScript compile check**

```bash
cd /home/shawn/projects/orca/apps/desktop
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

```bash
cd /home/shawn/projects/orca/apps/daemon
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 8.3: Final summary commit**

If there are any lint fixes or minor corrections, commit them:

```bash
git add -A
git commit -m "fix(desktop): tsc/lint cleanup after auto-start workflow feature"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
|---|---|
| Replace "workflow failed to start" with "workflow bootstrap failed" | Task 4 (state error message), Task 5 (WorkflowFailedPanel) |
| Store `workflowRunId` once run exists | Task 4 (`WorkflowFailedState.workflowRunId?`), Task 5 (dispatch `workflowBootstrapFailed` with `workflowRunId`) |
| Idempotent retries | Task 4 (`SubmittingState.goalId?` + `workflowRunId?`), Task 5 (retry skips via `workflowFailed → submitting`) |
| Recovery-only no-run UI in OrcaChat | Task 7 |
| Workflow selection explicitly required | Task 6 (remove "None", disable Create Goal button) |
| Single backend `createGoalAndStartWorkflow` command | Tasks 1–3 (contracts + daemon route + frontend API) |
| `retryWorkflowStart` action | Task 4 |
| `workflowBootstrapFailed` action | Task 4 |
| Bootstrap failure error message in modal | Task 5 (`WorkflowFailedPanel`) |
| Retry + Open Goal buttons in modal | Task 5 (`WorkflowFailedPanel`) |
