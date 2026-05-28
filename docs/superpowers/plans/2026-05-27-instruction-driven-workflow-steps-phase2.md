# Instruction-Driven Workflow Steps (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Phase 1 instruction-driven engine so the orchestrator can route a step to **agent operators** (Codex / Claude Code / opencode / shell-manual) as well as model operators, gate code-editing launches behind the `approval_launch_agent` guardrail, synthesise the step's structured output from the resulting session (parse-then-synthesize), pause an agent mid-run to ask the user a structured question, give model operators codebase retrieval context, and replace the Engineering template's placeholder step instructions with production content.

**Architecture:** Selection branches on `OperatorDescriptor.kind`. Model-kind → unchanged Phase 1 model loop. Agent-kind → (a) evaluate `launch_workflow_session` guardrails; (b) emit a `launch_workflow_session` recommendation (gated path) or call a `WorkflowSessionLauncher` (direct path); (c) the session runs with an augmented objective that asks the agent to emit a fenced `orca-output` JSON block; (d) on session terminal event a new `onWorkflowSessionCompleted` handler parses-then-synthesises the schema-valid `step_output` (synthesis = a model `propose` of kind `synthesize_step_output`), then resumes the Phase 1 advance/complete path. Mid-run interview uses worker-hook awaiting-input signals plus `PtyHandle.write` to inject the answer back into the running PTY. Workspace context is added as an optional field on `StepExecutionInput`. Engineering template steps gain real instructions + schemas.

**Tech Stack:** TypeScript monorepo (pnpm workspaces), `zod` contracts in `packages/contracts`, Node daemon in `apps/daemon` (better-sqlite3, event store + projections, node-pty), React/Vite desktop in `apps/desktop`, `vitest` for tests.

**Spec:** `docs/superpowers/specs/2026-05-27-instruction-driven-workflow-steps-phase2-design.md`
**Phase 1 plan:** `docs/superpowers/plans/2026-05-27-instruction-driven-workflow-steps-phase1.md` (read "Notable changes" section — Phase 2 builds on the as-shipped Phase 1, not the original plan text).

---

## Before you start (read these to match existing patterns)

- `packages/contracts/src/workflows/index.ts` — `OrchestrationDecisionKind`, `OperatorDescriptor`, `StepSkillProposal`, `WorkflowArtifact` (with `source: "agent"` already), Phase 1 selection fields on `WorkflowStepRun`, `ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES`.
- `packages/contracts/src/index.ts` — `SessionStatus`, `SessionSummary` (already has `workflowStepRunId`), `ProposedAction.launch_workflow_session` (already shaped with operatorId/operatorKind/objective/workflowStepRunId).
- `apps/daemon/src/workflows/orchestrator/service.ts` — Phase 1 service: `requestNextDecision`, `commitSkillStepDecision`, `commitOperatorSelectionForSkill` (currently forces `allowedKinds: ["model"]`), `commitAdvanceOrComplete`, `blockRun`, `commitUserInputDecision`, `hasActiveUnansweredQuestion`, `createStepOutputArtifact`.
- `apps/daemon/src/workflows/operators/selector.ts` — `SelectorInput.allowedKinds`, guardrail check (`select_operator` candidateAction).
- `apps/daemon/src/workflows/operators/registry.ts` — agents listed as `id: agent:<adapterId>`, `kind: "agent"`, `supportsRepoEditing/supportsTerminal` set from the adapter.
- `apps/daemon/src/workflows/orchestration-transport/broker.ts` — `propose(request, { validateProposal })` returns `BrokerResult`; `OrchestrationRequest.kind` whitelist; transport plan resolved by provider.
- `apps/daemon/src/workflows/guardrails/evaluator.ts` — `evaluateGuardrail` candidateAction kinds; `approval_required` returns `require_approval` when `configJson.actions` includes the candidate kind; `concurrency_rule` uses `activeExecutionCount`; `allowed_operators` checks the candidate operator id.
- `apps/daemon/src/recommendations/usecases.ts` — `applyWorkflowAcceptSideEffectsInTx` (the daemon-side no-op for `launch_workflow_session` — the desktop is the launch surface).
- `apps/daemon/src/sessions/runtime.ts` — `session.exited`/`session.stopped`/`session.failed` payloads (`sessionId`, `goalId`, …); `SessionRuntime.getHandle(sessionId): PtyHandle | undefined`; `PtyHandle.write(data: Buffer)`.
- `apps/daemon/src/sessions/output-store.ts` — `createSessionOutputStore(db).readTail(sessionId)` returns a `SessionOutputSnapshot` with base64 chunks (the tail bound is `DEFAULT_TAIL_BYTES` — keep ≤ `ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES`).
- `apps/daemon/src/sessions/projection.ts` — session row lookups including `workflow_step_run_id`.
- `apps/daemon/src/orchestrator/triggers.ts` — the M5/M8 trigger subscriber pattern; Phase 2 adds a separate small workflow subscriber to avoid coupling.
- `apps/daemon/src/daemon-context.ts` — wiring of `operatorRegistry`, `orchestrationTransportBroker`, `operatorSelector` (Phase 2 adds `workflowSessionLauncher` + `sessionOutputStore` + `sessionRuntime` so the service can read tails and direct-launch).
- `apps/daemon/src/server.ts` — `OrchestratorService` construction and trigger subscription; bus subscription wired here.
- `apps/desktop/src/orchestrator/OrcaChat.tsx` — `launch_workflow_session` accept handler → `CreateSessionPrefill` (already wired with `workflowStepRunId`); `adapterIdFromOperator(operatorId, operatorKind)` strips `agent:` prefix.
- `apps/desktop/src/goal-detail/recommendations/RecommendationsPanel.tsx` — `CreateSessionPrefill` type definition.
- `apps/daemon/src/workflows/templates/seed-engineering.ts` — `ENGINEERING_VERSION = 2`, `ENGINEERING_STEPS`, `ENGINEERING_GUARDRAILS` (includes `approval_launch_agent`).

**Baseline:** run `pnpm test` and capture green at HEAD `0e5843e`. All M1–M7 anchors + Phase 1 changes must stay green.

---

## Task 1: Contract additions (`synthesize_step_output` + `SynthesisRequest`/`SynthesisProposal`)

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts`
- Test: `packages/contracts/src/workflows/synthesis.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// synthesis.test.ts
import { describe, expect, it } from "vitest";
import {
  OrchestrationDecisionKind,
  SynthesisRequest,
  SynthesisProposal,
} from "./index.js";

