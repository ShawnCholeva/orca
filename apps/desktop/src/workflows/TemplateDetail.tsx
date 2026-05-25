import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CreateWorkflowTemplateRequest,
  type CreateWorkflowTemplateRequest as CreateWorkflowTemplateInput,
  type WorkflowTemplate,
} from "@orca/contracts";
import { toErrorMessage } from "../api";
import { duplicateTemplate, saveTemplate } from "./api";
import { GuardrailEditor, type GuardrailDraft } from "./GuardrailEditor";
import { StepEditor, type WorkflowStepDraft } from "./StepEditor";

interface TemplateDetailProps {
  template: WorkflowTemplate;
  onTemplateSaved: (template: WorkflowTemplate) => void;
  onTemplateDuplicated: (template: WorkflowTemplate) => void;
}

interface TemplateDraft {
  name: string;
  description: string;
  steps: WorkflowStepDraft[];
  guardrails: GuardrailDraft[];
}

export function TemplateDetail({
  template,
  onTemplateSaved,
  onTemplateDuplicated,
}: TemplateDetailProps) {
  const locked = template.isBuiltIn || template.isLocked;
  const [draft, setDraft] = useState<TemplateDraft>(() => toDraft(template));
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(toDraft(template));
    setError(null);
    setSaving(false);
    setDuplicating(false);
  }, [template]);

  const guardrailCountLabel = useMemo(
    () => `${draft.guardrails.length} guardrail${draft.guardrails.length === 1 ? "" : "s"}`,
    [draft.guardrails.length],
  );

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveTemplate(template.id, buildTemplateInput(draft));
      onTemplateSaved(saved);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to save workflow template."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate() {
    setDuplicating(true);
    setError(null);
    try {
      const duplicated = await duplicateTemplate(template.id, buildDuplicateName(template.name));
      onTemplateDuplicated(duplicated);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to duplicate workflow template."));
    } finally {
      setDuplicating(false);
    }
  }

  return (
    <section className="workflow-detail-panel" aria-label="Workflow template detail">
      <div className="workflow-detail-panel__header">
        <div>
          <div className="workflow-detail-panel__eyebrow mono">
            {locked ? "Built-in Workflow" : "Custom Workflow"}
          </div>
          <h2 className="workflow-detail-panel__title">{draft.name || template.name}</h2>
          <p className="workflow-detail-panel__meta">
            Version {template.version} · {draft.steps.length} steps · {guardrailCountLabel}
          </p>
        </div>
        <div className="workflow-detail-panel__actions">
          <button
            type="button"
            className="workflow-primary-btn"
            onClick={handleDuplicate}
            disabled={duplicating || saving}
          >
            {duplicating ? "Duplicating…" : "Duplicate to Custom"}
          </button>
          {!locked && (
            <button
              type="button"
              className="workflow-primary-btn workflow-primary-btn--secondary"
              onClick={handleSave}
              disabled={saving || duplicating}
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          )}
        </div>
      </div>

      {error && <div className="workflow-error-banner">{error}</div>}

      <div className="workflow-field-grid">
        <Field label="Template Name">
          <input
            type="text"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            disabled={locked}
            maxLength={100}
          />
        </Field>
      </div>

      <Field label="Description">
        <textarea
          value={draft.description}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
          disabled={locked}
          rows={4}
        />
      </Field>

      <div className="workflow-section">
        <div className="workflow-section__header">
          <h3>Steps</h3>
          {!locked && (
            <button
              type="button"
              className="workflow-quiet-btn"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  steps: [...current.steps, createStepDraft(current.steps)],
                }))}
            >
              Add Step
            </button>
          )}
        </div>
        <div className="workflow-stack">
          {draft.steps.map((step, index) => (
            <StepEditor
              key={step.id}
              step={step}
              index={index}
              locked={locked}
              onChange={(nextStep) =>
                setDraft((current) => ({
                  ...current,
                  steps: current.steps.map((entry, entryIndex) =>
                    entryIndex === index ? nextStep : entry,
                  ),
                }))}
              onMoveUp={
                index > 0
                  ? () =>
                      setDraft((current) => ({
                        ...current,
                        steps: moveItem(current.steps, index, index - 1),
                      }))
                  : undefined
              }
              onMoveDown={
                index < draft.steps.length - 1
                  ? () =>
                      setDraft((current) => ({
                        ...current,
                        steps: moveItem(current.steps, index, index + 1),
                      }))
                  : undefined
              }
              onRemove={() =>
                setDraft((current) => ({
                  ...current,
                  steps: current.steps.filter((_, entryIndex) => entryIndex !== index),
                }))}
            />
          ))}
        </div>
      </div>

      <div className="workflow-section">
        <div className="workflow-section__header">
          <h3>Guardrails</h3>
          {!locked && (
            <button
              type="button"
              className="workflow-quiet-btn"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  guardrails: [...current.guardrails, createGuardrailDraft(current.guardrails)],
                }))}
            >
              Add Guardrail
            </button>
          )}
        </div>
        <div className="workflow-stack">
          {draft.guardrails.length === 0 ? (
            <p className="workflow-section__empty">No guardrails configured.</p>
          ) : (
            draft.guardrails.map((guardrail, index) => (
              <GuardrailEditor
                key={guardrail.id}
                guardrail={guardrail}
                locked={locked}
                onChange={(nextGuardrail) =>
                  setDraft((current) => ({
                    ...current,
                    guardrails: current.guardrails.map((entry, entryIndex) =>
                      entryIndex === index ? nextGuardrail : entry,
                    ),
                  }))}
                onRemove={() =>
                  setDraft((current) => ({
                    ...current,
                    guardrails: current.guardrails.filter((_, entryIndex) => entryIndex !== index),
                  }))}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function toDraft(template: WorkflowTemplate): TemplateDraft {
  return {
    name: template.name,
    description: template.description,
    steps: template.steps.map((step) => ({ ...step })),
    guardrails: template.guardrails.map((guardrail) => ({
      id: guardrail.id,
      kind: guardrail.kind,
      label: guardrail.label,
      configText: JSON.stringify(guardrail.configJson, null, 2),
    })),
  };
}

function buildTemplateInput(draft: TemplateDraft): CreateWorkflowTemplateInput {
  const parsed = CreateWorkflowTemplateRequest.safeParse({
    name: draft.name.trim(),
    description: draft.description.trim(),
    steps: draft.steps.map((step, index) => ({
      id: step.id,
      ordinal: index,
      name: step.name.trim(),
      purpose: step.purpose.trim(),
      requiredInputs: step.requiredInputs,
      requiredOutputs: step.requiredOutputs,
      gateType: step.gateType,
      recommendedCapabilities: normalizeTextList(step.recommendedCapabilities),
      validationExpectations: normalizeTextList(step.validationExpectations),
      exitCriteria: normalizeTextList(step.exitCriteria),
      recommendedOperatorIds: normalizeTextList(step.recommendedOperatorIds),
    })),
    guardrails: draft.guardrails.map((guardrail) => ({
      id: guardrail.id,
      kind: guardrail.kind,
      label: guardrail.label.trim(),
      configJson: parseJson(guardrail.configText, `Invalid JSON for guardrail "${guardrail.id}"`),
    })),
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Workflow template validation failed.");
  }
  return parsed.data;
}

function buildDuplicateName(name: string): string {
  return name.endsWith(" Copy") ? `${name} 2` : `${name} Copy`;
}

function normalizeTextList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function parseJson(value: string, fallbackMessage: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(fallbackMessage);
  }
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function createStepDraft(steps: WorkflowStepDraft[]): WorkflowStepDraft {
  const numericSuffixes = steps
    .map((step) => /^step-(\d+)$/.exec(step.id)?.[1])
    .map((value) => Number(value ?? "0"));
  const nextIndex = (numericSuffixes.length === 0 ? 0 : Math.max(...numericSuffixes)) + 1;
  return {
    id: `step-${nextIndex}`,
    ordinal: steps.length,
    name: `Step ${nextIndex}`,
    purpose: "",
    requiredInputs: [],
    requiredOutputs: [],
    gateType: "human-approval",
    recommendedCapabilities: [],
    validationExpectations: [],
    exitCriteria: [],
    recommendedOperatorIds: [],
  };
}

function createGuardrailDraft(guardrails: GuardrailDraft[]): GuardrailDraft {
  const numericSuffixes = guardrails
    .map((guardrail) => /^guardrail-(\d+)$/.exec(guardrail.id)?.[1])
    .map((value) => Number(value ?? "0"));
  const nextIndex = (numericSuffixes.length === 0 ? 0 : Math.max(...numericSuffixes)) + 1;
  return {
    id: `guardrail-${nextIndex}`,
    kind: "approval_required",
    label: `Guardrail ${nextIndex}`,
    configText: JSON.stringify({}, null, 2),
  };
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
