import type { CatalogModel, ContextVariant, EffortLevel, NodeModelSelection } from "@orca/contracts";

interface Profile {
  id: string;
  displayName: string;
}

export function ModelPicker({ value, catalog, profiles, onChange, disabled, idPrefix = "" }: {
  value: NodeModelSelection;
  catalog: CatalogModel[];
  profiles: Profile[];
  onChange: (next: NodeModelSelection) => void;
  disabled?: boolean;
  // Distinguishes this picker's element ids when several are mounted at once
  // (one per step in the step editor). Empty by default so a lone picker
  // (e.g. in tests) keeps plain "model-select"/"effort-select" ids.
  idPrefix?: string;
}) {
  const isPinned = value.kind === "pinned";
  const model = isPinned ? catalog.find((m) => m.id === value.modelId) : undefined;
  const modelSelectId = `${idPrefix}model-select`;
  const effortSelectId = `${idPrefix}effort-select`;
  // An empty list means there is nothing valid to select — disable the
  // control rather than let the UI emit a choice that fails contract
  // validation (min(1) on modelId/ref) at save time with no context.
  const noModels = catalog.length === 0;
  const noProfiles = profiles.length === 0;

  const rows = catalog.flatMap((m) => [
    { key: `${m.id}::default`, label: m.displayName },
    ...(m.supports1mSuffix ? [{ key: `${m.id}::1m`, label: `${m.displayName} (1M context)` }] : []),
  ]);

  return (
    <div className="model-picker">
      <label>
        <input
          type="radio"
          name={`${idPrefix}model-kind`}
          checked={isPinned}
          disabled={disabled || noModels}
          onChange={() => {
            const first = catalog[0];
            onChange({
              kind: "pinned",
              adapterId: "claude-code",
              modelId: first?.id ?? "",
              contextVariant: "default",
              effort: first?.defaultEffort ?? null,
            });
          }}
        />
        Pinned model
      </label>
      {noModels && (
        <p className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
          No models available — check the model catalog in Settings.
        </p>
      )}
      <label>
        <input
          type="radio"
          name={`${idPrefix}model-kind`}
          checked={!isPinned}
          disabled={disabled || noProfiles}
          onChange={() => onChange({ kind: "profile", ref: profiles[0]?.id ?? "" })}
        />
        Profile
      </label>
      {noProfiles && (
        <p className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>
          No profiles available — check the model catalog in Settings.
        </p>
      )}

      {isPinned ? (
        <>
          <label htmlFor={modelSelectId}>Model</label>
          <select
            id={modelSelectId}
            value={`${value.modelId}::${value.contextVariant}`}
            disabled={disabled || noModels}
            onChange={(e) => {
              const [modelId, variant] = e.target.value.split("::") as [string, ContextVariant];
              const next = catalog.find((m) => m.id === modelId);
              onChange({
                ...value,
                modelId,
                contextVariant: variant,
                // A new model has its own supported levels; carrying the old
                // effort across could name one this model rejects.
                effort: next?.defaultEffort ?? null,
              });
            }}
          >
            {rows.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>

          {model && model.supportedEfforts.length > 0 && (
            <>
              <label htmlFor={effortSelectId}>Effort</label>
              <select
                id={effortSelectId}
                value={value.effort ?? model.defaultEffort ?? ""}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, effort: e.target.value as EffortLevel })}
              >
                {model.supportedEfforts.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
              </select>
            </>
          )}
        </>
      ) : (
        <select
          aria-label="Profile"
          value={value.ref}
          disabled={disabled || noProfiles}
          onChange={(e) => onChange({ kind: "profile", ref: e.target.value })}
        >
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
      )}
    </div>
  );
}
