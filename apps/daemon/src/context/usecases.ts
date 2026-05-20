import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ContextAssembly,
  ContextAssemblyOutput,
  ContextPackage,
  CONTEXT_PACKAGE_MAX_RENDERED_BYTES,
  type ContextAssemblyFailureCode,
  type DomainEvent,
} from '@orca/contracts';
import type { EventBus } from '../events.js';
import type { SessionPreparationAssembler } from './assembler.js';
import {
  getActiveAssemblyByFingerprint,
  getContextPackageById,
  insertContextAssembly,
  insertContextPackage,
  updateAssemblyFailed,
  updateAssemblyStarted,
  updateAssemblySucceeded,
} from './projection.js';
import { buildContextAssemblyInput } from './input.js';
import { renderToCanonical } from './renderer.js';

export interface RequestContextPackageCtx {
  db: Database.Database;
  bus: EventBus;
  assembler: SessionPreparationAssembler;
  now?: () => string;
  idFactory?: () => string;
}

export interface RequestContextPackageInput {
  goalId: string;
  adapterId: string;
  workspaceId: string | null;
  role: string;
  objective: string;
  replacePackageId: string | null;
  trigger: string;
}

export interface RequestContextPackageResult {
  assembly: ContextAssembly;
  package: ContextPackage | null;
  reused: boolean;
}

const FAILURE_MESSAGE_MAX_CHARS = 256;

