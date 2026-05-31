import type { PendingQuestionItem } from "@orca/contracts";

export interface PendingWorkerQuestion {
  toolUseId: string;
  sessionId: string;
  goalId: string;
  questions: PendingQuestionItem[];
  resolve: (reason: string) => void;
  answered: Promise<string>;
}

export interface RecordInput {
  toolUseId: string;
  sessionId: string;
  goalId: string;
  questions: PendingQuestionItem[];
}

export interface RecordHandle {
  questionId: string;
  answered: Promise<string>;
  /** False when a question with the same toolUseId was already recorded (duplicate
   * hook fire) — callers use this to avoid posting a second chat message. */
  isNew: boolean;
}

export class WorkerQuestionStore {
  private readonly pending = new Map<string, PendingWorkerQuestion>();
  private readonly byToolUseId = new Map<string, string>();

  constructor(private readonly idFactory: () => string = () => Math.random().toString(36).slice(2)) {}

  record(input: RecordInput): RecordHandle {
    const existingId = this.byToolUseId.get(input.toolUseId);
    if (existingId) {
      const existing = this.pending.get(existingId);
      if (existing) return { questionId: existingId, answered: existing.answered, isNew: false };
    }
    const questionId = this.idFactory();
    let resolve!: (reason: string) => void;
    const answered = new Promise<string>((res) => { resolve = res; });
    this.pending.set(questionId, { ...input, resolve, answered });
    this.byToolUseId.set(input.toolUseId, questionId);
    return { questionId, answered, isNew: true };
  }

  get(questionId: string): PendingWorkerQuestion | undefined {
    return this.pending.get(questionId);
  }

  /** Resolves the held hook with `reason`. Returns false if already resolved/absent. */
  resolveAnswers(questionId: string, reason: string): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    this.pending.delete(questionId);
    this.byToolUseId.delete(entry.toolUseId);
    entry.resolve(reason);
    return true;
  }
}
