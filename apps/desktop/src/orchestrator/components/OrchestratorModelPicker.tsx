import { useEffect, useState } from "react";
import type { ModelProviderInfo, OrchestratorModelChoice } from "@orca/contracts";

import { listModelProviders, toErrorMessage } from "../../api";

type Props = {
  value: OrchestratorModelChoice | null;
  onChange: (value: OrchestratorModelChoice | null) => void;
  disabled?: boolean;
};

export function OrchestratorModelPicker({ value, onChange, disabled = false }: Props) {
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listModelProviders()
      .then((rows) => {
        if (cancelled) return;
        setProviders(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(toErrorMessage(err, "Failed to load model providers."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const available = providers.filter((provider) => provider.available);

  if (loading) {
    return (
      <div className="form-field">
        <label>Orchestrator LLM</label>
        <p className="form-hint">Loading model providers…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="form-field">
        <label>Orchestrator LLM</label>
        <p className="form-error" role="alert">{error}</p>
      </div>
    );
  }

  if (available.length === 0) {
    return (
      <div className="form-field">
        <label>Orchestrator LLM</label>
        <p className="form-hint">
          No LLM providers configured. Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`.
        </p>
      </div>
    );
  }

  return (
    <div className="form-field orchestrator-model-picker">
      <label htmlFor="orchestrator-model-picker">Orchestrator LLM</label>
      <select
        id="orchestrator-model-picker"
        value={value ? `${value.providerId}:${value.modelId}` : ""}
        onChange={(event) => {
          const next = event.target.value;
          if (!next) {
            onChange(null);
            return;
          }
          const [providerId, modelId] = next.split(":") as [OrchestratorModelChoice["providerId"], string];
          onChange({ providerId, modelId });
        }}
        disabled={disabled}
      >
        <option value="">Choose…</option>
        {available.flatMap((provider) =>
          provider.models.map((model) => (
            <option
              key={`${provider.id}:${model.id}`}
              value={`${provider.id}:${model.id}`}
            >
              {provider.displayName} - {model.displayName}
            </option>
          )),
        )}
      </select>
      <p className="form-hint">Used for workflow orchestration decisions on this Goal.</p>
    </div>
  );
}
