import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  WORKFLOW_DECISION_MAX_INFLUENCES,
  WORKFLOW_DECISION_MAX_REASON_BYTES,
  WORKFLOW_OPERATOR_SELECTION_MAX_ALTERNATIVES,
  WORKFLOW_OPERATOR_SELECTION_MAX_REASON_BYTES,
  WorkflowDecisionTrace,
  type DomainEvent,
  type OperatorSelection,
  type WorkflowDecisionInfluence,
  type WorkflowDecisionType,
} from "@orca/contracts";

import type { EventBus } from "../../events.js";
import { redactSecrets } from "../../memory/normalize.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../events.js";

export interface RecordDecisionInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string | null;
  decisionType: WorkflowDecisionType;
  selectedAction: string;
  reason: string;
  influencedBy: WorkflowDecisionInfluence[];
  alternativesConsidered?: string[];
  confidence?: number;
  operatorSelection?: OperatorSelection;
  inputFingerprint: string;
}

export interface RecordDecisionInTxOptions {
  idFactory?: () => string;
  stagedEvents?: DomainEvent[];
}

export interface RecordDecisionOptions {
  idFactory?: () => string;
  bus?: EventBus;
}

interface WorkflowDecisionRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_run_id: string | null;
  decision_type: WorkflowDecisionType;
  selected_action: string;
  reason: string;
  influenced_by_json: string;
  alternatives_considered_json: string;
  confidence: number | null;
  operator_selection_json: string | null;
  created_at: string;
}

function truncateUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  const truncated = Buffer.from(input, "utf8").subarray(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(truncated);
}

function sanitizeReason(reason: string): string {
  return truncateUtf8(redactSecrets(reason.trim()), WORKFLOW_DECISION_MAX_REASON_BYTES);
}

function sanitizeAction(action: string): string {
  return redactSecrets(action.trim()).slice(0, 200);
}

function sanitizeInfluence(influence: WorkflowDecisionInfluence): WorkflowDecisionInfluence {
  return {
    ...influence,
    id: influence.id.slice(0, 100),
    label: redactSecrets(influence.label.trim()).slice(0, 128),
  };
}

function sanitizeAlternatives(alternatives: string[] | undefined): string[] {
  return (alternatives ?? [])
    .slice(0, WORKFLOW_OPERATOR_SELECTION_MAX_ALTERNATIVES)
    .map((value) => redactSecrets(value.trim()).slice(0, 200));
}

function sanitizeConfidence(confidence: number | undefined): number | null {
  if (confidence === undefined) return null;
  if (!Number.isFinite(confidence)) return null;
  return Math.max(0, Math.min(1, confidence));
}

function sanitizeOperatorSelection(
  selection: OperatorSelection | undefined
): OperatorSelection | null {
  if (!selection) return null;
  return {
    ...selection,
    operatorId: selection.operatorId.slice(0, 100),
    reason: truncateUtf8(
      redactSecrets(selection.reason.trim()),
      WORKFLOW_OPERATOR_SELECTION_MAX_REASON_BYTES
    ),
    requiredCapabilities: selection.requiredCapabilities.slice(0, 20),
    alternativesConsidered: selection.alternativesConsidered
      .slice(0, WORKFLOW_OPERATOR_SELECTION_MAX_ALTERNATIVES)
      .map((value) => value.slice(0, 100)),
    confidence: Math.max(0, Math.min(1, selection.confidence)),
  };
}

function parseJsonArray<T>(raw: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

export function decisionFingerprint(parts: {
  runId: string;
  stepRunId: string | null;
  decisionType: string;
  payload: unknown;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.runId, parts.stepRunId, parts.decisionType, parts.payload]))
    .digest("hex");
}

