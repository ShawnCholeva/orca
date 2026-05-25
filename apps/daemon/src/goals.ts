import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import {
  Goal,
  GuidedRefinementOutput,
  OrchestratorModelChoice,
  UpdateGoalRequest,
  type UpdateGoalOrchestratorModelResponse,
  type DomainEvent,
  type DomainEventType,
  type InspectWorkspacePreview,
} from "@orca/contracts";
import { getDatabase } from "./db.js";
import { eventBus, EventBus } from "./events.js";
import type { SkillRegistry } from "./registry/skill-registry.js";
import { insertGoalRefinement } from "./goal-refinements.js";
import { seedRefinementMemory } from "./memory/refinement-seed.js";
import { insertWorkspace } from "./workspaces/projection.js";
import type { ModelProviderRegistry } from "./llm/registry.js";

export interface CreateGoalCtx {
  db: Database.Database;
  bus: EventBus;
  skills: SkillRegistry;
  modelProviderRegistry: ModelProviderRegistry;
  inspectWorkspace(inputPath: string): Promise<InspectWorkspacePreview>;
}

export class ValidationError extends Error {
  constructor(public readonly issues: unknown) {
    super("Validation failed");
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Goal not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class DuplicateWorkspaceInRequestError extends Error {
  readonly code = "duplicate_workspace_in_request" as const;
  constructor() {
    super("Duplicate workspace paths in request after canonicalization");
    this.name = "DuplicateWorkspaceInRequestError";
  }
}

interface GoalRow {
  id: string;
  title: string;
  description: string;
  status: string;
  autonomy_level: number;
  orchestrator_provider: string | null;
  orchestrator_model: string | null;
  active_workflow_run_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function rowToGoal(row: GoalRow): Goal {
  return Goal.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    autonomyLevel: row.autonomy_level,
    orchestratorProvider: row.orchestrator_provider,
    orchestratorModel: row.orchestrator_model,
    activeWorkflowRunId: row.active_workflow_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  });
}

// Tracks current DB instance to detect close/reopen cycles and re-prepare statements.
let _db: Database.Database | null = null;
let _stmts: {
  insertEvent: Database.Statement;
  insertGoal: Database.Statement;
  selectGoals: Database.Statement;
  selectGoalById: Database.Statement;
  updateGoal: Database.Statement;
  archiveGoal: Database.Statement;
  updateGoalOrchestratorModel: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertEvent: db.prepare(
        "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
      ),
      insertGoal: db.prepare(
        "INSERT INTO goals (id, title, description, status, autonomy_level, orchestrator_provider, orchestrator_model, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?)"
      ),
      selectGoals: db.prepare(
        "SELECT * FROM goals WHERE archived_at IS NULL ORDER BY updated_at DESC"
      ),
      selectGoalById: db.prepare("SELECT * FROM goals WHERE id = ?"),
      updateGoal: db.prepare(
        "UPDATE goals SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ?"
      ),
      archiveGoal: db.prepare(
        "UPDATE goals SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?"
      ),
      updateGoalOrchestratorModel: db.prepare(
        "UPDATE goals SET orchestrator_provider = ?, orchestrator_model = ?, updated_at = ? WHERE id = ?"
      ),
    };
  }
  return _stmts!;
}

type CreateGoalInput = {
  title: string;
  description?: string;
  refined?: GuidedRefinementOutput;
  workspaces?: Array<{ inputPath: string; name?: string }>;
  orchestratorModel?: OrchestratorModelChoice;
};

type GoalOrigin = {
  title: string;
  description: string;
  skillId: string;
  extensionPoint: string;
  durationMs: number;
};