describe("synthesize_step_output", () => {
  it("OrchestrationDecisionKind includes synthesize_step_output", () => {
    expect(OrchestrationDecisionKind.parse("synthesize_step_output")).toBe(
      "synthesize_step_output"
    );
  });

  it("SynthesisRequest accepts sessionResult + outputSchema + stepInput", () => {
    const parsed = SynthesisRequest.parse({
      sessionResult: "ran tests; all green",
      outputSchema: [{ key: "summary", type: "string", required: true }],
      stepInput: {
        goal: { id: "g", description: "x" },
        currentStep: {
          id: "execution",
          ordinal: 4,
          name: "Execution",
          instructions: "do stuff",
          outputSchema: [{ key: "summary", type: "string", required: true }],
        },
        previousStepOutput: null,
        priorStepOutputs: [],
        transcript: [],
      },
    });
    expect(parsed.sessionResult.length).toBeGreaterThan(0);
  });

  it("SynthesisRequest rejects oversize sessionResult (> ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES)", () => {
    const big = "x".repeat(8192);
    expect(() =>
      SynthesisRequest.parse({
        sessionResult: big,
        outputSchema: [{ key: "summary", type: "string", required: true }],
        stepInput: {
          goal: { id: "g", description: "x" },
          currentStep: {
            id: "x",
            ordinal: 0,
            name: "X",
            instructions: "i",
            outputSchema: [{ key: "summary", type: "string", required: true }],
          },
          previousStepOutput: null,
          priorStepOutputs: [],
          transcript: [],
        },
      })
    ).toThrow();
  });

  it("SynthesisProposal carries a record output", () => {
    expect(SynthesisProposal.parse({ output: { summary: "ok" } }).output.summary).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test synthesis`
Expected: FAIL — `synthesize_step_output` rejected; `SynthesisRequest` undefined.

- [ ] **Step 3: Modify the contracts**

In `packages/contracts/src/workflows/index.ts`:

1. Extend `OrchestrationDecisionKind`:
```ts
export const OrchestrationDecisionKind = z.enum([
  "select_operator",
  "score_transition",
  "repair_artifact",
  "run_audit",
  "run_step_skill",
  "synthesize_step_output",
]);
```

2. Add the synthesis schemas near `StepSkillProposal`:
```ts
export const SynthesisRequest = z
  .object({
    sessionResult: BoundedString(
      ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES,
      "sessionResult"
    ),
    outputSchema: WorkflowStepOutputSchema,
    stepInput: z.unknown(), // typed as StepExecutionInput in the daemon; opaque here so contracts stay framework-free
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasMaxSerializedBytes(value, ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `SynthesisRequest must be at most ${ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES} bytes when serialized`,
      });
    }
  });
export type SynthesisRequest = z.infer<typeof SynthesisRequest>;

export const SynthesisProposal = z
  .object({ output: z.record(z.unknown()) })
  .strict();
export type SynthesisProposal = z.infer<typeof SynthesisProposal>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test synthesis`
Expected: PASS (4 tests).

- [ ] **Step 5: Build + commit**

```bash
pnpm --filter @orca/contracts build
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/synthesis.test.ts
git commit -m "feat(contracts): add synthesize_step_output decision kind + SynthesisRequest/SynthesisProposal"
```

---

## Task 2: Widen `recordOperatorSelection` to accept null provider/model

**Files:**
- Modify: `apps/daemon/src/workflows/steps/projection.ts`
- Test: `apps/daemon/src/workflows/steps/projection.test.ts` (extend existing or create)

- [ ] **Step 1: Write the failing test**

Add to the projection test file:
```ts
import Database from "better-sqlite3";
import { runMigrations, defaultMigrationsDir } from "../../migrations.js";
import { freshDb } from "../../test-helpers/db.js"; // existing helper used in projection.test
import { recordOperatorSelection, getWorkflowStepRunById } from "./projection.js";

it("recordOperatorSelection allows null provider/model for agent selections", () => {
  const db = freshDb();
  runMigrations(db, defaultMigrationsDir());
  // Insert a minimal workflow_step_runs row using the project's existing test helper
  // (mirror how other projection tests seed a step run).
  seedStepRunRow(db, { id: "sr1", goalId: "g", workflowRunId: "r", stepTemplateId: "execution", ordinal: 4 });
  recordOperatorSelection(db, "sr1", {
    operatorId: "agent:codex",
    providerId: null,
    modelId: null,
    at: "2026-05-27T00:00:00.000Z",
  });
  const sr = getWorkflowStepRunById(db, "sr1");
  expect(sr?.selectedOperatorId).toBe("agent:codex");
  expect(sr?.selectedProviderId).toBeNull();
  expect(sr?.selectedModelId).toBeNull();
});
```
(If a `seedStepRunRow` helper does not already exist in the projection test, add it locally using the same INSERT shape used by the existing tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test workflows/steps/projection`
Expected: FAIL — current type signature is `providerId: string; modelId: string`, TypeScript build fails on `null`.

- [ ] **Step 3: Widen the writer**

In `apps/daemon/src/workflows/steps/projection.ts` change `recordOperatorSelection` signature:
```ts
export function recordOperatorSelection(
  db: Database.Database,
  id: string,
  sel: { operatorId: string; providerId: string | null; modelId: string | null; at: string }
): void {
  db.prepare(
    "UPDATE workflow_step_runs SET selected_operator_id=?, selected_provider_id=?, selected_model_id=?, operator_selected_at=? WHERE id=?"
  ).run(sel.operatorId, sel.providerId, sel.modelId, sel.at, id);
  resetWorkflowStepProjectionPreparedStatements();
}
```
No migration is needed (the columns are already nullable per the Phase 1 migration `0014_workflow_step_runs_operator_selection.sql`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test workflows/steps/projection`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/steps/projection.ts apps/daemon/src/workflows/steps/projection.test.ts
git commit -m "feat(daemon): allow null provider/model in recordOperatorSelection (agent ops)"
```

---

## Task 3: `orca-output` block helpers (pure)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/orca-output.ts`
- Test: `apps/daemon/src/workflows/orchestrator/orca-output.test.ts`

These are the parse-side and the instruction-augmentation pieces of A3.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  augmentInstructionsWithOutputConvention,
  parseOrcaOutputBlock,
} from "./orca-output.js";

describe("augmentInstructionsWithOutputConvention", () => {
  it("appends the orca-output convention exactly once", () => {
    const out = augmentInstructionsWithOutputConvention("Do the thing.");
    expect(out).toMatch(/```orca-output/);
    expect(out.indexOf("```orca-output")).toBe(out.lastIndexOf("```orca-output"));
  });
  it("is idempotent if convention is already present", () => {
    const first = augmentInstructionsWithOutputConvention("x");
    const second = augmentInstructionsWithOutputConvention(first);
    expect(second).toBe(first);
  });
});

describe("parseOrcaOutputBlock", () => {
  it("extracts the LAST orca-output block as JSON", () => {
    const text = [
      "noise",
      "```orca-output",
      '{"a":1}',
      "```",
      "more noise",
      "```orca-output",
      '{"a":2}',
      "```",
      "trailing",
    ].join("\n");
    expect(parseOrcaOutputBlock(text)).toEqual({ a: 2 });
  });
  it("returns null when no block is present", () => {
    expect(parseOrcaOutputBlock("nothing here")).toBeNull();
  });
  it("returns null when the block is not valid JSON", () => {
    expect(parseOrcaOutputBlock("```orca-output\nnot json\n```")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test orca-output`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// orca-output.ts
const CONVENTION = [
  "",
  "When finished, emit your structured result as a single fenced block:",
  "```orca-output",
  "{ ...JSON matching the requested outputSchema... }",
  "```",
].join("\n");

export function augmentInstructionsWithOutputConvention(instructions: string): string {
  if (instructions.includes("```orca-output")) return instructions;
  return `${instructions}\n${CONVENTION}`;
}

const BLOCK_RE = /```orca-output\s*\n([\s\S]*?)```/g;

export function parseOrcaOutputBlock(text: string): unknown | null {
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = BLOCK_RE.exec(text)) !== null) last = match[1] ?? null;
  if (last === null) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test orca-output`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/orca-output.ts apps/daemon/src/workflows/orchestrator/orca-output.test.ts
git commit -m "feat(daemon): orca-output block convention + parser"
```

---

## Task 4: Session-tail reader helper (pure-ish)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/session-tail.ts`
- Test: `apps/daemon/src/workflows/orchestrator/session-tail.test.ts`

Decodes `SessionOutputSnapshot` chunks back into a single UTF-8 string capped to `ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { decodeSessionTail } from "./session-tail.js";
import type { SessionOutputSnapshot } from "@orca/contracts";

function chunk(data: string, seq: number, byteOffset: number): SessionOutputSnapshot["chunks"][number] {
  return { seq, byteOffset, dataBase64: Buffer.from(data, "utf8").toString("base64") };
}

describe("decodeSessionTail", () => {
  it("concatenates chunks in seq order and truncates from the head", () => {
    const snap: SessionOutputSnapshot = {
      sessionId: "s", firstByteOffset: 0, nextSeq: 2, totalBytesKept: 6,
      chunks: [chunk("abc", 0, 0), chunk("def", 1, 3)],
    };
    expect(decodeSessionTail(snap, 1024)).toBe("abcdef");
    expect(decodeSessionTail(snap, 4)).toBe("cdef");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test session-tail`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// session-tail.ts
import { ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES, type SessionOutputSnapshot } from "@orca/contracts";

export function decodeSessionTail(
  snapshot: SessionOutputSnapshot,
  maxBytes: number = ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES
): string {
  const ordered = [...snapshot.chunks].sort((a, b) => a.seq - b.seq);
  const buf = Buffer.concat(ordered.map((c) => Buffer.from(c.dataBase64, "base64")));
  const sliced = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
  return sliced.toString("utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test session-tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/session-tail.ts apps/daemon/src/workflows/orchestrator/session-tail.test.ts
git commit -m "feat(daemon): session output-tail decoder for synthesis"
```

---

## Task 5: Step-output synthesis (parse-then-synthesize)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/synthesize.ts`
- Test: `apps/daemon/src/workflows/orchestrator/synthesize.test.ts`

Resolves the agent session result into a schema-valid `step_output`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  synthesizeStepOutput,
  type SynthesisDeps,
  type SynthesisInput,
} from "./synthesize.js";

const schema = [
  { key: "summary", type: "string", required: true },
] as const;

function deps(overrides: Partial<SynthesisDeps> = {}): SynthesisDeps {
  return {
    broker: {
      propose: vi.fn(async () => ({
        status: "proposed",
        attemptId: "att",
        transport: "one_shot",
        parsed: { output: { summary: "from model" } },
        rawTextLength: 0,
        latencyMs: 0,
      })),
    },
    ...overrides,
  };
}

const input: SynthesisInput = {
  goalId: "g",
  workflowRunId: "r",
  stepRunId: "sr",
  providerId: "orca/anthropic",
  modelId: "claude-sonnet-4-6",
  outputSchema: schema as unknown as SynthesisInput["outputSchema"],
  stepInput: { goal: { id: "g", description: "" }, currentStep: { id: "execution", ordinal: 4, name: "Execution", instructions: "i", outputSchema: schema as unknown as SynthesisInput["outputSchema"] }, previousStepOutput: null, priorStepOutputs: [], transcript: [] },
};

describe("synthesizeStepOutput", () => {
  it("parse path: valid orca-output block bypasses the model", async () => {
    const d = deps();
    const text = "noise\n```orca-output\n{\"summary\":\"from agent\"}\n```\n";
    const r = await synthesizeStepOutput(d, { ...input, sessionResult: text });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.source).toBe("agent");
    expect(r.ok === true && r.output).toEqual({ summary: "from agent" });
    expect(d.broker.propose).not.toHaveBeenCalled();
  });

  it("synthesize path: missing block falls back to model", async () => {
    const d = deps();
    const r = await synthesizeStepOutput(d, { ...input, sessionResult: "no block" });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.source).toBe("orchestrator");
    expect(r.ok === true && r.output).toEqual({ summary: "from model" });
    expect(d.broker.propose).toHaveBeenCalledTimes(1);
  });

  it("synthesize path: invalid block falls back to model", async () => {
    const d = deps();
    const r = await synthesizeStepOutput(d, {
      ...input,
      sessionResult: "```orca-output\n{\"wrong\":1}\n```",
    });
    expect(r.ok === true && r.source).toBe("orchestrator");
  });

  it("synthesise retries once on schema-invalid model output, then errors", async () => {
    const propose = vi
      .fn()
      .mockResolvedValueOnce({ status: "proposed", attemptId: "a", transport: "one_shot", parsed: { output: { wrong: 1 } }, rawTextLength: 0, latencyMs: 0 })
      .mockResolvedValueOnce({ status: "proposed", attemptId: "a", transport: "one_shot", parsed: { output: { wrong: 2 } }, rawTextLength: 0, latencyMs: 0 });
    const r = await synthesizeStepOutput({ broker: { propose } }, { ...input, sessionResult: "" });
    expect(r.ok).toBe(false);
    expect(propose).toHaveBeenCalledTimes(2);
    expect(r.ok === false && r.reason).toMatch(/schema/i);
  });

  it("transport failure surfaces as error", async () => {
    const propose = vi.fn().mockResolvedValue({ status: "needs_human_review", attemptId: "a", reviewPayloadId: "h" });
    const r = await synthesizeStepOutput({ broker: { propose } }, { ...input, sessionResult: "" });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test synthesize`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// synthesize.ts
import {
  OrchestrationRequest,
  SynthesisProposal,
  SynthesisRequest,
  validateStepOutput,
  type ModelProviderId,
  type WorkflowStepOutputSchema,
} from "@orca/contracts";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { parseOrcaOutputBlock } from "./orca-output.js";
import type { StepExecutionInput } from "./step-input.js";

export interface SynthesisDeps {
  broker: Pick<OrchestrationTransportBroker, "propose">;
}

export interface SynthesisInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  providerId: ModelProviderId;
  modelId: string;
  outputSchema: WorkflowStepOutputSchema;
  stepInput: StepExecutionInput;
  sessionResult: string; // session summary + bounded output tail, already truncated
}

export type SynthesisResult =
  | { ok: true; output: Record<string, unknown>; source: "agent" | "orchestrator" }
  | { ok: false; reason: string };

export async function synthesizeStepOutput(
  deps: SynthesisDeps,
  input: SynthesisInput
): Promise<SynthesisResult> {
  // (1) Parse path
  const parsed = parseOrcaOutputBlock(input.sessionResult);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const v = validateStepOutput(input.outputSchema, parsed);
    if (v.ok) {
      return { ok: true, output: parsed as Record<string, unknown>, source: "agent" };
    }
  }

  // (2) Synthesize path, with one retry
  for (let attempt = 0; attempt < 2; attempt++) {
    const requestPayload = SynthesisRequest.parse({
      sessionResult: input.sessionResult,
      outputSchema: input.outputSchema,
      stepInput: input.stepInput,
    });
    const request = OrchestrationRequest.parse({
      kind: "synthesize_step_output",
      goalId: input.goalId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      providerId: input.providerId,
      modelId: input.modelId,
      payload: requestPayload,
    });

    const result = await deps.broker.propose(request, {
      validateProposal: (raw) => {
        const proposal = SynthesisProposal.safeParse(raw);
        if (!proposal.success) {
          return { accepted: false, failureMessage: "invalid synthesis proposal" };
        }
        const validated = validateStepOutput(input.outputSchema, proposal.data.output);
        if (!validated.ok) {
          return { accepted: false, failureMessage: `schema: ${validated.errors.join("; ")}` };
        }
        return { accepted: true, parsed: proposal.data };
      },
    });

    if (result.status === "proposed") {
      const proposal = result.parsed as SynthesisProposal;
      return { ok: true, output: proposal.output, source: "orchestrator" };
    }
  }

  return { ok: false, reason: "synthesis schema invalid after retry" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test synthesize`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/synthesize.ts apps/daemon/src/workflows/orchestrator/synthesize.test.ts
git commit -m "feat(daemon): hybrid parse-then-synthesize step output"
```

---

## Task 6: WorkflowSessionLauncher abstraction (direct-launch path)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/session-launcher.ts`
- Test: `apps/daemon/src/workflows/orchestrator/session-launcher.test.ts`

A thin interface the service calls when the `approval_launch_agent` guardrail is absent. Production impl picks the goal's first attached workspace + the adapter from `agent:<adapterId>` and calls `createSessionUseCase` (the existing in-daemon session create). Test impl is a spy. The recommendation-based path does not use this.

> If a production wiring blocker emerges (e.g. workspace selection ambiguity), the implementer should still ship the interface + a stub impl that throws `"direct_launch_unsupported"`; the Engineering template keeps `approval_launch_agent` active so the recommendation path remains the live one and tests still cover the abstraction.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { recommendationOrDirectLaunch } from "./session-launcher.js";

describe("recommendationOrDirectLaunch", () => {
  it("requiresApproval=true → returns 'recommendation' decision", () => {
    const launcher = { launch: vi.fn() };
    const r = recommendationOrDirectLaunch({
      requiresApproval: true,
      launcher,
      ctx: { goalId: "g", workflowRunId: "r", workflowStepRunId: "sr", operatorId: "agent:codex", operatorKind: "agent", objective: "do it" },
    });
    expect(r).toBe("recommendation");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("requiresApproval=false → invokes the launcher", () => {
    const launcher = { launch: vi.fn() };
    const r = recommendationOrDirectLaunch({
      requiresApproval: false,
      launcher,
      ctx: { goalId: "g", workflowRunId: "r", workflowStepRunId: "sr", operatorId: "agent:codex", operatorKind: "agent", objective: "do it" },
    });
    expect(r).toBe("direct");
    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test session-launcher`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// session-launcher.ts
export interface WorkflowLaunchContext {
  goalId: string;
  workflowRunId: string;
  workflowStepRunId: string;
  operatorId: string;     // "agent:<adapterId>"
  operatorKind: "agent";
  objective: string;      // augmented step instructions
}

export interface WorkflowSessionLauncher {
  launch(ctx: WorkflowLaunchContext): Promise<{ sessionId: string }>;
}

export type LaunchOutcome = "recommendation" | "direct";

export function recommendationOrDirectLaunch(args: {
  requiresApproval: boolean;
  launcher: WorkflowSessionLauncher;
  ctx: WorkflowLaunchContext;
}): LaunchOutcome {
  if (args.requiresApproval) return "recommendation";
  void args.launcher.launch(args.ctx);
  return "direct";
}
```

(The production `WorkflowSessionLauncher` implementation lives in `apps/daemon/src/workflows/orchestrator/session-launcher-impl.ts` — see Task 11 wiring. For Task 6 only the interface + the routing helper exist.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test session-launcher`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/session-launcher.ts apps/daemon/src/workflows/orchestrator/session-launcher.test.ts
git commit -m "feat(daemon): WorkflowSessionLauncher abstraction + gate routing helper"
```

---

## Task 7: Agent-step branch in `commitSkillStepDecision`

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` (create)

> The Phase 1 test harness in this directory (see existing `service.*.test.ts` files) seeds a run/step in an in-memory DB and stubs broker/selector/registry. Reuse it; add a stub `WorkflowSessionLauncher` injected via constructor.

- [ ] **Step 1: Write the failing test**

```ts
// service.agent-step.test.ts — shape; adapt setup helpers to the existing harness
import { describe, expect, it, vi } from "vitest";
import { setupAgentStepRun } from "./test-helpers.js"; // extend the Phase 1 helper

describe("requestNextDecision (agent step, gated)", () => {
  it("selects an agent operator, evaluates approval_launch_agent, emits launch recommendation, does not launch", async () => {
    const t = setupAgentStepRun({
      readyAgents: [{ id: "agent:codex", kind: "agent", capabilities: ["code_editing"] }],
      guardrails: [{ id: "approval_launch_agent", kind: "approval_required", label: "x", configJson: { actions: ["launch_workflow_session"] } }],
      proposeSelect: { operatorId: "agent:codex" },
    });
    await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts); // selects
    const r = await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts); // emits launch
    expect(r.recommendationIds.length).toBe(1);
    expect(t.recommendationType(r.recommendationIds[0])).toBe("launch_workflow_session");
    const action = t.recommendationProposedAction(r.recommendationIds[0]);
    expect(action.kind).toBe("launch_workflow_session");
    expect(action.operatorId).toBe("agent:codex");
    expect(action.operatorKind).toBe("agent");
    expect(action.objective).toMatch(/```orca-output/);
    expect(t.launcher.launch).not.toHaveBeenCalled();
  });

  it("is idempotent: second call returns the existing launch recommendation, no new ones", async () => {
    const t = setupAgentStepRun({ alreadySelectedAgent: "agent:codex", launchRecommendationEmitted: true });
    const before = t.countRecommendations("launch_workflow_session");
    await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts);
    expect(t.countRecommendations("launch_workflow_session")).toBe(before);
  });

  it("guardrail absent → direct-launch path calls launcher and does NOT emit a recommendation", async () => {
    const t = setupAgentStepRun({
      readyAgents: [{ id: "agent:codex", kind: "agent" }],
      guardrails: [],
      proposeSelect: { operatorId: "agent:codex" },
    });
    await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts); // selects
    const r = await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts); // direct
    expect(t.launcher.launch).toHaveBeenCalledTimes(1);
    expect(r.recommendationIds.length).toBe(0);
  });

  it("does not re-launch while a session linked to the step is still running", async () => {
    const t = setupAgentStepRun({ alreadySelectedAgent: "agent:codex", runningSessionLinkedToStep: "sess-1" });
    const before = t.countRecommendations("launch_workflow_session");
    await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts);
    expect(t.countRecommendations("launch_workflow_session")).toBe(before);
    expect(t.launcher.launch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: FAIL — branch not implemented.

- [ ] **Step 3: Wire `WorkflowSessionLauncher` through the service constructor**

```ts
export class OrchestratorService {
  constructor(
    private readonly operatorSelector: Pick<OperatorSelector, "select">,
    private readonly broker: Pick<OrchestrationTransportBroker, "propose">,
    private readonly operators: Pick<OperatorRegistry, "list">,
    private readonly launcher: WorkflowSessionLauncher
  ) {}
  // ...
}
```

Update every construction site to pass a launcher:
- `apps/daemon/src/server.ts:441` — pass `ctx.workflowSessionLauncher` (added in Task 11) or the no-op stub if `direct_launch_unsupported`.
- `apps/daemon/src/workflows/orchestrator/routes.ts:40`
- `apps/daemon/src/workflows/steps/routes.ts:42`

For the test, inject a `vi.fn()`-backed stub.

- [ ] **Step 4: Drop the `allowedKinds: ["model"]` filter in `commitOperatorSelectionForSkill`**

In `service.ts` `commitOperatorSelectionForSkill`, change the selector call to drop `allowedKinds`:
```ts
const result = await this.operatorSelector.select(db, now, {
  goalId: goal.id,
  workflowRunId: run.id,
  stepRunId: stepRun.id,
  stepName: stepTpl.id,
  stepPurpose: stepTpl.instructions.slice(0, 1024),
  recommendedCapabilities: [],
  recommendedOperatorIds: [],
  guardrails: template.guardrails,
  orchestratorProvider: goal.orchestrator_provider,
  orchestratorModel: goal.orchestrator_model,
  // allowedKinds omitted — both kinds participate
});
```

In the same method, when the chosen operator is `kind: "agent"`, persist with null provider/model and short-circuit (still record the `select_operator` decision + `workflow.operator.selected` event the same way; just call `recordOperatorSelection(db, stepRun.id, { operatorId: chosen.id, providerId: null, modelId: null, at: now() })`):
```ts
const providerId = chosen.kind === "model" ? chosen.providerId ?? null : null;
const modelId    = chosen.kind === "model" ? chosen.modelId    ?? null : null;
if (chosen.kind === "model" && (!providerId || !modelId)) {
  return this.blockRun(db, now, ctx, "no ready model operator", options);
}
// (existing decision recording stays; pass providerId/modelId — both nullable now)
recordOperatorSelection(db, stepRun.id, { operatorId: chosen.id, providerId, modelId, at: now() });
```
The `requiresApproval` flag set on the decision now reflects the agent guardrail too.

- [ ] **Step 5: Branch the post-selection flow on `kind`**

In `commitSkillStepDecision`, after the `if (!sel.selectedOperatorId)` selection branch, look up the descriptor via `this.operators.list(goal.id)` (or read kind from the registry by id) and branch:
```ts
const descriptors = await this.operators.list(goal.id);
const chosen = descriptors.find((d) => d.id === sel.selectedOperatorId);
if (!chosen) return this.blockRun(db, now, ctx, "selected operator missing", options);

if (chosen.kind === "agent") {
  return this.commitAgentStepDecision(db, now, ctx, chosen, options);
}
// existing model path continues unchanged from here.
```

- [ ] **Step 6: Implement `commitAgentStepDecision`**

```ts
private async commitAgentStepDecision(
  db: Database.Database,
  now: () => string,
  ctx: {
    run: WorkflowRunT;
    stepRun: StepRunRow;
    stepTpl: WorkflowStepTemplate;
    template: WorkflowTemplateT;
    goal: GoalRow;
  },
  chosen: OperatorDescriptor,
  options: RequestNextDecisionOptions
): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
  const { run, stepRun, stepTpl, template, goal } = ctx;

  // (a) running session linked to this step run? → no-op until session ends
  const linked = db
    .prepare(
      "SELECT id, status FROM sessions WHERE workflow_step_run_id = ? AND status IN ('created','starting','running')"
    )
    .all(stepRun.id) as Array<{ id: string; status: string }>;
  if (linked.length > 0) {
    return this.commitNoopLatestDecision(db, run.id, stepRun.id);
  }

  // (b) outstanding unaccepted launch recommendation? → idempotent
  if (this.hasOpenLaunchRecommendation(db, stepRun.id)) {
    return this.commitNoopLatestDecision(db, run.id, stepRun.id);
  }

  // (c) build the launch objective (augmented instructions + brief envelope summary)
  const objective = buildAgentObjective(stepTpl, ctx);

  // (d) evaluate guardrails for launch_workflow_session
  const guardrailCheck = evaluateGuardrailRequiresApproval(template.guardrails, {
    goalId: goal.id, workflowRunId: run.id, stepRunId: stepRun.id, stepTemplateId: stepTpl.id,
    candidateAction: { kind: "launch_workflow_session", operatorId: chosen.id },
  });
  if (guardrailCheck === "deny") {
    return this.blockRun(db, now, ctx, "launch denied by guardrail", options);
  }
  const requiresApproval = guardrailCheck === "require_approval";

  // (e) gated path → recommendation; direct path → launcher
  const outcome = recommendationOrDirectLaunch({
    requiresApproval,
    launcher: this.launcher,
    ctx: { goalId: goal.id, workflowRunId: run.id, workflowStepRunId: stepRun.id,
           operatorId: chosen.id, operatorKind: "agent", objective },
  });

  if (outcome === "direct") {
    // Launcher is fire-and-forget; the session-completion subscriber drives the next step.
    return this.commitNoopLatestDecision(db, run.id, stepRun.id);
  }

  // Emit a `launch_workflow_session` recommendation + decision.
  return this.commitLaunchRecommendation(db, now, ctx, chosen, objective, requiresApproval, options);
}
```

Add `commitLaunchRecommendation` mirroring `commitUserInputDecision`'s structure but using `decisionType: "select_operator"` (re-record the selection with launch context — or `"evaluate_guardrail"` if you prefer; pick one and keep it consistent in tests). The recommendation's `proposedAction`:
```ts
proposedAction: {
  kind: "launch_workflow_session",
  workflowStepRunId: stepRun.id,
  operatorId: chosen.id,
  operatorKind: chosen.kind,
  objective,
},
rationale: `Launch ${chosen.displayName} to execute "${stepTpl.name}".`,
type: "launch_workflow_session",
```

Add helper `hasOpenLaunchRecommendation(db, stepRunId)`:
```ts
private hasOpenLaunchRecommendation(db: Database.Database, stepRunId: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM recommendations WHERE workflow_step_run_id = ? AND type = 'launch_workflow_session' AND status = 'proposed' LIMIT 1"
  ).get(stepRunId);
  return row !== undefined;
}
```

Add helper `commitNoopLatestDecision` (rename of Phase 1 `commitNoop` — generalize to look up the latest decision for the step run regardless of type, falling back to a `block_run` decision-trace fabrication only if none exists).

Add helper module `buildAgentObjective` in `apps/daemon/src/workflows/orchestrator/agent-objective.ts` (pure):
```ts
import type { WorkflowStepTemplate } from "@orca/contracts";
import { augmentInstructionsWithOutputConvention } from "./orca-output.js";

export function buildAgentObjective(
  step: WorkflowStepTemplate,
  ctx: { goal: { description: string }; stepRun: { id: string } }
): string {
  const header = `Workflow step: ${step.name}\nGoal: ${ctx.goal.description}\n\n`;
  return augmentInstructionsWithOutputConvention(`${header}${step.instructions}`);
}
```

Add helper module `evaluateGuardrailRequiresApproval` in `apps/daemon/src/workflows/guardrails/evaluator.ts` (or wrap the existing `evaluateAllGuardrails`):
```ts
export function evaluateGuardrailRequiresApproval(
  guardrails: WorkflowGuardrailConfig[],
  ctx: GuardrailContext
): "allow" | "require_approval" | "deny" {
  const results = guardrails.map((g) => evaluateGuardrail(g, ctx));
  if (results.some((r) => r.result === "deny")) return "deny";
  if (results.some((r) => r.result === "require_approval")) return "require_approval";
  return "allow";
}
```

- [ ] **Step 7: Run tests + commit**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: PASS (4 tests).
```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/agent-objective.ts apps/daemon/src/workflows/guardrails/evaluator.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts apps/daemon/src/workflows/orchestrator/test-helpers.ts apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/routes.ts apps/daemon/src/workflows/steps/routes.ts
git commit -m "feat(daemon): agent-operator step branch in commitSkillStepDecision (gated + direct paths)"
```

---

## Task 8: Session-completion → synthesis wiring

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/session-completion.ts`
- Create: `apps/daemon/src/workflows/orchestrator/session-completion.test.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (add `onWorkflowSessionCompleted`)
- Modify: `apps/daemon/src/server.ts` (subscribe)
- Modify: `apps/daemon/src/daemon-context.ts` (add `sessionOutputStore`)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { setupAgentCompletion } from "./test-helpers.js"; // extend Phase 1 helper

describe("onWorkflowSessionCompleted", () => {
  it("parse-path: agent emitted valid orca-output → step_output (source=agent) + auto-advance", async () => {
    const t = setupAgentCompletion({
      sessionTail: "```orca-output\n{\"summary\":\"done\"}\n```",
      twoSteps: true,
    });
    await t.service.onWorkflowSessionCompleted(t.db, t.now, { sessionId: t.sessionId, goalId: "g" }, t.opts);
    const out = t.artifacts("step_output");
    expect(out.length).toBe(1);
    expect(out[0].source).toBe("agent");
    expect(out[0].linkedSessionId).toBe(t.sessionId);
    expect(t.currentStepTemplateId()).toBe("qa");
  });

  it("synthesise-path: missing block → broker.propose synthesize_step_output → step_output (source=orchestrator)", async () => {
    const t = setupAgentCompletion({
      sessionTail: "no block here",
      brokerSynthesisOutput: { summary: "from model" },
    });
    await t.service.onWorkflowSessionCompleted(t.db, t.now, { sessionId: t.sessionId, goalId: "g" }, t.opts);
    const out = t.artifacts("step_output");
    expect(out[0].source).toBe("orchestrator");
  });

  it("synthesise twice invalid → run blocked", async () => {
    const t = setupAgentCompletion({ sessionTail: "", brokerSynthesisOutput: { wrong: 1 } });
    await t.service.onWorkflowSessionCompleted(t.db, t.now, { sessionId: t.sessionId, goalId: "g" }, t.opts);
    expect(t.run().status).toBe("blocked");
    expect(t.run().blockedReason).toMatch(/schema/i);
  });

  it("session.failed → step blocked with session failure reason; no synthesis", async () => {
    const t = setupAgentCompletion({ terminalStatus: "failed", failureReason: "spawn_failed" });
    await t.service.onWorkflowSessionCompleted(t.db, t.now, { sessionId: t.sessionId, goalId: "g" }, t.opts);
    expect(t.run().status).toBe("blocked");
    expect(t.broker.propose).not.toHaveBeenCalled();
  });

  it("non-workflow session → no-op", async () => {
    const t = setupAgentCompletion({ noWorkflowLink: true });
    await t.service.onWorkflowSessionCompleted(t.db, t.now, { sessionId: t.sessionId, goalId: "g" }, t.opts);
    expect(t.artifacts("step_output").length).toBe(0);
  });

  it("step already has step_output → no-op (idempotent)", async () => {
    const t = setupAgentCompletion({ existingStepOutput: true, sessionTail: "```orca-output\n{\"summary\":\"x\"}\n```" });
    const before = t.artifacts("step_output").length;
    await t.service.onWorkflowSessionCompleted(t.db, t.now, { sessionId: t.sessionId, goalId: "g" }, t.opts);
    expect(t.artifacts("step_output").length).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test session-completion`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement `onWorkflowSessionCompleted` on `OrchestratorService`**

Inject `sessionOutputStore: { readTail(sessionId): SessionOutputSnapshot }` into the service constructor (add to `daemon-context.ts` `DaemonContext` interface and `createDaemonContext`). Add the method:

```ts
async onWorkflowSessionCompleted(
  db: Database.Database,
  now: () => string,
  args: { sessionId: string; goalId: string },
  options: RequestNextDecisionOptions = {}
): Promise<void> {
  const sess = db.prepare(
    "SELECT id, workflow_step_run_id, status, failure_reason FROM sessions WHERE id = ?"
  ).get(args.sessionId) as { id: string; workflow_step_run_id: string | null; status: string; failure_reason: string | null } | undefined;
  if (!sess || !sess.workflow_step_run_id) return;

  const stepRun = readStepRun(db, sess.workflow_step_run_id);
  if (stepRun.status !== "active") return;

  // Idempotency: step already produced an output.
  const existing = db.prepare(
    "SELECT 1 FROM workflow_artifacts WHERE step_run_id = ? AND type = 'step_output' LIMIT 1"
  ).get(stepRun.id);
  if (existing) {
    // Make sure the engine has a chance to advance even if completion races.
    await this.requestNextDecision(db, now, stepRun.workflow_run_id, options).catch(() => {});
    return;
  }

  const run = getWorkflowRunById(db, stepRun.workflow_run_id);
  if (!run || run.status !== "active") return;
  const template = getTemplateById(db, run.templateId);
  if (!template) return;
  const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
  if (!stepTpl) return;
  const goal = readGoal(db, run.goalId);

  // Session-failure path: block, do not synthesize.
  if (sess.status === "failed" || sess.status === "stopped") {
    const reason = `session ${sess.status}${sess.failure_reason ? `: ${sess.failure_reason}` : ""}`;
    this.blockRun(db, now, { run, stepRun, stepTpl, template, goal }, reason, options);
    return;
  }

  // Synthesis path: build sessionResult (tail; later Task 11 can also append session summary).
  const tail = decodeSessionTail(this.sessionOutputStore.readTail(args.sessionId));

  const transcript = reconstructTranscript(
    listArtifactsForRun(db, run.id).filter((a) => a.stepRunId === stepRun.id)
  );
  const stepRunByStepId = this.stepRunIdsByTemplateId(db, run.id);
  const stepInput = buildStepExecutionInput({
    goal: { id: goal.id, description: goal.description },
    steps: template.steps,
    currentStep: stepTpl,
    artifacts: listArtifactsForRun(db, run.id),
    transcript,
    stepRunByStepId,
  });

  const provider = goal.orchestrator_provider;
  const model = goal.orchestrator_model;
  if (!provider || !model) {
    this.blockRun(db, now, { run, stepRun, stepTpl, template, goal },
      "synthesis requires orchestrator model", options);
    return;
  }

  const result = await synthesizeStepOutput(
    { broker: this.broker },
    {
      goalId: goal.id,
      workflowRunId: run.id,
      stepRunId: stepRun.id,
      providerId: provider,
      modelId: model,
      outputSchema: stepTpl.outputSchema,
      stepInput,
      sessionResult: tail,
    }
  );

  if (!result.ok) {
    this.blockRun(db, now, { run, stepRun, stepTpl, template, goal },
      result.reason, options);
    return;
  }

  const body = JSON.stringify({ ...result.output, _completion: { confidence: "medium", assumptions: [], openQuestions: [], whyComplete: `Derived from session ${args.sessionId} via ${result.source}` } });
  const stagedEvents: DomainEvent[] = [];
  createArtifact(db, now, {
    goalId: goal.id,
    workflowRunId: run.id,
    stepRunId: stepRun.id,
    type: "step_output",
    title: stepTpl.name.slice(0, 256),
    body,
    source: result.source, // "agent" | "orchestrator"
    linkedSessionId: args.sessionId,
    linkedTaskId: null,
    linkedContextPackageId: null,
  }, options.idFactory, stagedEvents);
  this.publish(options.bus, stagedEvents);

  await this.requestNextDecision(db, now, run.id, options);
}
```

Implementation notes:
- `decodeSessionTail` from Task 4; `synthesizeStepOutput` from Task 5; `buildStepExecutionInput` + `reconstructTranscript` exist from Phase 1.
- The `_completion` block is synthesized (the agent path does not produce a self-check). Confidence defaults to `"medium"`. Higher fidelity is out of Phase 2 scope.

- [ ] **Step 4: Wire the subscriber in `server.ts`**

In `apps/daemon/src/server.ts` near `subscribeOrchestrationTriggers(ctx)`, add:
```ts
ctx.bus.subscribe((event) => {
  if (event.type !== "session.exited" && event.type !== "session.stopped" && event.type !== "session.failed") return;
  const sessionId = typeof event.payload.sessionId === "string" ? event.payload.sessionId : null;
  const goalId = typeof event.payload.goalId === "string" ? event.payload.goalId : null;
  if (!sessionId || !goalId) return;
  orchestratorService.onWorkflowSessionCompleted(ctx.db, ctx.now, { sessionId, goalId }, { bus: ctx.bus, idFactory: ctx.idFactory })
    .catch((err) => console.error("[workflow] onWorkflowSessionCompleted error", err));
});
```

Keep the existing M5 triggers untouched. The workflow subscriber is additive.

- [ ] **Step 5: Add `sessionOutputStore` to daemon-context**

In `daemon-context.ts`:
```ts
import { createSessionOutputStore, type SessionOutputStore } from "./sessions/output-store.js";

export interface DaemonContext {
  // ... existing
  sessionOutputStore: SessionOutputStore;
}

// in createDaemonContext:
const sessionOutputStore = createSessionOutputStore(db);
return { /* existing fields */, sessionOutputStore };
```

Pass `sessionOutputStore` into `new OrchestratorService(...)` at every construction site (the constructor gains a fifth arg).

- [ ] **Step 6: Run tests + commit**

Run: `pnpm --filter @orca/daemon test session-completion`
Expected: PASS (6 tests).
```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/session-completion.test.ts apps/daemon/src/server.ts apps/daemon/src/daemon-context.ts apps/daemon/src/workflows/orchestrator/test-helpers.ts
git commit -m "feat(daemon): session-completion → step output synthesis + auto-advance"
```

---

## Task 9: Production WorkflowSessionLauncher impl + workspace selection

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/session-launcher-impl.ts`
- Test: `apps/daemon/src/workflows/orchestrator/session-launcher-impl.test.ts`
- Modify: `apps/daemon/src/daemon-context.ts` (wire the impl)

Direct launch needs a workspace. Phase 2 picks **the first attached workspace for the goal** (deterministic, documented limitation). If the goal has no workspace, the launcher throws `direct_launch_unsupported` and the agent step falls back to the recommendation surface (caller in Task 7 already handles failure via `blockRun` only when the gated path is also exhausted; for the direct path we treat the throw as "must use recommendation" — see Step 3 below).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { ProductionWorkflowSessionLauncher } from "./session-launcher-impl.js";

describe("ProductionWorkflowSessionLauncher", () => {
  it("creates a session via createSessionUseCase with adapterId stripped from agent:<id>", async () => {
    const createSession = vi.fn(async () => ({ id: "sess-1" }));
    const firstWorkspaceId = vi.fn(() => "ws-1");
    const launcher = new ProductionWorkflowSessionLauncher({ createSession, firstWorkspaceId });
    const r = await launcher.launch({
      goalId: "g", workflowRunId: "r", workflowStepRunId: "sr",
      operatorId: "agent:codex", operatorKind: "agent", objective: "do it",
    });
    expect(r.sessionId).toBe("sess-1");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      goalId: "g", workspaceId: "ws-1", adapterId: "codex",
      workflowStepRunId: "sr", instruction: "do it",
    }));
  });

  it("throws direct_launch_unsupported if the goal has no workspace", async () => {
    const launcher = new ProductionWorkflowSessionLauncher({
      createSession: vi.fn(),
      firstWorkspaceId: vi.fn(() => null),
    });
    await expect(launcher.launch({
      goalId: "g", workflowRunId: "r", workflowStepRunId: "sr",
      operatorId: "agent:codex", operatorKind: "agent", objective: "x",
    })).rejects.toThrow(/direct_launch_unsupported/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test session-launcher-impl`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// session-launcher-impl.ts
import type {
  WorkflowLaunchContext,
  WorkflowSessionLauncher,
} from "./session-launcher.js";

export interface ProductionLauncherDeps {
  createSession: (input: {
    goalId: string;
    workspaceId: string;
    adapterId: string;
    workflowStepRunId: string;
    instruction: string;
    role?: string;
    title?: string;
  }) => Promise<{ id: string }>;
  firstWorkspaceId: (goalId: string) => string | null;
}

function adapterIdFrom(operatorId: string): string {
  return operatorId.startsWith("agent:") ? operatorId.slice("agent:".length) : operatorId;
}

export class ProductionWorkflowSessionLauncher implements WorkflowSessionLauncher {
  constructor(private readonly deps: ProductionLauncherDeps) {}

  async launch(ctx: WorkflowLaunchContext): Promise<{ sessionId: string }> {
    const workspaceId = this.deps.firstWorkspaceId(ctx.goalId);
    if (!workspaceId) throw new Error("direct_launch_unsupported: no workspace attached to goal");
    const created = await this.deps.createSession({
      goalId: ctx.goalId,
      workspaceId,
      adapterId: adapterIdFrom(ctx.operatorId),
      workflowStepRunId: ctx.workflowStepRunId,
      instruction: ctx.objective,
      role: "engineer",
      title: `Workflow step: ${ctx.workflowStepRunId}`,
    });
    return { sessionId: created.id };
  }
}
```

Wire in `daemon-context.ts`:
```ts
import { ProductionWorkflowSessionLauncher } from "./workflows/orchestrator/session-launcher-impl.js";
import { createSession as createSessionUseCase } from "./sessions/usecases.js";
import { listWorkspacesForGoal } from "./workspaces/projection.js"; // verify the name; mirror existing readers

const workflowSessionLauncher = new ProductionWorkflowSessionLauncher({
  createSession: (input) => createSessionUseCase({ db, bus, now, idFactory }, input),
  firstWorkspaceId: (goalId) => listWorkspacesForGoal(db, goalId)[0]?.id ?? null,
});
// add to returned DaemonContext as workflowSessionLauncher
```

Also extend the `commitAgentStepDecision` direct path (Task 7) to catch the launcher throw and fall back to the recommendation path:
```ts
if (outcome === "direct") {
  try {
    await this.launcher.launch(launchCtx);
    return this.commitNoopLatestDecision(db, run.id, stepRun.id);
  } catch {
    return this.commitLaunchRecommendation(db, now, ctx, chosen, objective, true, options);
  }
}
```

- [ ] **Step 4: Run tests + commit**

Run: `pnpm --filter @orca/daemon test session-launcher-impl`
Expected: PASS.
```bash
git add apps/daemon/src/workflows/orchestrator/session-launcher-impl.ts apps/daemon/src/workflows/orchestrator/session-launcher-impl.test.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/daemon-context.ts
git commit -m "feat(daemon): ProductionWorkflowSessionLauncher (first workspace; fallback to recommendation)"
```

---

## Task 10: Mid-run interview (A4)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/agent-interview.ts`
- Test: `apps/daemon/src/workflows/orchestrator/agent-interview.test.ts`
- Modify: `apps/daemon/src/sessions/runtime.ts` (export `getHandle` if not public; we already saw `getHandle(sessionId)`)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (hook into worker-hook traces for `awaiting_input`)
- Modify: `apps/daemon/src/workflows/steps/routes.ts` (already creates `interview_turn` from Phase 1 — extend to also call back into A4 to inject answer into the running session)

The full A4 design (worker-hook → request_user_input → answer → write into PTY) is the most complex piece. Sub-tasks:

### 10a. Pure injection helper

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { formatAnswerForAgentStdin } from "./agent-interview.js";

describe("formatAnswerForAgentStdin", () => {
  it("appends a newline", () => {
    expect(formatAnswerForAgentStdin("yes")).toBe("yes\n");
  });
  it("strips control sequences and trims", () => {
    expect(formatAnswerForAgentStdin("  hithere  ")).toBe("hithere\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test agent-interview`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// agent-interview.ts
export function formatAnswerForAgentStdin(answer: string): string {
  const stripped = answer.replace(/[\x00-\x1f\x7f]/g, ""); // strip controls incl. BEL/ESC
  return `${stripped.trim()}\n`;
}

export interface AgentInterviewDeps {
  getHandle(sessionId: string): { write(data: Buffer): void } | undefined;
}

export function injectAnswerToSession(
  deps: AgentInterviewDeps,
  sessionId: string,
  answer: string
): "injected" | "no_session" {
  const handle = deps.getHandle(sessionId);
  if (!handle) return "no_session";
  handle.write(Buffer.from(formatAnswerForAgentStdin(answer), "utf8"));
  return "injected";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test agent-interview`
Expected: PASS.

### 10b. Worker-hook awaiting_input → request_user_input

- [ ] **Step 5: Extend the workflow session-completion subscriber to also fire on worker state changes**

In `server.ts`, the existing `workflow.worker.state_changed` event carries `attemptId`/`workerId`. For Phase 2 agents, the equivalent signal is the **session-side** worker-hook trace. The simplest robust mechanism: a new helper `detectAwaitingInputFromTail(text)` that scans the latest session tail for an Orca sentinel, e.g.:
```
[orca:ask] question="What region?"
```
Add the sentinel detection to a periodic poll (or, better, hook the session output store's `appendChunk` to call a callback when the sentinel appears).

Add to `agent-interview.ts`:
```ts
const ASK_SENTINEL_RE = /\[orca:ask\]\s+question="([^"]{1,512})"/;

export function detectPendingAgentQuestion(tail: string): string | null {
  const m = tail.match(ASK_SENTINEL_RE);
  return m ? m[1] : null;
}
```

- [ ] **Step 6: Test the detector**

```ts
describe("detectPendingAgentQuestion", () => {
  it("extracts the sentinel question", () => {
    expect(detectPendingAgentQuestion('foo\n[orca:ask] question="Region?"\nbar')).toBe("Region?");
  });
  it("returns null when absent", () => {
    expect(detectPendingAgentQuestion("nothing here")).toBeNull();
  });
});
```

- [ ] **Step 7: Hook the detector into the orchestrator**

Add to `OrchestratorService`:
```ts
async onSessionOutputChunk(
  db: Database.Database,
  now: () => string,
  args: { sessionId: string; goalId: string },
  options: RequestNextDecisionOptions = {}
): Promise<void> {
  const sess = db.prepare(
    "SELECT workflow_step_run_id FROM sessions WHERE id = ?"
  ).get(args.sessionId) as { workflow_step_run_id: string | null } | undefined;
  if (!sess?.workflow_step_run_id) return;
  const tail = decodeSessionTail(this.sessionOutputStore.readTail(args.sessionId));
  const question = detectPendingAgentQuestion(tail);
  if (!question) return;
  const stepRun = readStepRun(db, sess.workflow_step_run_id);
  if (this.hasActiveUnansweredQuestion(db, /* stepArtifacts */ listArtifactsForRun(db, /* runId */ ""), stepRun.id)) {
    return; // already asked
  }
  // emit the request_user_input decision (re-use Phase 1 path)
  const run = getWorkflowRunById(db, /* run id */ ""); // resolve via stepRun
  // ... build ctx and call commitUserInputDecision(...)
}
```

Wire this into the session-output append path (or into the workflow subscriber on a debounced tick). Production: subscribe to a new `session.output.appended` bus event if not present; if not present, add it to `output-store.appendChunk` (`bus.publish` a lightweight event with `{ sessionId, goalId }`) and subscribe in `server.ts`.

Test in `apps/daemon/src/workflows/orchestrator/agent-interview.test.ts`:
```ts
it("sentinel in tail → emits request_user_input decision once", async () => {
  const t = setupAgentRunWithSentinel({ tail: '[orca:ask] question="Region?"' });
  await t.service.onSessionOutputChunk(t.db, t.now, { sessionId: t.sessionId, goalId: "g" }, t.opts);
  await t.service.onSessionOutputChunk(t.db, t.now, { sessionId: t.sessionId, goalId: "g" }, t.opts);
  expect(t.countDecisions("request_user_input")).toBe(1);
});
```

### 10c. Inject the answer back when the user submits

- [ ] **Step 8: Extend `apps/daemon/src/workflows/steps/routes.ts` submit handler**

After creating the `interview_turn` artifact and before returning, look up the running session linked to the step run; if present, inject the answer via `agent-interview.injectAnswerToSession`:
```ts
const linked = deps.db.prepare(
  "SELECT id FROM sessions WHERE workflow_step_run_id = ? AND status IN ('running','starting') ORDER BY started_at DESC LIMIT 1"
).get(updatedStep.id) as { id: string } | undefined;
if (linked) {
  injectAnswerToSession({ getHandle: (id) => deps.sessionRuntime.getHandle(id) }, linked.id, answerText);
}
```
Add `sessionRuntime: SessionRuntime` to the `deps` shape (already constructed in `server.ts`).

- [ ] **Step 9: Test the inject path**

```ts
it("submit user input writes the answer into the running session PTY", async () => {
  const t = setupSkillSubmitWithRunningSession();
  await t.submit({ stepRunId: t.stepRunId, questionDecisionId: "dec-1", answerText: "us-west-2" });
  expect(t.fakeHandle.write).toHaveBeenCalledWith(Buffer.from("us-west-2\n", "utf8"));
});
```

- [ ] **Step 10: Run tests + commit**

Run: `pnpm --filter @orca/daemon test agent-interview`
Expected: PASS.
```bash
git add apps/daemon/src/workflows/orchestrator/agent-interview.ts apps/daemon/src/workflows/orchestrator/agent-interview.test.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/steps/routes.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): agent mid-run interview (sentinel detect + PTY answer injection)"
```

---

## Task 11: Workspace context retrieval (Workstream B)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/workspace-context.ts`
- Test: `apps/daemon/src/workflows/orchestrator/workspace-context.test.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/step-input.ts` (add optional `workspaceContext`)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (assemble + attach)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { assembleWorkspaceContext } from "./workspace-context.js";

describe("assembleWorkspaceContext", () => {
  it("returns workspaces + memory-derived summaries", () => {
    const ctx = assembleWorkspaceContext({
      workspaces: [{ id: "ws1", name: "monorepo", root: "/r" }],
      summaries: [{ workspaceId: "ws1", summary: "TS monorepo with pnpm" }],
      snippets: [],
      payloadBudget: 4096,
    });
    expect(ctx.workspaces[0].name).toBe("monorepo");
    expect(ctx.summaries[0].summary).toMatch(/monorepo/);
  });

  it("truncates summaries to the payload budget", () => {
    const huge = "x".repeat(8192);
    const ctx = assembleWorkspaceContext({
      workspaces: [{ id: "ws1", name: "n", root: "/r" }],
      summaries: [{ workspaceId: "ws1", summary: huge }],
      snippets: [{ path: "src/a.ts", excerpt: huge }],
      payloadBudget: 1024,
    });
    const size = Buffer.byteLength(JSON.stringify(ctx), "utf8");
    expect(size).toBeLessThanOrEqual(1024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test workspace-context`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// workspace-context.ts
export interface WorkspaceContextInput {
  workspaces: Array<{ id: string; name: string; root: string }>;
  summaries: Array<{ workspaceId: string; summary: string }>;
  snippets: Array<{ path: string; excerpt: string }>;
  payloadBudget: number; // bytes
}

export interface WorkspaceContextOutput {
  workspaces: Array<{ id: string; name: string; root: string }>;
  summaries: Array<{ workspaceId: string; summary: string }>;
  snippets: Array<{ path: string; excerpt: string }>;
}

export function assembleWorkspaceContext(input: WorkspaceContextInput): WorkspaceContextOutput {
  const out: WorkspaceContextOutput = {
    workspaces: input.workspaces.slice(0, 8),
    summaries: input.summaries.slice(0, 8).map((s) => ({ workspaceId: s.workspaceId, summary: s.summary.slice(0, 2048) })),
    snippets: input.snippets.slice(0, 8).map((s) => ({ path: s.path.slice(0, 256), excerpt: s.excerpt.slice(0, 1024) })),
  };
  // Greedy shrink until under budget.
  while (Buffer.byteLength(JSON.stringify(out), "utf8") > input.payloadBudget) {
    if (out.snippets.length > 0) { out.snippets.pop(); continue; }
    if (out.summaries.length > 0) {
      const s = out.summaries[out.summaries.length - 1];
      if (s.summary.length > 128) s.summary = s.summary.slice(0, Math.max(128, Math.floor(s.summary.length * 0.5)));
      else out.summaries.pop();
      continue;
    }
    if (out.workspaces.length > 0) { out.workspaces.pop(); continue; }
    break;
  }
  return out;
}
```

- [ ] **Step 4: Extend `StepExecutionInput`**

In `step-input.ts`:
```ts
export interface StepExecutionInput {
  // ... existing fields
  workspaceContext?: WorkspaceContextOutput;
}
```
Extend `buildStepExecutionInput` args to accept `workspaceContext?: WorkspaceContextOutput` and pass it through.

- [ ] **Step 5: Source + attach in the model step path**

In `service.ts` `commitSkillStepDecision` (model branch), before constructing `input`, assemble:
```ts
const wc = assembleWorkspaceContext({
  workspaces: readGoalWorkspaces(db, goal.id),       // existing projection
  summaries: readWorkspaceMemorySummaries(db, goal.id), // memory items by workspace
  snippets: [],                                       // empty in Phase 2 (no embeddings)
  payloadBudget: Math.floor(ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES * 0.25),
});
```
Wire `readGoalWorkspaces` / `readWorkspaceMemorySummaries` from existing modules (`apps/daemon/src/workspaces/projection.ts`, `apps/daemon/src/memory/projection.ts`) — verify names before importing; add thin shims if needed. If memory has no per-workspace association, derive an empty `summaries` array (still usable for the workspaces list).

Add a unit test in `service.skill-step.test.ts`:
```ts
it("model step input includes workspaceContext when workspaces are attached", async () => {
  const t = setupSkillStepRun({ attachedWorkspaces: [{ id: "ws1", name: "m", root: "/r" }] });
  await t.service.requestNextDecision(t.db, t.now, t.runId, t.opts);
  const sent = t.broker.lastRequestPayload();
  expect(sent.workspaceContext?.workspaces[0].id).toBe("ws1");
});
```

- [ ] **Step 6: Run tests + commit**

Run: `pnpm --filter @orca/daemon test workspace-context && pnpm --filter @orca/daemon test service.skill-step`
Expected: PASS.
```bash
git add apps/daemon/src/workflows/orchestrator/workspace-context.ts apps/daemon/src/workflows/orchestrator/workspace-context.test.ts apps/daemon/src/workflows/orchestrator/step-input.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.skill-step.test.ts
git commit -m "feat(daemon): workspaceContext in step input envelope (Workstream B)"
```

---

## Task 12: Production Engineering step instructions (Workstream C)

**Files:**
- Modify: `apps/daemon/src/workflows/templates/seed-engineering.ts`
- Test: `apps/daemon/src/workflows/templates/seed-engineering.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { WorkflowStepTemplate } from "@orca/contracts";
import { seedEngineeringTemplate, ENGINEERING_ID, ENGINEERING_VERSION } from "./seed-engineering.js";
import { runMigrations, defaultMigrationsDir } from "../../migrations.js";

describe("engineering seed (production instructions)", () => {
  it("version is bumped to 3", () => {
    expect(ENGINEERING_VERSION).toBe(3);
  });

  it("all steps validate and have non-placeholder instructions + non-trivial schemas", () => {
    const db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    seedEngineeringTemplate(db, () => "2026-05-27T00:00:00.000Z");
    const row = db.prepare("SELECT steps_json FROM workflow_templates WHERE id=?").get(ENGINEERING_ID) as { steps_json: string };
    const steps = JSON.parse(row.steps_json) as Array<{ id: string; name: string; instructions: string; outputSchema: unknown[] }>;
    for (const s of steps) {
      expect(() => WorkflowStepTemplate.parse(s)).not.toThrow();
      expect(s.instructions.length).toBeGreaterThan(80);
    }
    const exec = steps.find((s) => s.id === "execution")!;
    const keys = (exec.outputSchema as Array<{ key: string }>).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["changed_files", "validation", "summary", "blocked"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test seed-engineering`
Expected: FAIL — `ENGINEERING_VERSION` still 2 and instructions are placeholders.

- [ ] **Step 3: Rewrite the steps**

Set `export const ENGINEERING_VERSION = 3;`. Replace each non-intake step. Example (keep intake from Phase 1 as-is):

```ts
{
  id: "research",
  ordinal: 1,
  name: "Research",
  instructions:
    "Ground the implementation approach in the current codebase and known risks. Use the " +
    "available workspaceContext (summaries and snippets) before asking the user. Identify " +
    "the smallest set of files, modules, and constraints the work will touch, and call out " +
    "any risks the brief did not capture. Complete only when the approach is plausible and " +
    "the risk set is enumerated.",
  outputSchema: [
    { key: "summary", type: "string", required: true },
    { key: "files_in_scope", type: "array", itemType: "string", required: true },
    { key: "risks", type: "array", itemType: "string", required: false },
  ],
},
{
  id: "prd",
  ordinal: 2,
  name: "PRD / Destination",
  instructions:
    "Turn the intake brief and research into a buildable destination document. Capture the " +
    "user-visible outcome, the acceptance signals, and the non-goals. Avoid premature design " +
    "details — leave implementation choices to issue breakdown.",
  outputSchema: [
    { key: "summary", type: "string", required: true },
    { key: "user_outcome", type: "string", required: true },
    { key: "acceptance_signals", type: "array", itemType: "string", required: true },
    { key: "non_goals", type: "array", itemType: "string", required: false },
  ],
},
{
  id: "issue_breakdown",
  ordinal: 3,
  name: "Issue Breakdown",
  instructions:
    "Convert the PRD into independently grabbable vertical-slice tasks. Each task should be " +
    "atomic, shippable, and have clear acceptance criteria. Prefer fewer larger tasks over " +
    "many trivial ones; flag tasks that require coordination.",
  outputSchema: [
    { key: "summary", type: "string", required: true },
    { key: "tasks", type: "array", itemType: "object", required: true,
      fields: [
        { key: "title", type: "string", required: true },
        { key: "acceptance", type: "string", required: true },
      ] },
  ],
},
{
  id: "execution",
  ordinal: 4,
  name: "Execution",
  instructions:
    "Implement the next unblocked task in the issue breakdown. Edit only the files in scope. " +
    "Run unit tests and typecheck before declaring success; if you skip a check, record the " +
    "reason. If you hit an irrecoverable blocker, set blocked=true with a clear reason.",
  outputSchema: [
    { key: "summary", type: "string", required: true },
    { key: "changed_files", type: "array", itemType: "string", required: true },
    { key: "validation", type: "object", required: true,
      fields: [
        { key: "ran", type: "boolean", required: true },
        { key: "passed", type: "boolean", required: true },
        { key: "skipped", type: "string", required: false },
      ] },
    { key: "blocked", type: "boolean", required: true },
    { key: "blocked_reason", type: "string", required: false },
  ],
},
{
  id: "qa",
  ordinal: 5,
  name: "QA",
  instructions:
    "Conduct human-led product judgment using an Orca-generated acceptance checklist. Ask the " +
    "user to confirm each acceptance signal from the PRD; record what passed, what failed, " +
    "and the user's verdict.",
  outputSchema: [
    { key: "summary", type: "string", required: true },
    { key: "checklist", type: "array", itemType: "object", required: true,
      fields: [
        { key: "item", type: "string", required: true },
        { key: "result", type: "string", required: true },
      ] },
    { key: "verdict", type: "string", required: true },
  ],
},
{
  id: "review",
  ordinal: 6,
  name: "Fresh-Context Review",
  instructions:
    "Review the implementation against the PRD in a fresh context (no implementer assumptions). " +
    "Identify correctness, scope, and risk concerns. If anything is unsafe to ship, return " +
    "actionable change requests; otherwise approve.",
  outputSchema: [
    { key: "summary", type: "string", required: true },
    { key: "approved", type: "boolean", required: true },
    { key: "change_requests", type: "array", itemType: "string", required: false },
  ],
},
{
  id: "done",
  ordinal: 7,
  name: "Done",
  instructions:
    "Finalize the durable outcome. Capture the lessons learned and any reusable memory items " +
    "for future goals.",
  outputSchema: [
    { key: "summary", type: "string", required: true },
    { key: "memory_items", type: "array", itemType: "string", required: false },
  ],
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test seed-engineering`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/templates/seed-engineering.ts apps/daemon/src/workflows/templates/seed-engineering.test.ts
git commit -m "feat(daemon): production Engineering step instructions + schemas (bump v3)"
```

---

## Task 13: Optional pipeline-compat validation (Workstream D)

**Files:**
- Create: `apps/daemon/src/workflows/templates/validate-pipeline.ts`
- Test: `apps/daemon/src/workflows/templates/validate-pipeline.test.ts`
- Modify: `apps/daemon/src/workflows/templates/routes.ts` (call validator on create/update; surface warnings)

Warn-only static pass. Spec calls this "lowest priority"; include only if tests run cleanly without churn.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { validateTemplatePipeline } from "./validate-pipeline.js";
import type { WorkflowStepTemplate } from "@orca/contracts";

const step = (id: string, ordinal: number, outputKeys: string[]): WorkflowStepTemplate => ({
  id, ordinal, name: id, instructions: "x",
  outputSchema: outputKeys.map((k) => ({ key: k, type: "string", required: true })),
});

describe("validateTemplatePipeline", () => {
  it("returns no warnings when no instructions reference later-step keys", () => {
    const w = validateTemplatePipeline([step("a", 0, ["x"]), step("b", 1, ["y"])]);
    expect(w).toEqual([]);
  });

  it("warns when a later step's instructions reference an unknown earlier key", () => {
    const steps: WorkflowStepTemplate[] = [
      step("a", 0, ["alpha"]),
      { ...step("b", 1, ["y"]), instructions: "Use the {{beta}} from step a." },
    ];
    const w = validateTemplatePipeline(steps);
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/beta/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test validate-pipeline`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// validate-pipeline.ts
import type { WorkflowStepTemplate } from "@orca/contracts";

const REF_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function validateTemplatePipeline(steps: WorkflowStepTemplate[]): string[] {
  const warnings: string[] = [];
  const knownByOrdinal: string[][] = [];
  const sorted = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  for (const step of sorted) {
    const refs = new Set<string>();
    let m: RegExpExecArray | null;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(step.instructions)) !== null) refs.add(m[1]);

    const knownSoFar = new Set(knownByOrdinal.flat());
    for (const ref of refs) {
      if (!knownSoFar.has(ref)) {
        warnings.push(`step '${step.id}' instructions reference unknown key '{{${ref}}}'`);
      }
    }
    knownByOrdinal.push(step.outputSchema.map((f) => f.key));
  }
  return warnings;
}
```

- [ ] **Step 4: Surface warnings on create/update template**

In `apps/daemon/src/workflows/templates/routes.ts`, after successful insert/update, call `validateTemplatePipeline(steps)` and return the warnings in the response body under `warnings: string[]` (extend response schemas if needed). Do not reject the template.

- [ ] **Step 5: Run tests + commit**

Run: `pnpm --filter @orca/daemon test validate-pipeline`
Expected: PASS.
```bash
git add apps/daemon/src/workflows/templates/validate-pipeline.ts apps/daemon/src/workflows/templates/validate-pipeline.test.ts apps/daemon/src/workflows/templates/routes.ts
git commit -m "feat(daemon): warn-only pipeline-compat validator for workflow templates"
```

---

## Task 14: Desktop polish

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Modify: `apps/desktop/src/workflows/TemplateDetail.tsx` (display warnings from Task 13 if returned)

- [ ] **Step 1: Confirm the launch flow handles `operatorKind === "agent"` for all adapter ids**

`adapterIdFromOperator` already strips `agent:` (line 893 of `OrcaChat.tsx`). Add an explicit test that ensures the launch button is offered for every `AdapterId` in `OperatorDescriptor.list`. If a coverage gap surfaces, extend `adapterIdFromOperator`.

- [ ] **Step 2: Show pipeline warnings in TemplateDetail**

If `templateResponse.warnings?.length > 0`, render an unobtrusive yellow box above the steps list:
```tsx
{warnings && warnings.length > 0 && (
  <div className="workflow-warnings">
    <strong>Heads up:</strong>
    <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
  </div>
)}
```
Add CSS class in `workflows.css` (one rule, yellow background).

- [ ] **Step 3: Manually verify in the browser**

Run the desktop dev server + daemon. Create a goal, attach a workspace, start the Engineering template, run intake to completion, advance to research, observe the model step. Run execution — observe the `launch_workflow_session` recommendation card, accept it, complete the session by typing a fenced `orca-output` block, observe auto-advance. If you cannot run the full stack, state so explicitly in the PR rather than claiming verification.

- [ ] **Step 4: Tests + commit**

Run: `pnpm --filter @orca/desktop typecheck && pnpm --filter @orca/desktop test`
Expected: PASS.
```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/workflows/TemplateDetail.tsx apps/desktop/src/workflows/workflows.css
git commit -m "feat(desktop): show pipeline warnings; verify agent launch coverage"
```

---

## Task 15: Full-suite green + final integration pass

**Files:** repo-wide

- [ ] **Step 1: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS. Fix any residual references to removed/renamed fields.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS. Investigate every failure as a real regression. Common breakage: Phase 1 service tests that asserted on the `allowedKinds: ["model"]` filter or on `recordOperatorSelection`'s narrow signature; recommendation-store tests that did not know about new `launch_workflow_session` proposed actions for agent steps.

- [ ] **Step 3: Grep for orphaned references**

Run: `grep -rln "allowedKinds: \[\"model\"\]" apps packages --include=*.ts | grep -v test | grep -v dist`
Expected: no application-code hits.

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: post-phase-2 cleanup"
```

---

## Self-review (completed during authoring)

- **Spec coverage:**
  - A1 routing across model + agent: Task 7 (drops `allowedKinds: ["model"]`, branches on `chosen.kind`) — covered.
  - A2 agent lifecycle (gated launch → session → completion → synthesis): Tasks 6, 7, 8 — covered.
  - A3 hybrid parse-then-synthesize: Tasks 3, 4, 5 (helpers) + Task 8 (orchestration) — covered.
  - A4 mid-run interview: Task 10 — covered.
  - A5 approval-gate via guardrail: Task 7 (`evaluateGuardrailRequiresApproval` + recommendation path) — covered.
  - Workstream B retrieval: Task 11 — covered.
  - Workstream C production instructions: Task 12 — covered.
  - Workstream D static pipeline validation: Task 13 — covered.
  - Data model changes (synthesize_step_output, SynthesisRequest): Task 1 — covered.
  - Error handling: Task 5 (synthesis retries), Task 8 (session failure → block, idempotency), Task 7 (no ready operator → block) — covered.
- **Type consistency:** `WorkflowSessionLauncher`, `WorkflowLaunchContext`, `WorkflowContext`, `synthesizeStepOutput`, `decodeSessionTail`, `parseOrcaOutputBlock`, `augmentInstructionsWithOutputConvention`, `buildAgentObjective`, `evaluateGuardrailRequiresApproval`, `assembleWorkspaceContext`, `validateTemplatePipeline`, `onWorkflowSessionCompleted`, `onSessionOutputChunk`, `injectAnswerToSession`, `formatAnswerForAgentStdin`, `detectPendingAgentQuestion` are used consistently across tasks.
- **Open assumptions to verify when implementing:**
  - Exact workspace-projection function names in `apps/daemon/src/workspaces/projection.ts` and any per-workspace memory summary reader — verify before importing in Task 11.
  - The `session.output.appended` bus event may not exist; if not, Task 10 Step 5 adds it inside `createSessionOutputStore.appendChunk` and subscribes in `server.ts`. Confirm by reading `output-store.ts` first.
  - `createSessionUseCase` signature in `apps/daemon/src/sessions/usecases.ts` — `ProductionWorkflowSessionLauncher` (Task 9) must match the actual fields (`workspaceId`, `adapterId`, `workflowStepRunId`, `instruction`).
  - `SessionRuntime.getHandle` is already present (`runtime.ts:402`); confirm it is exported on the public class API used by route deps before relying on it in Task 10c.
  - Phase 1's `commitNoop` returns the latest `request_user_input` decision; for the agent path (Task 7) it must be generalized to return the latest decision for the step run *regardless of type* — rename to `commitNoopLatestDecision` and update Phase 1's single existing caller to keep its current semantics (filter by `request_user_input`).
  - Phase 2 keeps `approval_launch_agent` active on the seeded Engineering template, so the direct-launch path is exercised only by user-authored templates that disable the guardrail. This matches the spec's "supervised by default" non-goal.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-instruction-driven-workflow-steps-phase2.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with two-stage review. Best fit for this plan because Tasks 7, 8, and 10 each touch the orchestrator service and benefit from a clean context per task.

2. **Inline Execution** — Use `superpowers:executing-plans` with checkpoints. Faster on small tasks (1–6, 12, 13), heavier on the big service-mutation tasks.

Recommended: **Subagent-Driven**, with manual checkpoints after Task 7 (agent branch), Task 8 (session-completion wiring), and Task 10 (mid-run interview).

## Notable changes (Phase 2 implementation — deviations from this plan)

Tracked for future reference. Each entry is where the as-built implementation departed from the plan text above.

- **Task 5 — synthesis failure reason** (plan text §Task 5 Step 3). The plan hard-codes `reason: "synthesis schema invalid after retry"` even on transport-level failures (e.g. `needs_human_review`). Implemented faithfully to plan; this swallows non-schema reasons. Noted as a known limit. Fix candidate: surface `result.status` / `result.failureReason` from the last broker attempt.
- **Task 7 — constructor wiring strategy.** The plan said to update every `new OrchestratorService(...)` call site to pass the launcher. Instead, the implementer made `launcher` a default param with `{ launch: async () => { throw new Error("direct_launch_unsupported"); } }`, so untouched call sites get the throwing stub. Task 9 then wires the production launcher through every call site explicitly. Functionally identical at the boundary.
- **Task 7 — `commitNoop` rename.** The plan suggested generalising the Phase 1 `commitNoop` (which filters by `request_user_input`) into `commitNoopLatestDecision`. Implementer kept `commitNoop` intact and added a new `commitNoopLatestDecision` method; lower-friction, preserves Phase 1 callsite semantics.
- **Task 7 — Phase 1 test updated.** `service.skill-step.test.ts` previously asserted `expect(seen[0]?.allowedKinds).toEqual(["model"])`; updated to `expect(seen[0]?.allowedKinds).toBeUndefined()` because Phase 2 drops the `allowedKinds` filter.
- **Task 7 — launcher routing inlined.** The plan reused `recommendationOrDirectLaunch` for both routing and fire-and-forget launch. Once Task 9 added a `try/catch` fallback around `await launcher.launch(...)`, that helper became inapplicable to the awaited path. Implementer inlined the routing decision (`requiresApproval ? "recommendation" : "direct"`) in `commitAgentStepDecision` and kept `recommendationOrDirectLaunch` exported but unused by `service.ts`.
- **Task 8 — `sessionOutputStore` defaulted with `NULL_OUTPUT_STORE`.** Plan added the param through every construction site. Implementer made it an optional 5th param defaulting to a stub that throws if `readTail` is called. Tests inject a fake; production wires the real store via daemon-context. Route construction sites unchanged.
- **Task 8 — server.ts shared service refactor.** Plan said to "add a subscription near existing triggers". Implementer extracted a shared `orchestratorService` instance (with `sessionOutputStore`) that replaces the prior inline bootstrap-route construction. Both this and the bus subscription land in the same commit.
- **Task 8 — idempotent path swallows errors** (plan text §Task 8 Step 3, the `.catch(() => {})`). Implemented faithfully; if `requestNextDecision` throws during the post-existing-output advance, the error is dropped silently. Noted as a known limit.
- **Task 9 — `createSession` adapter pattern.** The real `apps/daemon/src/sessions/usecases.ts createSession` does NOT accept `workflowStepRunId`. Implementer worked around by wrapping in daemon-context: call `createSession(...)` then immediately `UPDATE sessions SET workflow_step_run_id = ? WHERE id = ?` so `onWorkflowSessionCompleted`'s linked-session query keeps working. Better long-term fix: thread `workflowStepRunId` through the use-case (out of Phase 2 scope).
- **Task 9 — fallback catch is bare.** The plan's `try { await launcher.launch(...) } catch { commitLaunchRecommendation(...) }` masks all errors as `direct_launch_unsupported` (createSession bugs, FK errors, etc. fall through). Implemented as plan specified. Fix candidate: discriminate on error message.
- **Task 9 — workflowSessionLauncher threaded through route deps.** `OrchestratorRouteDeps` and `WorkflowStepRouteDeps` gained an optional `workflowSessionLauncher` field; `server.ts` passes `daemonContext.workflowSessionLauncher` to all three construction sites.
- **Task 9 — workspace reader name.** Plan referenced `listWorkspacesForGoal`. Real export is `listWorkspacesByGoal` (in `apps/daemon/src/workspaces/projection.ts`). Also: the `Workspace` row has no `root` field; use `path`. `firstWorkspaceId(goalId) = workspaces[0]?.id ?? null`.
- **Task 10 — callback hook over bus event.** Plan suggested adding a new bus event `session.output.appended` or threading a callback. Implementer chose the callback path: `createSessionOutputStore` gained `onChunkAppended?: (sessionId) => void`, called synchronously after each non-empty chunk transaction. Avoids contract-layer changes.
- **Task 10 — late-binding orchestrator ref in `server.ts`.** Because `createSessionOutputStore` runs before `new OrchestratorService(...)`, the callback closure can't reference the service directly. Implementer used a `_orchestratorServiceRef = { current: null }` pattern; the callback reads `.current` and bails if not yet set. Chunks fired pre-wiring drop silently — acceptable during startup.
- **Task 11 — `Workspace.root` field doesn't exist.** Plan's `WorkspaceContextInput.workspaces[].root: string` was sourced from `Workspace.path` in the projection (same field).
- **Task 11 — empty summaries.** No per-workspace memory summary reader exists in the projection layer. Implementer passes `summaries: []`. `workspaceContext` is omitted from `StepExecutionInput` entirely (rather than set to an empty object) when no workspaces are attached.
- **Task 12 — `ENGINEERING_VERSION` already 3.** Phase 1's intake bump had already moved version to 3; no additional bump needed. Test still passes (`expect(ENGINEERING_VERSION).toBe(3)`).
- **Task 13 — `WorkflowTemplateResponse` contract extension.** Adding `warnings: string[]` to the response required a contract change in `packages/contracts`. Done additively with `z.array(z.string()).default([])` so callers omitting `warnings` get `[]`. Mocks in desktop tests updated.
- **Task 14 — `api.ts` return shape changed.** `saveTemplate`, `duplicateTemplate`, and `createTemplate` now return `TemplateResult { template, warnings }`. All callers updated (`WorkflowsPage.tsx`, `TemplateDetail.tsx`, tests).
- **Task 15 — additional typecheck fixes** (`chore: post-phase-2 typecheck cleanup`, SHA `0702d37`):
  - `triggers.test.ts` — added `workflowSessionLauncher` stub to the DaemonContext mock.
  - `proposals.ts:153` — `validatePayload`'s switch was missing the new `"synthesize_step_output"` decision kind; added as a fall-through to the `"unsupported proposal kind"` failure case (the validator does not actually need a synthesizer-aware branch here; the broker passes through to the caller's `validateProposal`).
  - `service.ts` (3 sites in `onWorkflowSessionCompleted`) — `blockRun` calls passed `{ run, stepRun, stepTpl, template, goal }` but the signature accepts no `template`. Dropped `template`.
  - `synthesize.test.ts` — `as const` on `status: "proposed"` / `transport: "one_shot"` for `BrokerResult` assignability; added `sessionResult: ""` to the `input` constant.
