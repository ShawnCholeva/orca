import type { PendingQuestionItem, WorkerAnswer } from "@orca/contracts";

export type AnswerValidationError =
  | "incomplete_answers"
  | "question_index_out_of_range"
  | "unknown_label"
  | "too_many_labels";

/** Returns null when answers are valid for the questions, else an error code. */
export function validateAnswers(
  questions: PendingQuestionItem[],
  answers: WorkerAnswer[],
): AnswerValidationError | null {
  if (answers.length !== questions.length) return "incomplete_answers";
  const seen = new Set<number>();
  for (const a of answers) {
    if (a.questionIndex < 0 || a.questionIndex >= questions.length) return "question_index_out_of_range";
    seen.add(a.questionIndex);
    const q = questions[a.questionIndex]!;
    if (!q.multiSelect && a.selectedLabels.length !== 1) return "too_many_labels";
    const labels = new Set(q.options.map((o) => o.label));
    for (const label of a.selectedLabels) if (!labels.has(label)) return "unknown_label";
  }
  if (seen.size !== questions.length) return "incomplete_answers";
  return null;
}

/** Deterministic deny-reason text carrying the user's selections. */
export function assembleAnswerReason(
  questions: PendingQuestionItem[],
  answers: WorkerAnswer[],
): string {
  const byIndex = new Map(answers.map((a) => [a.questionIndex, a]));
  const parts = questions.map((q, i) => {
    const labels = byIndex.get(i)?.selectedLabels ?? [];
    return `Q${i + 1} '${q.header}': ${labels.join(", ")}.`;
  });
  return (
    "User answered via Orca chat. " +
    parts.join(" ") +
    " These are the user's final answers — treat the AskUserQuestion as fully answered with " +
    "exactly these selections and continue. Do not call AskUserQuestion again."
  );
}

/** Deny-reason text carrying the user's own free-text answer. */
export function assembleFreeTextReason(text: string): string {
  return (
    `User answered via Orca chat with a custom response: "${text}". ` +
    "Treat the AskUserQuestion as fully answered with this response and continue. " +
    "Do not call AskUserQuestion again."
  );
}
