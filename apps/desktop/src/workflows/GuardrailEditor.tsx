import type { ReactNode } from "react";
import { GuardrailKind, type WorkflowGuardrailConfig } from "@orca/contracts";

export interface GuardrailDraft {
  id: string;
  kind: WorkflowGuardrailConfig["kind"];
  label: string;
  configText: string;
}

interface GuardrailEditorProps {
  guardrail: GuardrailDraft;
  locked: boolean;
  onChange: (guardrail: GuardrailDraft) => void;
  onRemove?: () => void;
}

const GUARDRAIL_KINDS = GuardrailKind.options;

export function GuardrailEditor({
  guardrail,
  locked,
  onChange,
  onRemove,
}: GuardrailEditorProps) {
  return (
    <article className="workflow-guardrail-card">
      <div className="workflow-guardrail-card__header">
        <div className="mono workflow-guardrail-card__id">{guardrail.id}</div>
        {!locked && onRemove && (
          <button type="button" className="workflow-danger-btn" onClick={onRemove}>
            Remove Guardrail
          </button>
        )}
      </div>
      <div className="workflow-field-grid">
        <Field label="Label">
          <input
            type="text"
            value={guardrail.label}
            onChange={(event) => onChange({ ...guardrail, label: event.target.value })}
            disabled={locked}
            maxLength={100}
          />
        </Field>
        <Field label="Kind">
          <select
            value={guardrail.kind}
            onChange={(event) => onChange({ ...guardrail, kind: event.target.value as GuardrailDraft["kind"] })}
            disabled={locked}
          >
            {GUARDRAIL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Config JSON">
        <textarea
          value={guardrail.configText}
          onChange={(event) => onChange({ ...guardrail, configText: event.target.value })}
          disabled={locked}
          rows={6}
          spellCheck={false}
        />
      </Field>
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