export function getDecisionById(
  db: Database.Database,
  id: string
): WorkflowDecisionTrace | null {
  const row = db
    .prepare("SELECT * FROM workflow_decisions WHERE id = ?")
    .get(id) as WorkflowDecisionRow | undefined;
  if (!row) return null;
  return WorkflowDecisionTrace.parse({
    decisionId: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    decisionType: row.decision_type,
    selectedAction: row.selected_action,
    reason: row.reason,
    influencedBy: parseJsonArray<WorkflowDecisionInfluence>(row.influenced_by_json, []),
    alternativesConsidered: parseJsonArray<string>(
      row.alternatives_considered_json,
      []
    ),
    confidence: row.confidence ?? undefined,
    operatorSelectionJson: row.operator_selection_json
      ? (JSON.parse(row.operator_selection_json) as OperatorSelection)
      : undefined,
    createdAt: row.created_at,
  });
}

export function listDecisionsForRun(
  db: Database.Database,
  runId: string
): WorkflowDecisionTrace[] {
  const rows = db
    .prepare("SELECT id FROM workflow_decisions WHERE workflow_run_id = ? ORDER BY created_at DESC")
    .all(runId) as Array<{ id: string }>;
  return rows
    .map((row) => getDecisionById(db, row.id))
    .filter((decision): decision is WorkflowDecisionTrace => decision !== null);
}

function findDecisionIdByFingerprint(
  db: Database.Database,
  input: Pick<
    RecordDecisionInput,
    "workflowRunId" | "stepRunId" | "decisionType" | "inputFingerprint"
  >
): string | null {
  const existing = db
    .prepare(
      "SELECT id FROM workflow_decisions WHERE workflow_run_id = ? AND COALESCE(step_run_id, '') = ? AND decision_type = ? AND input_fingerprint = ?"
    )
    .get(
      input.workflowRunId,
      input.stepRunId ?? "",
      input.decisionType,
      input.inputFingerprint
    ) as { id: string } | undefined;
  return existing?.id ?? null;
}

export function recordDecisionInTx(
  db: Database.Database,
  now: () => string,
  input: RecordDecisionInput,
  options: RecordDecisionInTxOptions = {}
): WorkflowDecisionTrace {
  const existingId = findDecisionIdByFingerprint(db, input);
  if (existingId) return getDecisionById(db, existingId)!;

  const idFactory = options.idFactory ?? randomUUID;
  const decisionId = idFactory();
  const influencedBy = input.influencedBy
    .slice(0, WORKFLOW_DECISION_MAX_INFLUENCES)
    .map(sanitizeInfluence);
  const alternatives = sanitizeAlternatives(input.alternativesConsidered);
  const operatorSelection = sanitizeOperatorSelection(input.operatorSelection);
  const createdAt = now();

  db.prepare(
    "INSERT INTO workflow_decisions (id, goal_id, workflow_run_id, step_run_id, decision_type, selected_action, reason, influenced_by_json, alternatives_considered_json, confidence, operator_selection_json, input_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    decisionId,
    input.goalId,
    input.workflowRunId,
    input.stepRunId,
    input.decisionType,
    sanitizeAction(input.selectedAction),
    sanitizeReason(input.reason),
    JSON.stringify(influencedBy),
    JSON.stringify(alternatives),
    sanitizeConfidence(input.confidence),
    operatorSelection ? JSON.stringify(operatorSelection) : null,
    input.inputFingerprint,
    createdAt
  );

  const event = appendWorkflowEvent(
    db,
    "workflow.decision.recorded",
    {
      decisionId,
      goalId: input.goalId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      decisionType: input.decisionType,
      influencedByCount: influencedBy.length,
    },
    createdAt,
    idFactory
  );
  options.stagedEvents?.push(event);

  return getDecisionById(db, decisionId)!;
}

export function recordDecision(
  db: Database.Database,
  now: () => string,
  input: RecordDecisionInput,
  options: RecordDecisionOptions = {}
): WorkflowDecisionTrace {
  const stagedEvents: DomainEvent[] = [];
  const decision = db.transaction(() =>
    recordDecisionInTx(db, now, input, {
      idFactory: options.idFactory,
      stagedEvents,
    })
  )();
  if (options.bus) {
    publishStagedWorkflowEvents(options.bus, stagedEvents);
  }
  return decision;
}
