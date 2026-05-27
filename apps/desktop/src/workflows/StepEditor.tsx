import type { ReactNode } from "react";
import {
  type CreateWorkflowTemplateRequest,
  type WorkflowStepOutputSchema,
  type WorkflowStepOutputField,
} from "@orca/contracts";

export type WorkflowStepDraft = CreateWorkflowTemplateRequest["steps"][number];

type FieldType = WorkflowStepOutputField["type"];
type ItemType = NonNullable<WorkflowStepOutputField["itemType"]>;

const FIELD_TYPES: FieldType[] = ["string", "number", "boolean", "array", "object"];
const ITEM_TYPES: ItemType[] = ["string", "number", "boolean", "object"];

interface StepEditorProps {
  step: WorkflowStepDraft;
  index: number;
  locked: boolean;
  onChange: (step: WorkflowStepDraft) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
}

export function StepEditor({
  step,
  index,
  locked,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: StepEditorProps) {
  function updateSchema(updater: (schema: WorkflowStepOutputSchema) => WorkflowStepOutputSchema) {
    onChange({ ...step, outputSchema: updater(step.outputSchema) });
  }

  function handleFieldChange(fieldIndex: number, patch: Partial<WorkflowStepOutputField>) {
    updateSchema((schema) =>
      schema.map((field, i) => (i === fieldIndex ? { ...field, ...patch } : field)),
    );
  }

  function handleAddField() {
    updateSchema((schema) => [
      ...schema,
      { key: "field", type: "string" as FieldType, required: true },
    ]);
  }

  function handleRemoveField(fieldIndex: number) {
    if (step.outputSchema.length <= 1) return;
    updateSchema((schema) => schema.filter((_, i) => i !== fieldIndex));
  }

  return (
    <article className="workflow-step-card">
      <div className="workflow-step-card__header">
        <div>
          <div className="workflow-step-card__ordinal">Step {index + 1}</div>
          <div className="mono workflow-step-card__id">{step.id}</div>
        </div>
        {!locked && (
          <div className="workflow-step-card__actions">
            <button type="button" className="workflow-quiet-btn" onClick={onMoveUp} disabled={!onMoveUp}>
              Move Up
            </button>
            <button type="button" className="workflow-quiet-btn" onClick={onMoveDown} disabled={!onMoveDown}>
              Move Down
            </button>
            <button type="button" className="workflow-danger-btn" onClick={onRemove}>
              Remove Step
            </button>
          </div>
        )}
      </div>

      <div className="workflow-field-grid">
        <Field label={`Step ${index + 1} Name`}>
          <input
            type="text"
            value={step.name}
            onChange={(event) => onChange({ ...step, name: event.target.value })}
            disabled={locked}
            maxLength={100}
          />
        </Field>
      </div>

      <Field label="Instructions">
        <textarea
          value={step.instructions}
          onChange={(event) => onChange({ ...step, instructions: event.target.value })}
          disabled={locked}
          rows={5}
        />
      </Field>

      <div className="workflow-array-field">
        <div className="workflow-array-field__header">
          <span>Output Schema</span>
          {!locked && (
            <button
              type="button"
              className="workflow-quiet-btn"
              onClick={handleAddField}
              disabled={step.outputSchema.length >= 32}
            >
              Add field
            </button>
          )}
        </div>
        <div className="workflow-array-field__items">
          {step.outputSchema.map((field, fieldIndex) => (
            <div key={fieldIndex} className="workflow-schema-field workflow-array-field__item">
              <input
                type="text"
                aria-label={`Field ${fieldIndex + 1} key`}
                value={field.key}
                onChange={(event) => handleFieldChange(fieldIndex, { key: event.target.value })}
                disabled={locked}
                placeholder="key"
              />
              <select
                aria-label={`Field ${fieldIndex + 1} type`}
                value={field.type}
                onChange={(event) => {
                  const nextType = event.target.value as FieldType;
                  const patch: Partial<WorkflowStepOutputField> = { type: nextType };
                  if (nextType !== "array") {
                    patch.itemType = undefined;
                  }
                  handleFieldChange(fieldIndex, patch);
                }}
                disabled={locked}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <label className="workflow-schema-field__required">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(event) => handleFieldChange(fieldIndex, { required: event.target.checked })}
                  disabled={locked}
                />
                required
              </label>
              <input
                type="text"
                aria-label={`Field ${fieldIndex + 1} description`}
                value={field.description ?? ""}
                onChange={(event) =>
                  handleFieldChange(fieldIndex, {
                    description: event.target.value || undefined,
                  })
                }
                disabled={locked}
                placeholder="description (optional)"
              />
              {field.type === "array" && (
                <select
                  aria-label={`Field ${fieldIndex + 1} item type`}
                  value={field.itemType ?? ""}
                  onChange={(event) =>
                    handleFieldChange(fieldIndex, {
                      itemType: (event.target.value as ItemType) || undefined,
                    })
                  }
                  disabled={locked}
                >
                  <option value="">item type (optional)</option>
                  {ITEM_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              )}
              {!locked && (
                <button
                  type="button"
                  className="workflow-danger-btn"
                  onClick={() => handleRemoveField(fieldIndex)}
                  disabled={step.outputSchema.length <= 1}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="workflow-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
