import type { AdapterId, CatalogModel, ContextVariant, EffortLevel, NodeModelSelection } from "@orca/contracts";

interface Profile {
  id: string;
  displayName: string;
}

/**
 * A catalog row knows which adapter ships it. `GET /v1/model-catalog` returns
 * all three adapters, so a flattened list mixes claude/codex/antigravity models
 * — pinning one without its adapter emitted `{adapterId: "claude-code",
 * modelId: "gpt-5.5"}`, which validates (the two fields are checked
 * independently) and then fails at dispatch with "no ready agent".
 */
export interface CatalogEntry extends CatalogModel {
  adapterId: AdapterId;
}

export function ModelPicker({ value, catalog, profiles, onChange, disabled, idPrefix = "" }: {
  value: NodeModelSelection;
  catalog: CatalogEntry[];
  profiles: Profile[];
  onChange: (next: NodeModelSelection) => void;
  disabled?: boolean;
  // Distinguishes this picker's element ids when several are mounted at once
  // (one per step in the step editor). Empty by default so a lone picker
  // (e.g. in tests) keeps plain "model-select"/"effort-select" ids.
  idPrefix?: string;
}) {
  const isPinned = value.kind === "pinned";
  const model = isPinned
    ? catalog.find((m) => m.id === value.modelId && m.adapterId === value.adapterId)
    : undefined;
  const modelSelectId = `${idPrefix}model-select`;
  const effortSelectId = `${idPrefix}effort-select`;
  // An empty list means there is nothing valid to select — disable the
  // control rather than let the UI emit a choice that fails contract
  // validation (min(1) on modelId/ref) at save time with no context.
  const noModels = catalog.length === 0;
  const noProfiles = profiles.length === 0;

  // Option values carry the adapter so a selection can emit the adapter the
  // model actually belongs to; ids are only unique within an adapter.
  const groups = groupByFamily(catalog);

  return (
    <div className="model-picker">
      <div className="model-picker__modes">
        <label className="model-picker__mode">
          <input
            type="radio"
            name={`${idPrefix}model-kind`}
            checked={isPinned}
            disabled={disabled || noModels}
            onChange={() => {
              const first = catalog[0];
              onChange({
                kind: "pinned",
                adapterId: first?.adapterId ?? "claude-code",
                modelId: first?.id ?? "",
                contextVariant: "default",
                effort: first?.defaultEffort ?? null,
              });
            }}
          />
          Pinned model
        </label>
        <label className="model-picker__mode">
          <input
            type="radio"
            name={`${idPrefix}model-kind`}
            checked={!isPinned}
            disabled={disabled || noProfiles}
            onChange={() => onChange({ kind: "profile", ref: profiles[0]?.id ?? "" })}
          />
          Profile
        </label>
      </div>

      {noModels && (
        <p className="model-picker__note">
          No models available — check the Models section in Settings.
        </p>
      )}
      {noProfiles && (
        // Profiles are built in, not configurable — Settings' Models panel does
        // not list them and Refresh cannot bring them back. An empty list means
        // the daemon did not answer, so retrying the fetch is the only advice.
        <p className="model-picker__note">
          No profiles available — the model catalog did not load. Reopen this template to retry.
        </p>
      )}

      {isPinned ? (
        <>
          <div className="model-picker__field">
            <label htmlFor={modelSelectId}>Model</label>
            <select
              id={modelSelectId}
              value={`${value.adapterId}::${value.modelId}::${value.contextVariant}`}
              disabled={disabled || noModels}
              onChange={(e) => {
                const [adapterId, modelId, variant] = e.target.value.split("::") as [AdapterId, string, ContextVariant];
                const next = catalog.find((m) => m.id === modelId && m.adapterId === adapterId);
                onChange({
                  ...value,
                  adapterId,
                  modelId,
                  contextVariant: variant,
                  // A new model has its own supported levels; carrying the old
                  // effort across could name one this model rejects.
                  effort: next?.defaultEffort ?? null,
                });
              }}
            >
              {groups.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.rows.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          {model && model.supportedEfforts.length > 0 && (
            <div className="model-picker__field model-picker__field--narrow">
              <label htmlFor={effortSelectId}>Effort</label>
              <select
                id={effortSelectId}
                value={value.effort ?? model.defaultEffort ?? ""}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, effort: e.target.value as EffortLevel })}
              >
                {model.supportedEfforts.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
              </select>
            </div>
          )}
        </>
      ) : (
        <div className="model-picker__field">
          <select
            aria-label="Profile"
            value={value.ref}
            disabled={disabled || noProfiles}
            onChange={(e) => onChange({ kind: "profile", ref: e.target.value })}
          >
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

interface OptionGroup {
  key: string;
  label: string;
  rows: Array<{ key: string; label: string }>;
}

/**
 * One `<optgroup>` per family, in first-appearance order. Keyed by adapter too:
 * two adapters may ship the same family name, and merging them would put models
 * from different CLIs under one heading.
 */
function groupByFamily(catalog: CatalogEntry[]): OptionGroup[] {
  const groups: OptionGroup[] = [];
  const byKey = new Map<string, OptionGroup>();
  for (const m of catalog) {
    const key = `${m.adapterId}::${m.family}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: m.family || "Other", rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push({ key: `${m.adapterId}::${m.id}::default`, label: m.displayName });
    if (m.supports1mSuffix) {
      group.rows.push({ key: `${m.adapterId}::${m.id}::1m`, label: `${m.displayName} (1M context)` });
    }
  }
  return groups;
}
