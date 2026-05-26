import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  OperatorSelection,
  getModelProviderDisplayName,
  type HumanReviewPayload,
  type OperatorSelection as OperatorSelectionData,
} from "@orca/contracts";

import { submitHumanReviewDecision, toErrorMessage } from "../../api";

type Props = {
  goalId: string;
  runId: string;
  attemptId: string;
  review: HumanReviewPayload;
  currentStepLabel: string | null;
  onSubmitted: () => Promise<void>;
};

type FormState = {
  operatorId: string;
  operatorKind: OperatorSelectionData["operatorKind"];
  reason: string;
  requiredCapabilitiesText: string;
  alternativesConsideredText: string;
  confidence: string;
  requiresUserApproval: boolean;
};

type FieldErrors = Partial<Record<keyof FormState, string>>;

const EMPTY_FIELDS: FormState = {
  operatorId: "",
  operatorKind: "human",
  reason: "",
  requiredCapabilitiesText: "",
  alternativesConsideredText: "",
  confidence: "0.5",
  requiresUserApproval: false,
};

export function WorkflowHumanReviewPanel({
  goalId,
  runId,
  attemptId,
  review,
  currentStepLabel,
  onSubmitted,
}: Props) {
  const [selectedChoiceId, setSelectedChoiceId] = useState<string>(review.choices[0]?.id ?? "");
  const [fields, setFields] = useState<FormState>(() =>
    formFieldsFromChoice(review.choices[0]) ?? EMPTY_FIELDS,
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const choice = review.choices.find((item) => item.id === selectedChoiceId) ?? review.choices[0];
    setSelectedChoiceId(choice?.id ?? "");
    setFields(formFieldsFromChoice(choice) ?? EMPTY_FIELDS);
    setFieldErrors({});
    setSubmitError(null);
  }, [review, selectedChoiceId]);

  const parsedSummary = parseReviewSummary(review.summary);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    setSubmitError(null);

    const selection = OperatorSelection.safeParse({
      operatorId: fields.operatorId.trim(),
      operatorKind: fields.operatorKind,
      reason: fields.reason.trim(),
      requiredCapabilities: parseListField(fields.requiredCapabilitiesText),
      alternativesConsidered: parseListField(fields.alternativesConsideredText),
      confidence: Number(fields.confidence),
      requiresUserApproval: fields.requiresUserApproval,
    });

    if (!selection.success) {
      const { nextFieldErrors, nextFormError } = mapSelectionErrors(selection.error);
      setFieldErrors(nextFieldErrors);
      setSubmitError(nextFormError);
      return;
    }

    setSaving(true);
    try {
      await submitHumanReviewDecision(goalId, runId, attemptId, {
        choiceId: selectedChoiceId || undefined,
        proposal: {
          orcaProposalVersion: 1,
          kind: "select_operator",
          payload: selection.data,
        },
      });
      await onSubmitted();
    } catch (error) {
      setSubmitError(toErrorMessage(error, "Human review submission failed."));
      setSaving(false);
      return;
    }
    setSaving(false);
  }

  if (review.kind !== "select_operator") {
    return (
      <section className="workflow-panel-card" aria-label="Human review">
        <div className="workflow-panel-card-header">
          <h4 className="workflow-panel-card-title">Human Review Required</h4>
          <span className="workflow-panel-card-meta">{review.kind}</span>
        </div>
        <p className="workflow-panel-empty">
          This workflow requires human review, but the desktop flow currently supports
          structured operator selection only.
        </p>
      </section>
    );
  }

  return (
    <section className="workflow-panel-card" aria-label="Human review">
      <div className="workflow-panel-card-header">
        <div>
          <h4 className="workflow-panel-card-title">Human Review Required</h4>
          <p className="workflow-run-panel-subtitle">
            {review.title} · {getModelProviderDisplayName(review.providerId)} · {review.modelId}
          </p>
        </div>
        <span className="workflow-panel-card-meta">Attempt {attemptId}</span>
      </div>

      <dl className="workflow-human-review-summary">
        <div>
          <dt>Decision kind</dt>
          <dd>{formatDecisionKind(review.kind)}</dd>
        </div>
        <div>
          <dt>Current step</dt>
          <dd>{currentStepLabel ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Current step purpose</dt>
          <dd>{parsedSummary.stepPurpose}</dd>
        </div>
        <div>
          <dt>Failed transport trace</dt>
          <dd>{parsedSummary.failedTransports}</dd>
        </div>
      </dl>

      <form
        className="workflow-human-review-form"
        aria-label="Human review form"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <fieldset className="workflow-human-review-choice-list" disabled={saving}>
          <legend>Validated operator choices</legend>
          {review.choices.map((choice) => {
            const selected = choice.id === selectedChoiceId;
            return (
              <label
                key={choice.id}
                className={`workflow-human-review-choice${selected ? " workflow-human-review-choice--selected" : ""}`}
              >
                <input
                  type="radio"
                  name="human-review-choice"
                  value={choice.id}
                  checked={selected}
                  onChange={() => {
                    setSelectedChoiceId(choice.id);
                    setFields(formFieldsFromChoice(choice) ?? EMPTY_FIELDS);
                    setFieldErrors({});
                    setSubmitError(null);
                  }}
                />
                <span>
                  <strong>{choice.label}</strong>
                  {choice.description && <span>{choice.description}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="workflow-human-review-form-grid">
          <div className="form-field">
            <label htmlFor="workflow-human-review-operator-id">Operator ID</label>
            <input
              id="workflow-human-review-operator-id"
              type="text"
              value={fields.operatorId}
              maxLength={100}
              disabled={saving}
              onChange={(event) =>
                updateField(setFields, setFieldErrors, setSubmitError, "operatorId", event.target.value)
              }
            />
            {fieldErrors.operatorId && <p className="form-error">{fieldErrors.operatorId}</p>}
          </div>

          <div className="form-field">
            <label htmlFor="workflow-human-review-operator-kind">Operator kind</label>
            <select
              id="workflow-human-review-operator-kind"
              value={fields.operatorKind}
              disabled={saving}
              onChange={(event) =>
                updateField(
                  setFields,
                  setFieldErrors,
                  setSubmitError,
                  "operatorKind",
                  event.target.value as FormState["operatorKind"],
                )
              }
            >
              <option value="agent">agent</option>
              <option value="model">model</option>
              <option value="human">human</option>
            </select>
            {fieldErrors.operatorKind && <p className="form-error">{fieldErrors.operatorKind}</p>}
          </div>

          <div className="form-field workflow-human-review-form-field--full">
            <label htmlFor="workflow-human-review-reason">Reason</label>
            <textarea
              id="workflow-human-review-reason"
              rows={3}
              value={fields.reason}
              maxLength={2048}
              disabled={saving}
              onChange={(event) =>
                updateField(setFields, setFieldErrors, setSubmitError, "reason", event.target.value)
              }
            />
            {fieldErrors.reason && <p className="form-error">{fieldErrors.reason}</p>}
          </div>

          <div className="form-field">
            <label htmlFor="workflow-human-review-required-capabilities">
              Required capabilities
            </label>
            <textarea
              id="workflow-human-review-required-capabilities"
              rows={2}
              value={fields.requiredCapabilitiesText}
              disabled={saving}
              onChange={(event) =>
                updateField(
                  setFields,
                  setFieldErrors,
                  setSubmitError,
                  "requiredCapabilitiesText",
                  event.target.value,
                )
              }
            />
            <p className="workflow-human-review-field-hint">Comma or newline separated.</p>
            {fieldErrors.requiredCapabilitiesText && (
              <p className="form-error">{fieldErrors.requiredCapabilitiesText}</p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="workflow-human-review-alternatives">Alternatives considered</label>
            <textarea
              id="workflow-human-review-alternatives"
              rows={2}
              value={fields.alternativesConsideredText}
              disabled={saving}
              onChange={(event) =>
                updateField(
                  setFields,
                  setFieldErrors,
                  setSubmitError,
                  "alternativesConsideredText",
                  event.target.value,
                )
              }
            />
            <p className="workflow-human-review-field-hint">Comma or newline separated.</p>
            {fieldErrors.alternativesConsideredText && (
              <p className="form-error">{fieldErrors.alternativesConsideredText}</p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="workflow-human-review-confidence">Confidence</label>
            <input
              id="workflow-human-review-confidence"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={fields.confidence}
              disabled={saving}
              onChange={(event) =>
                updateField(setFields, setFieldErrors, setSubmitError, "confidence", event.target.value)
              }
            />
            {fieldErrors.confidence && <p className="form-error">{fieldErrors.confidence}</p>}
          </div>

          <label className="workflow-human-review-checkbox">
            <input
              type="checkbox"
              checked={fields.requiresUserApproval}
              disabled={saving}
              onChange={(event) =>
                updateField(
                  setFields,
                  setFieldErrors,
                  setSubmitError,
                  "requiresUserApproval",
                  event.target.checked,
                )
              }
            />
            Requires user approval
          </label>
        </div>

        {submitError && (
          <p className="form-error workflow-human-review-submit-error" role="alert">
            {submitError}
          </p>
        )}

        <div className="workflow-human-review-actions">
          <button type="submit" className="goal-action-button" disabled={saving}>
            {saving ? "Submitting…" : "Submit review"}
          </button>
          <button
            type="button"
            className="goal-action-button goal-action-button--secondary"
            disabled={saving}
            onClick={() => {
              const choice = review.choices.find((item) => item.id === selectedChoiceId) ?? review.choices[0];
              setFields(formFieldsFromChoice(choice) ?? EMPTY_FIELDS);
              setFieldErrors({});
              setSubmitError(null);
            }}
          >
            Reset to choice defaults
          </button>
        </div>
      </form>
    </section>
  );
}

function formFieldsFromChoice(choice: HumanReviewPayload["choices"][number] | undefined): FormState | null {
  if (!choice) return null;
  const parsed = OperatorSelection.safeParse(choice.proposal.payload);
  if (!parsed.success) return null;
  return toFormState(parsed.data);
}

function toFormState(selection: OperatorSelectionData): FormState {
  return {
    operatorId: selection.operatorId,
    operatorKind: selection.operatorKind,
    reason: selection.reason,
    requiredCapabilitiesText: selection.requiredCapabilities.join(", "),
    alternativesConsideredText: selection.alternativesConsidered.join(", "),
    confidence: String(selection.confidence),
    requiresUserApproval: selection.requiresUserApproval,
  };
}

function parseListField(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function updateField<K extends keyof FormState>(
  setFields: Dispatch<SetStateAction<FormState>>,
  setFieldErrors: Dispatch<SetStateAction<FieldErrors>>,
  setSubmitError: Dispatch<SetStateAction<string | null>>,
  key: K,
  value: FormState[K],
): void {
  setFields((current) => ({ ...current, [key]: value }));
  setFieldErrors((current) => ({ ...current, [key]: undefined }));
  setSubmitError(null);
}

function mapSelectionErrors(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): {
  nextFieldErrors: FieldErrors;
  nextFormError: string | null;
} {
  const nextFieldErrors: FieldErrors = {};
  const formMessages: string[] = [];

  for (const issue of error.issues) {
    const field = issue.path[0];
    switch (field) {
      case "operatorId":
      case "operatorKind":
      case "reason":
      case "confidence":
        nextFieldErrors[field] ??= issue.message;
        break;
      case "requiredCapabilities":
        nextFieldErrors.requiredCapabilitiesText ??= issue.message;
        break;
      case "alternativesConsidered":
        nextFieldErrors.alternativesConsideredText ??= issue.message;
        break;
      case "requiresUserApproval":
        nextFieldErrors.requiresUserApproval ??= issue.message;
        break;
      default:
        formMessages.push(issue.message);
        break;
    }
  }

  return {
    nextFieldErrors,
    nextFormError: formMessages.length > 0 ? formMessages.join(" ") : "Fix the highlighted fields.",
  };
}

function parseReviewSummary(summary: string): {
  stepPurpose: string;
  failedTransports: string;
} {
  return {
    stepPurpose: summaryValue(summary, "Step purpose:") ?? "Not provided",
    failedTransports: summaryValue(summary, "Failed transports:") ?? "Not recorded",
  };
}

function summaryValue(summary: string, prefix: string): string | null {
  const line = summary
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  if (!line) return null;
  const value = line.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

function formatDecisionKind(kind: HumanReviewPayload["kind"]): string {
  return kind.replace(/_/g, " ");
}
