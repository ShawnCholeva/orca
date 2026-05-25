import type { ReactNode } from "react";
import {
  WorkflowArtifactType,
  WorkflowStepGateType,
  type CreateWorkflowTemplateRequest,
} from "@orca/contracts";

export type WorkflowStepDraft = CreateWorkflowTemplateRequest["steps"][number];

interface StepEditorProps {
  step: WorkflowStepDraft;
  index: number;
  locked: boolean;
  onChange: (step: WorkflowStepDraft) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
}

const ARTIFACT_TYPES = WorkflowArtifactType.options;
const GATE_TYPES = WorkflowStepGateType.options;

export function StepEditor({
  step,
  index,
  locked,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: StepEditorProps) {
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
        <Field label="Gate Type">
          <select
            value={step.gateType}
            onChange={(event) => onChange({ ...step, gateType: event.target.value as WorkflowStepDraft["gateType"] })}
            disabled={locked}
          >
            {GATE_TYPES.map((gateType) => (
              <option key={gateType} value={gateType}>
                {gateType}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Purpose">
        <textarea
          value={step.purpose}
          onChange={(event) => onChange({ ...step, purpose: event.target.value })}
          disabled={locked}
          rows={3}
        />
      </Field>

      <div className="workflow-step-artifacts">
        <ArtifactSelector
          label="Required Inputs"
          selected={step.requiredInputs}
          disabled={locked}
          onToggle={(artifactType) =>
            onChange({
              ...step,
              requiredInputs: toggleArtifact(step.requiredInputs, artifactType),
            })}
        />
        <ArtifactSelector
          label="Required Outputs"
          selected={step.requiredOutputs}
          disabled={locked}
          onToggle={(artifactType) =>
            onChange({
              ...step,
              requiredOutputs: toggleArtifact(step.requiredOutputs, artifactType),
            })}
        />
      </div>

      <ArrayFieldEditor
        label="Recommended Capabilities"
        values={step.recommendedCapabilities}
        disabled={locked}
        addLabel="Add Capability"
        onChange={(recommendedCapabilities) => onChange({ ...step, recommendedCapabilities })}
      />
      <ArrayFieldEditor
        label="Validation Expectations"
        values={step.validationExpectations}
        disabled={locked}
        addLabel="Add Validation Expectation"
        onChange={(validationExpectations) => onChange({ ...step, validationExpectations })}
      />
      <ArrayFieldEditor
        label="Exit Criteria"
        values={step.exitCriteria}
        disabled={locked}
        addLabel="Add Exit Criterion"
        onChange={(exitCriteria) => onChange({ ...step, exitCriteria })}
      />
      <ArrayFieldEditor
        label="Recommended Operators"
        values={step.recommendedOperatorIds}
        disabled={locked}
        addLabel="Add Operator"
        onChange={(recommendedOperatorIds) => onChange({ ...step, recommendedOperatorIds })}
      />
    </article>
  );
}

function toggleArtifact(
  values: WorkflowStepDraft["requiredInputs"] | WorkflowStepDraft["requiredOutputs"],
  artifactType: (typeof ARTIFACT_TYPES)[number],
) {
  return values.includes(artifactType)
    ? values.filter((value) => value !== artifactType)
    : [...values, artifactType];
}

function ArtifactSelector({
  label,
  selected,
  disabled,
  onToggle,
}: {
  label: string;
  selected: WorkflowStepDraft["requiredInputs"] | WorkflowStepDraft["requiredOutputs"];
  disabled: boolean;
  onToggle: (artifactType: (typeof ARTIFACT_TYPES)[number]) => void;
}) {
  return (
    <fieldset className="workflow-artifact-selector" disabled={disabled}>
      <legend>{label}</legend>
      <div className="workflow-artifact-selector__grid">
        {ARTIFACT_TYPES.map((artifactType) => (
          <label key={artifactType} className="workflow-artifact-selector__option">
            <input
              type="checkbox"
              checked={selected.includes(artifactType)}
              onChange={() => onToggle(artifactType)}
              disabled={disabled}
            />
            <span>{artifactType}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ArrayFieldEditor({
  label,
  values,
  disabled,
  addLabel,
  onChange,
}: {
  label: string;
  values: string[];
  disabled: boolean;
  addLabel: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="workflow-array-field">
      <div className="workflow-array-field__header">
        <span>{label}</span>
        {!disabled && (
          <button
            type="button"
            className="workflow-quiet-btn"
            onClick={() => onChange([...values, ""])}
          >
            {addLabel}
          </button>
        )}
      </div>
      {values.length === 0 ? (
        <p className="workflow-array-field__empty">None configured.</p>
      ) : (
        <div className="workflow-array-field__items">
          {values.map((value, index) => (
            <div key={`${label}-${index}`} className="workflow-array-field__item">
              <input
                type="text"
                value={value}
                onChange={(event) => {
                  const next = values.slice();
                  next[index] = event.target.value;
                  onChange(next);
                }}
                disabled={disabled}
              />
              {!disabled && (
                <button
                  type="button"
                  className="workflow-danger-btn"
                  onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
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