function resolveGoalOrigin(
  input: CreateGoalInput,
  ctx: CreateGoalCtx,
  validatedRefined: GuidedRefinementOutput | undefined,
): GoalOrigin {
  if (validatedRefined) {
    return {
      title: validatedRefined.title,
      description: validatedRefined.description,
      skillId: "guided-goal-refinement",
      extensionPoint: "goal.refine",
      durationMs: 0,
    };
  }
  const skill = ctx.skills.byId("quick-goal");
  if (!skill) throw new Error("Boot misconfiguration: quick-goal skill not registered");
  const startedAt = performance.now();
  // ValidationError from skill.invoke propagates as-is (→ HTTP 400); no DB writes occur.
  const normalized = skill.invoke(input, { now: () => new Date().toISOString() }) as {
    title: string;
    description: string;
  };
  return {
    title: normalized.title,
    description: normalized.description,
    skillId: skill.id,
    extensionPoint: skill.extensionPoint,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

export async function createGoal(input: CreateGoalInput, ctx: CreateGoalCtx): Promise<Goal> {
  const { refined, workspaces } = input;

  let validatedRefined: GuidedRefinementOutput | undefined;
  if (refined !== undefined) {
    const r = GuidedRefinementOutput.safeParse(refined);
    if (!r.success) throw new ValidationError(r.error.issues);
    validatedRefined = r.data;
  }

  let validatedOrchestratorModel: OrchestratorModelChoice | undefined;
  if (input.orchestratorModel !== undefined) {
    const parsed = OrchestratorModelChoice.safeParse(input.orchestratorModel);
    if (!parsed.success) throw new ValidationError(parsed.error.issues);
    validatedOrchestratorModel = parsed.data;

    const provider = ctx.modelProviderRegistry.get(parsed.data.providerId);
    if (!provider) {
      throw new ValidationError([
        {
          code: "custom",
          message: "unknown model provider",
          path: ["orchestratorModel", "providerId"],
        },
      ]);
    }

    const models = await provider.listModels();
    const hasModel = models.some((model) => model.id === parsed.data.modelId);
    if (!hasModel) {
      throw new ValidationError([
        {
          code: "custom",
          message: "unknown model for provider",
          path: ["orchestratorModel", "modelId"],
        },
      ]);
    }
  }

  // Inspect all workspaces in parallel; any failure propagates before entering the transaction.
  const inspected = await Promise.all(
    (workspaces ?? []).map(async (ws) => ({
      preview: await ctx.inspectWorkspace(ws.inputPath),
      name: ws.name,
    })),
  );
  if (inspected.length > 1) {
    const paths = inspected.map((w) => w.preview.path);
    if (new Set(paths).size !== paths.length) throw new DuplicateWorkspaceInRequestError();
  }

  const { title, description, skillId, extensionPoint, durationMs } = resolveGoalOrigin(
    input,
    ctx,
    validatedRefined,
  );

  const goalId = randomUUID();
  const now = new Date().toISOString();
  const stmts = ensureStmts(ctx.db);
  const toPublish: DomainEvent[] = [];

  ctx.db.transaction(() => {
    const emitEvent = (type: DomainEventType, payload: Record<string, unknown>): DomainEvent => {
      const eventId = randomUUID();
      const r = stmts.insertEvent.run(eventId, type, goalId, JSON.stringify(payload), now);
      return { seq: Number(r.lastInsertRowid), id: eventId, type, goalId, payload, createdAt: now };
    };

    toPublish.push(emitEvent("skill.invoked", { skillId, extensionPoint, durationMs }));
    toPublish.push(emitEvent("goal.created", { title, description }));
    stmts.insertGoal.run(
      goalId,
      title,
      description,
      validatedOrchestratorModel?.providerId ?? null,
      validatedOrchestratorModel?.modelId ?? null,
      now,
      now
    );

    if (validatedRefined) {
      const refinedPayload = {
        skillId: validatedRefined.skillId,
        successCriteria: validatedRefined.successCriteria,
        constraints: validatedRefined.constraints,
        assumptions: validatedRefined.assumptions,
      };
      toPublish.push(emitEvent("goal.refined", refinedPayload));
      insertGoalRefinement(ctx.db, {
        goalId,
        skillId: validatedRefined.skillId,
        successCriteria: validatedRefined.successCriteria,
        constraints: validatedRefined.constraints,
        assumptions: validatedRefined.assumptions,
        refinedAt: now,
      });
    }

    for (const { preview, name } of inspected) {
      const wsId = randomUUID();
      const wsName = name ?? preview.name;
      const wsPayload = {
        workspaceId: wsId,
        path: preview.path,
        name: wsName,
        workspaceType: preview.workspaceType,
        branch: preview.branch,
        isDirty: preview.isDirty,
        gitProbe: preview.gitProbe,
      };
      toPublish.push(emitEvent("workspace.attached", wsPayload));
      insertWorkspace(ctx.db, {
        id: wsId,
        goalId,
        path: preview.path,
        name: wsName,
        workspaceType: preview.workspaceType,
        branch: preview.branch,
        isDirty: preview.isDirty,
        gitProbe: preview.gitProbe,
        attachedAt: now,
      });
    }
  })();

  for (const event of toPublish) {
    ctx.bus.publish(event);
  }

  if (validatedRefined) {
    seedRefinementMemory({ db: ctx.db, bus: ctx.bus }, goalId);
  }

  return {
    id: goalId,
    title,
    description,
    status: "active",
    autonomyLevel: 1,
    orchestratorProvider: validatedOrchestratorModel?.providerId ?? null,
    orchestratorModel: validatedOrchestratorModel?.modelId ?? null,
    activeWorkflowRunId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

export function updateGoal(id: string, input: unknown): Goal {
  const parsed = UpdateGoalRequest.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues);
  }
  const patch = parsed.data;

  const db = getDatabase();
  const stmts = ensureStmts(db);
  const eventId = randomUUID();
  const now = new Date().toISOString();
  const payload = JSON.stringify(patch);

  let seq = 0;
  let updatedRow: GoalRow | undefined;

  db.transaction(() => {
    const existing = stmts.selectGoalById.get(id) as GoalRow | undefined;
    if (!existing || existing.archived_at !== null) {
      throw new NotFoundError(id);
    }

    const result = stmts.insertEvent.run(eventId, "goal.updated", id, payload, now);
    seq = Number(result.lastInsertRowid);

    stmts.updateGoal.run(
      patch.title ?? null,
      patch.description ?? null,
      now,
      id
    );
    updatedRow = stmts.selectGoalById.get(id) as GoalRow;
  })();

  eventBus.publish({
    seq,
    id: eventId,
    type: "goal.updated",
    goalId: id,
    payload: patch as Record<string, unknown>,
    createdAt: now,
  });

  return rowToGoal(updatedRow!);
}

export function archiveGoal(id: string): Goal {
  const db = getDatabase();
  const stmts = ensureStmts(db);
  const eventId = randomUUID();
  const now = new Date().toISOString();

  let seq = 0;
  let updatedRow: GoalRow | undefined;

  db.transaction(() => {
    const existing = stmts.selectGoalById.get(id) as GoalRow | undefined;
    if (!existing || existing.archived_at !== null) {
      throw new NotFoundError(id);
    }

    const result = stmts.insertEvent.run(eventId, "goal.archived", id, "{}", now);
    seq = Number(result.lastInsertRowid);

    stmts.archiveGoal.run(now, now, id);
    updatedRow = stmts.selectGoalById.get(id) as GoalRow;
  })();

  eventBus.publish({
    seq,
    id: eventId,
    type: "goal.archived",
    goalId: id,
    payload: {},
    createdAt: now,
  });

  return rowToGoal(updatedRow!);
}

export async function updateGoalOrchestratorModel(
  id: string,
  input: unknown,
  registry: ModelProviderRegistry
): Promise<UpdateGoalOrchestratorModelResponse> {
  const parsed = OrchestratorModelChoice.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues);
  }

  const provider = registry.get(parsed.data.providerId);
  if (!provider) {
    throw new ValidationError([
      {
        code: "custom",
        message: "unknown model provider",
        path: ["providerId"],
      },
    ]);
  }

  const models = await provider.listModels();
  if (!models.some((model) => model.id === parsed.data.modelId)) {
    throw new ValidationError([
      {
        code: "custom",
        message: "unknown model for provider",
        path: ["modelId"],
      },
    ]);
  }

  const db = getDatabase();
  const stmts = ensureStmts(db);
  const eventId = randomUUID();
  const now = new Date().toISOString();

  let seq = 0;

  db.transaction(() => {
    const existing = stmts.selectGoalById.get(id) as GoalRow | undefined;
    if (!existing || existing.archived_at !== null) {
      throw new NotFoundError(id);
    }

    const payload = JSON.stringify({
      providerId: parsed.data.providerId,
      modelId: parsed.data.modelId,
    });
    const result = stmts.insertEvent.run(
      eventId,
      "goal.orchestrator_model_changed",
      id,
      payload,
      now
    );
    seq = Number(result.lastInsertRowid);

    stmts.updateGoalOrchestratorModel.run(
      parsed.data.providerId,
      parsed.data.modelId,
      now,
      id
    );
  })();

  eventBus.publish({
    seq,
    id: eventId,
    type: "goal.orchestrator_model_changed",
    goalId: id,
    payload: {
      providerId: parsed.data.providerId,
      modelId: parsed.data.modelId,
    },
    createdAt: now,
  });

  return {
    goalId: id,
    orchestratorProvider: parsed.data.providerId,
    orchestratorModel: parsed.data.modelId,
  };
}

export function listGoals(): Goal[] {
  const stmts = ensureStmts(getDatabase());
  const rows = stmts.selectGoals.all() as GoalRow[];
  return rows.map(rowToGoal);
}

export function getGoalById(db: Database.Database, id: string): Goal | null {
  const stmts = ensureStmts(db);
  const row = stmts.selectGoalById.get(id) as GoalRow | undefined;
  if (!row || row.archived_at !== null) {
    return null;
  }
  return rowToGoal(row);
}
