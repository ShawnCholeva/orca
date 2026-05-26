import { useEffect, useState } from "react";
import type { ModelProviderInfo, OrchestratorModelChoice } from "@orca/contracts";

import { listModelProviders, toErrorMessage } from "../../api";

type Props = {
  value: OrchestratorModelChoice | null;
  onChange: (value: OrchestratorModelChoice | null) => void;
  disabled?: boolean;
};

const PROVIDER_LABELS: Record<string, string> = {
  "orca/openai": "OpenAI",
  "orca/anthropic": "Claude",
  "orca/google-gemini": "Gemini",
};

function providerLabel(provider: ModelProviderInfo): string {
  return PROVIDER_LABELS[provider.id] ?? provider.displayName;
}

function providerReadinessReason(provider: ModelProviderInfo): string | null {
  const reason = provider.reason?.trim();
  return reason ? reason : null;
}

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
  const selectableProviders = providers.filter((provider) => provider.models.length > 0);
  const hasAutomatedProvider = selectableProviders.some((provider) => providerReadinessReason(provider) === null);

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

  if (selectableProviders.length === 0) {
    return (
      <div className="form-field orchestrator-model-picker">
        <label>Orchestrator LLM</label>
        <div className="orchestrator-provider-empty-state" role="status">
          <p className="form-hint">
            Automated orchestration can use a signed-in local CLI or explicit SDK configuration.
          </p>
          <p className="form-hint">
            If no automated transport is healthy, this Goal can still proceed with human-reviewed orchestration.
          </p>
        </div>
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
        {selectableProviders.flatMap((provider) =>
          provider.models.map((model) => (
            <option
              key={`${provider.id}:${model.id}`}
              value={`${provider.id}:${model.id}`}
            >
              {providerLabel(provider)} - {model.displayName}
            </option>
          )),
        )}
      </select>
      <p className="form-hint">Used for workflow orchestration decisions on this Goal.</p>
      <div className="orchestrator-provider-readiness" aria-label="Provider readiness">
        {selectableProviders.map((provider) => {
          const reason = providerReadinessReason(provider);
          const ready = reason === null;
          return (
            <div key={provider.id} className="orchestrator-provider-readiness-row">
              <div className="orchestrator-provider-readiness-head">
                <span className="orchestrator-provider-name">{providerLabel(provider)}</span>
                <span
                  className={`orchestrator-provider-badge ${ready ? "orchestrator-provider-badge--ready" : "orchestrator-provider-badge--setup"}`}
                >
                  {ready ? "Automated ready" : "Needs setup"}
                </span>
              </div>
              <p className="form-hint">
                {ready
                  ? "Signed-in CLI or SDK access is ready for automated orchestration."
                  : reason}
              </p>
            </div>
          );
        })}
      </div>
      {!hasAutomatedProvider ? (
        <div className="orchestrator-provider-empty-state" role="status">
          <p className="form-hint">
            Automated orchestration can use a signed-in local CLI or explicit SDK configuration.
          </p>
          <p className="form-hint">
            If no automated transport is healthy, this Goal can still proceed with human-reviewed orchestration.
          </p>
        </div>
      ) : null}
    </div>
  );
}