let _db: Database.Database | null = null;
let _stmts: {
  insertEvent: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      insertEvent: db.prepare(
        'INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function capFailureMessage(msg: string): string {
  return msg.slice(0, FAILURE_MESSAGE_MAX_CHARS);
}

function computeRequestFingerprint(parts: {
  goalId: string;
  adapterId: string;
  role: string;
  objectiveHash: string;
  workspaceId: string;
  sourceFingerprint: string;
  assemblerVersion: string;
  replacePackageId: string;
}): string {
  const raw = [
    parts.goalId,
    parts.adapterId,
    parts.role,
    parts.objectiveHash,
    parts.workspaceId,
    parts.sourceFingerprint,
    parts.assemblerVersion,
    parts.replacePackageId,
  ].join(':');
  return sha256(raw);
}

function buildFailedAssembly(
  id: string,
  base: {
    goalId: string;
    packageId: null;
    replacePackageId: string | null;
    adapterId: string;
    workspaceId: string | null;
    role: string;
    objectiveHash: string;
    sourceFingerprint: string;
    assemblerVersion: string;
    requestFingerprint: string;
    trigger: string;
    requestedAt: string;
  },
  failure: { failureCode: ContextAssemblyFailureCode; failureMessage: string | null; finishedAt: string }
): ContextAssembly {
  return ContextAssembly.parse({
    id,
    ...base,
    status: 'failed',
    ...failure,
    startedAt: null,
  });
}

function emitEvent(
  stmts: NonNullable<typeof _stmts>,
  type: DomainEvent['type'],
  goalId: string,
  payload: Record<string, unknown>,
  now: string
): DomainEvent {
  const eventId = randomUUID();
  const result = stmts.insertEvent.run(eventId, type, goalId, JSON.stringify(payload), now);
  return {
    seq: Number(result.lastInsertRowid),
    id: eventId,
    type,
    goalId,
    payload,
    createdAt: now,
  };
}

export function requestContextPackage(
  ctx: RequestContextPackageCtx,
  input: RequestContextPackageInput
): RequestContextPackageResult {
  const now = ctx.now?.() ?? new Date().toISOString();
  const idFactory = ctx.idFactory ?? randomUUID;
  const stmts = ensureStmts(ctx.db);

  const { goalId, adapterId, workspaceId, role, objective, replacePackageId, trigger } = input;

  const normalizedObjective = objective.trim();
  const objectiveHash = sha256(normalizedObjective);
  const assemblerVersion = ctx.assembler.version;

  // Build real assembler input and compute real source fingerprint from M1/M3/M5 projections.
  // Throws GoalNotFoundError if the goal does not exist.
  const { input: assemblyInput, sourceFingerprint, goalArchivedAt } = buildContextAssemblyInput(
    { db: ctx.db, assemblerVersion },
    { goalId, workspaceId, role, adapterId, objective: normalizedObjective, objectiveHash }
  );

  const requestFingerprint = computeRequestFingerprint({
    goalId,
    adapterId,
    role,
    objectiveHash,
    workspaceId: workspaceId ?? '',
    sourceFingerprint,
    assemblerVersion,
    replacePackageId: replacePackageId ?? '',
  });

  // Idempotency: return existing active assembly without new events.
  const existing = getActiveAssemblyByFingerprint(ctx.db, goalId, requestFingerprint);
  if (existing) {
    const pkg = existing.packageId ? getContextPackageById(ctx.db, existing.packageId) : null;
    return { assembly: existing, package: pkg, reused: true };
  }

  const assemblyId = idFactory();
  const toPublish: DomainEvent[] = [];
  let resultAssembly!: ContextAssembly;
  let resultPackage: ContextPackage | null = null;

  // Shared fields for all ContextAssembly result objects built in this call.
  const asmBase = {
    goalId,
    packageId: null as null,
    replacePackageId,
    adapterId,
    workspaceId,
    role,
    objectiveHash,
    sourceFingerprint,
    assemblerVersion,
    requestFingerprint,
    trigger,
    requestedAt: now,
  };

  if (goalArchivedAt !== null) {
    // Goal is archived: insert failed assembly atomically with failure event.
    const failureCode: ContextAssemblyFailureCode = 'goal_archived';
    const failureMessage = capFailureMessage('goal is archived');

    ctx.db.transaction(() => {
      insertContextAssembly(ctx.db, {
        id: assemblyId,
        ...asmBase,
        status: 'failed',
        failureCode,
        failureMessage,
        startedAt: null,
        finishedAt: now,
      });
      toPublish.push(
        emitEvent(stmts, 'context.assembly.failed', goalId, { assemblyId, goalId, failureCode }, now)
      );
    })();

    for (const event of toPublish) ctx.bus.publish(event);

    return {
      assembly: buildFailedAssembly(assemblyId, asmBase, { failureCode, failureMessage, finishedAt: now }),
      package: null,
      reused: false,
    };
  }

  ctx.db.transaction(() => {
    // Insert assembly as pending.
    insertContextAssembly(ctx.db, {
      id: assemblyId,
      ...asmBase,
      status: 'pending',
      failureCode: null,
      failureMessage: null,
      startedAt: null,
      finishedAt: null,
    });

    // Emit requested event (always for non-archived goals).
    toPublish.push(
      emitEvent(stmts, 'context.assembly.requested', goalId, { assemblyId, goalId, adapterId, role }, now)
    );

    // Invoke assembler synchronously with the real input built from M1/M3/M5 projections.
    let output: ContextAssemblyOutput | null = null;
    let failureCode: ContextAssemblyFailureCode = 'internal_error';
    let failureMessage = 'unknown assembler error';

    try {
      const raw = ctx.assembler.assemble(assemblyInput);
      const parsed = ContextAssemblyOutput.safeParse(raw);
      if (!parsed.success) {
        failureCode = 'invalid_output';
        failureMessage = parsed.error.message;
      } else {
        output = parsed.data;
      }
    } catch (err) {
      failureCode = 'internal_error';
      failureMessage = err instanceof Error ? err.message : String(err);
    }

    if (output === null) {
      const capped = capFailureMessage(failureMessage);
      updateAssemblyFailed(ctx.db, assemblyId, { failureCode, failureMessage: capped, finishedAt: now });
      toPublish.push(
        emitEvent(stmts, 'context.assembly.failed', goalId, { assemblyId, goalId, failureCode }, now)
      );
      resultAssembly = buildFailedAssembly(assemblyId, asmBase, { failureCode, failureMessage: capped, finishedAt: now });
      return;
    }

    // Render sections to canonical text and enforce byte cap.
    const { rendered: renderedContext, renderedBytes } = renderToCanonical(output.sections);

    if (renderedBytes > CONTEXT_PACKAGE_MAX_RENDERED_BYTES) {
      const fc: ContextAssemblyFailureCode = 'output_too_large';
      const fm = capFailureMessage(`rendered context exceeds ${CONTEXT_PACKAGE_MAX_RENDERED_BYTES} bytes`);
      updateAssemblyFailed(ctx.db, assemblyId, { failureCode: fc, failureMessage: fm, finishedAt: now });
      toPublish.push(
        emitEvent(stmts, 'context.assembly.failed', goalId, { assemblyId, goalId, failureCode: fc }, now)
      );
      resultAssembly = buildFailedAssembly(assemblyId, asmBase, { failureCode: fc, failureMessage: fm, finishedAt: now });
      return;
    }

    // Success path.
    const packageId = idFactory();
    const estimatedTokens = Math.ceil(renderedBytes / 4); // renderedBytes from renderToCanonical
    const createdAt = now;

    insertContextPackage(ctx.db, {
      id: packageId,
      goalId,
      supersedesPackageId: replacePackageId ?? null,
      adapterId,
      workspaceId,
      role,
      objective: normalizedObjective,
      status: 'ready',
      renderedContext,
      renderedBytes,
      estimatedTokens,
      truncated: output.truncated,
      sparse: output.sparse,
      sourceCount: output.sources.length,
      sources: output.sources,
      warnings: output.warnings,
      sourceFingerprint,
      assemblerVersion,
      createdAt,
    });

    // Transition pending → running → succeeded within the same transaction.
    updateAssemblyStarted(ctx.db, assemblyId, now);
    updateAssemblySucceeded(ctx.db, assemblyId, { packageId, finishedAt: now });

    toPublish.push(
      emitEvent(stmts, 'context.assembly.completed', goalId, {
        assemblyId,
        goalId,
        packageId,
        sourceCount: output.sources.length,
        renderedBytes,
        truncated: output.truncated,
      }, now)
    );
    toPublish.push(
      emitEvent(stmts, 'context.package.created', goalId, {
        packageId,
        goalId,
        adapterId,
        role,
        sourceCount: output.sources.length,
        renderedBytes,
      }, now)
    );

    resultPackage = ContextPackage.parse({
      id: packageId,
      goalId,
      supersedesPackageId: replacePackageId ?? null,
      adapterId,
      workspaceId,
      role,
      objective: normalizedObjective,
      status: 'ready',
      renderedContext,
      renderedBytes,
      estimatedTokens,
      truncated: output.truncated,
      sparse: output.sparse,
      sourceCount: output.sources.length,
      sources: output.sources,
      warnings: output.warnings,
      sourceFingerprint,
      assemblerVersion,
      createdAt,
    });

    resultAssembly = ContextAssembly.parse({
      id: assemblyId,
      goalId,
      packageId,
      replacePackageId,
      adapterId,
      workspaceId,
      role,
      objectiveHash,
      sourceFingerprint,
      assemblerVersion,
      requestFingerprint,
      status: 'succeeded',
      trigger,
      failureCode: null,
      failureMessage: null,
      requestedAt: now,
      startedAt: now,
      finishedAt: now,
    });
  })();

  // Broadcast only after COMMIT.
  for (const event of toPublish) ctx.bus.publish(event);

  return { assembly: resultAssembly, package: resultPackage, reused: false };
}
