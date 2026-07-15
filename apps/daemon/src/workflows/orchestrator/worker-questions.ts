export interface RecordInput {
  toolUseId: string;
}

export interface RecordHandle {
  questionId: string;
  /** False when a question with the same toolUseId was already recorded (duplicate
   * hook fire) — callers use this to avoid posting a second chat message. */
  isNew: boolean;
}

/**
 * Mints a stable questionId per worker AskUserQuestion tool call and dedups
 * duplicate PreToolUse hook fires by toolUseId. The question itself is persisted
 * durably (a chat message plus a step-run park via pending_worker_question_id),
 * so this in-memory map is NOT the source of truth — it only stops a double-fire
 * of the same tool call from posting the question twice within one daemon
 * lifetime. There is no held promise: the elicit hook returns immediately and the
 * step parks until the human answers.
 */
export class WorkerQuestionStore {
  private readonly byToolUseId = new Map<string, string>();

  constructor(private readonly idFactory: () => string = () => Math.random().toString(36).slice(2)) {}

  record(input: RecordInput): RecordHandle {
    const existing = this.byToolUseId.get(input.toolUseId);
    if (existing) return { questionId: existing, isNew: false };
    const questionId = this.idFactory();
    this.byToolUseId.set(input.toolUseId, questionId);
    return { questionId, isNew: true };
  }
}
