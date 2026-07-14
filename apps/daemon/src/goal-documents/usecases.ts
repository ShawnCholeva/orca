// Goal reference documents: user-attached files/URLs whose snapshots are
// injected into agent context. Document refs are prompt INPUTS only — they must
// never become grounding targets (harness-sensors/grounding.ts verifies step
// outputs against the WorkspaceProbe; document paths are not workspace files).
import { randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import type { DomainEvent, DomainEventType, GoalDocument } from "@orca/contracts";
import type { EventBus } from "../events.js";
import { NotFoundError } from "../goals.js";
import {
  DuplicateDocumentError, findGoalDocument, findGoalDocumentByRef,
  insertGoalDocument, listGoalDocumentsByGoal, deleteGoalDocument,
  updateGoalDocumentSnapshot, touchGoalDocumentFetchedAt, toGoalDocumentMeta,
} from "./projection.js";
import {
  DocumentSnapshotError, snapshotFile, snapshotUrl,
  URL_FETCH_TIMEOUT_ATTACH_MS, URL_FETCH_TIMEOUT_REFRESH_MS,
  type DocumentSnapshot,
} from "./snapshot.js";

export { DuplicateDocumentError, DocumentSnapshotError };

export interface GoalDocumentCtx {
  db: Database.Database;
  bus: EventBus;
}

function commitWithEvent(
  ctx: GoalDocumentCtx,
  type: DomainEventType,
  goalId: string,
  payload: Record<string, unknown>,
  mutate: () => void,
): void {
  const now = new Date().toISOString();
  let event!: DomainEvent;
  ctx.db.transaction(() => {
    mutate();
    const id = randomUUID();
    const result = ctx.db.prepare(
      "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, type, goalId, JSON.stringify(payload), now);
    event = { seq: Number(result.lastInsertRowid), id, type, goalId, payload, createdAt: now };
  })();
  ctx.bus.publish(event);
}

export function defaultDocumentName(kind: "file" | "url", ref: string): string {
  if (kind === "file") return path.basename(ref) || ref.slice(0, 100);
  try {
    const url = new URL(ref);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return (last ?? url.host).slice(0, 100);
  } catch {
    return ref.slice(0, 100);
  }
}

export async function takeSnapshot(
  kind: "file" | "url",
  ref: string,
  timeoutMs = URL_FETCH_TIMEOUT_ATTACH_MS,
): Promise<DocumentSnapshot> {
  return kind === "file" ? snapshotFile(ref) : snapshotUrl(ref, timeoutMs);
}

export async function attachGoalDocument(
  ctx: GoalDocumentCtx,
  input: { goalId: string; kind: "file" | "url"; ref: string; name?: string },
): Promise<GoalDocument> {
  const goalRow = ctx.db.prepare("SELECT id, archived_at FROM goals WHERE id = ?")
    .get(input.goalId) as { id: string; archived_at: string | null } | undefined;
  if (!goalRow || goalRow.archived_at !== null) throw new NotFoundError(input.goalId);
  if (findGoalDocumentByRef(ctx.db, input.goalId, input.ref)) {
    throw new DuplicateDocumentError(input.ref);
  }
  // Snapshot synchronously — an unreadable source fails the attach (fail fast
  // while the user is watching; a bad ref is a typo, not a transient error).
  const snapshot = await takeSnapshot(input.kind, input.ref);
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    goal_id: input.goalId,
    kind: input.kind,
    ref: input.ref,
    name: input.name ?? defaultDocumentName(input.kind, input.ref),
    content: snapshot.content,
    content_hash: snapshot.contentHash,
    content_bytes: snapshot.contentBytes,
    truncated: snapshot.truncated ? 1 : 0,
    fetched_at: now,
    created_at: now,
  };
  commitWithEvent(
    ctx, "document.attached", input.goalId,
    { documentId: row.id, kind: row.kind, ref: row.ref, name: row.name, contentHash: row.content_hash },
    () => { insertGoalDocument(ctx.db, row); },
  );
  return toGoalDocumentMeta(row);
}

export async function detachGoalDocument(
  ctx: GoalDocumentCtx,
  input: { goalId: string; documentId: string },
): Promise<void> {
  if (!findGoalDocument(ctx.db, input.goalId, input.documentId)) {
    throw new NotFoundError(input.documentId);
  }
  commitWithEvent(ctx, "document.removed", input.goalId, { documentId: input.documentId }, () => {
    deleteGoalDocument(ctx.db, input.goalId, input.documentId);
  });
}

// Refresh-on-use: re-read/re-fetch every document before context assembly.
// Unreachable sources are swallowed — the last snapshot is the fallback.
// All IO happens before the short write transactions; never call this inside
// a caller's transaction.
export async function refreshGoalDocuments(
  db: Database.Database,
  bus: EventBus,
  goalId: string,
): Promise<void> {
  const docs = listGoalDocumentsByGoal(db, goalId);
  if (docs.length === 0) return;
  const results = await Promise.allSettled(
    docs.map((d) => takeSnapshot(d.kind, d.ref, URL_FETCH_TIMEOUT_REFRESH_MS)),
  );
  const now = new Date().toISOString();
  const ctx: GoalDocumentCtx = { db, bus };
  for (let i = 0; i < docs.length; i++) {
    const result = results[i]!;
    if (result.status === "rejected") continue; // stale fallback: keep last snapshot
    const doc = docs[i]!;
    const snapshot = result.value;
    if (snapshot.contentHash === doc.content_hash) {
      touchGoalDocumentFetchedAt(db, doc.id, now);
      continue;
    }
    commitWithEvent(
      ctx, "document.refreshed", goalId,
      { documentId: doc.id, contentHash: snapshot.contentHash },
      () => { updateGoalDocumentSnapshot(db, doc.id, { ...snapshot, fetchedAt: now }); },
    );
  }
}
