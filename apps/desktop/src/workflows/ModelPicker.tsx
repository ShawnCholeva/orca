import type { CatalogModel, ContextVariant, EffortLevel, NodeModelSelection } from "@orca/contracts";

interface Profile {
  id: string;
  displayName: string;
}

export function ModelPicker({ value, catalog, profiles, onChange }: {
  value: NodeModelSelection;
  catalog: CatalogModel[];
  profiles: Profile[];
  onChange: (next: NodeModelSelection) => void;
}) {
  const isPinned = value.kind === "pinned";
  const model = isPinned ? catalog.find((m) => m.id === value.modelId) : undefined;

  const rows = catalog.flatMap((m) => [
    { key: `${m.id}::default`, label: m.displayName },
    ...(m.supports1mSuffix ? [{ key: `${m.id}::1m`, label: `${m.displayName} (1M context)` }] : []),
  ]);

  return (
    <div className="model-picker">
      <label>
        <input
          type="radio"
          name="model-kind"
          checked={isPinned}
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
      <label>
        <input
          type="radio"
          name="model-kind"
          checked={!isPinned}
          onChange={() => onChange({ kind: "profile", ref: profiles[0]?.id ?? "" })}
        />
        Profile
      </label>

      {isPinned ? (
        <>
          <label htmlFor="model-select">Model</label>
          <select
            id="model-select"
            value={`${value.modelId}::${value.contextVariant}`}
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
              <label htmlFor="effort-select">Effort</label>
              <select
                id="effort-select"
                value={value.effort ?? model.defaultEffort ?? ""}
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
          onChange={(e) => onChange({ kind: "profile", ref: e.target.value })}
        >
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
      )}
    </div>
  );
}
