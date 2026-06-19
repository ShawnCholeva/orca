import type { PendingQuestion } from "@orca/contracts";

const RECOMMENDED_SUFFIX = " (Recommended)";

export function WorkerQuestionAnswered({ pending }: { pending: PendingQuestion }) {
  const answer = pending.answer;
  if (answer == null) return null;

  const selectedFor = (qi: number): string[] =>
    answer.answers?.find((a) => a.questionIndex === qi)?.selectedLabels ?? [];

  return (
    <div className="orca-chat-question" data-testid="worker-question-answered">
      <div className="orca-chat-question-header">
        <span>Question</span>
      </div>
      {pending.questions.map((q, qi) => (
        <fieldset key={qi} className="orca-chat-question-block" disabled>
          <legend className="orca-chat-question-legend">
            {pending.questions.length > 1 && <span className="orca-chat-question-index">{qi + 1} · </span>}
            <span>{q.question}</span>
          </legend>
          {q.options.map((opt, oi) => {
            const recommended = opt.label.endsWith(RECOMMENDED_SUFFIX);
            const displayLabel = recommended ? opt.label.slice(0, -RECOMMENDED_SUFFIX.length) : opt.label;
            const chosen = selectedFor(qi).includes(opt.label);
            return (
              <div key={oi} className="orca-chat-option-row">
                <span className="orca-chat-option-content">
                  <span className="orca-chat-option-head">
                    <span className="orca-chat-option-label">
                      {chosen ? "✓ " : ""}{displayLabel}
                    </span>
                  </span>
                </span>
              </div>
            );
          })}
        </fieldset>
      ))}
      {answer.freeText != null ? (
        <div className="orca-chat-option-freetext" data-testid="answered-freetext">{answer.freeText}</div>
      ) : null}
      {answer.viaChat ? (
        <p className="orca-chat-question-answered-note">Answered in chat.</p>
      ) : null}
    </div>
  );
}
