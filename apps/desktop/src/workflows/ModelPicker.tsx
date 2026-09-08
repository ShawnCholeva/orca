import type { Agent, AdapterId, CatalogModel, ContextVariant, EffortLevel, NodeModelSelection } from "@orca/contracts";

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

interface ProviderOption {
  id: AdapterId;
  label: string;
  unavailable: boolean;
}

export function ModelPicker({ value, catalog, profiles, agents, onChange, disabled, idPrefix = "" }: {
  value: NodeModelSelection;
  catalog: CatalogEntry[];
  profiles: Profile[];
  agents: Agent[];
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
  const providerSelectId = `${idPrefix}provider-select`;
  const modelSelectId = `${idPrefix}model-select`;
  const effortSelectId = `${idPrefix}effort-select`;
  const noProfiles = profiles.length === 0;

  // Providers offered are the agents the user has actually connected
  // (Settings → Manage Agents) that also ship at least one catalog model,
  // ordered the same way Manage Agents orders them.
  const connectedProviders = agents
    .filter((a) => a.connected && catalog.some((m) => m.adapterId === a.id))
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // No agent connected at all — distinct from "connected but modelless",
  // which the per-provider empty-model guard below already covers.
  const noProviders = agents.filter((a) => a.connected).length === 0;

  const currentAdapterId = isPinned ? value.adapterId : undefined;
  const currentProviderConnected = currentAdapterId != null
    ? connectedProviders.some((p) => p.id === currentAdapterId)
    : true;

  // A pinned choice whose provider was since disconnected (or removed from
  // Settings) is kept visible, not silently rewritten — opening a template
  // must never quietly change what it saves. It's appended as an extra,
  // clearly-unavailable option so the Provider select still shows the truth.
  const currentAgent = currentAdapterId != null ? agents.find((a) => a.id === currentAdapterId) : undefined;
  const showUnavailableProvider = isPinned && currentAdapterId != null && !currentProviderConnected;

  const providerOptions: ProviderOption[] = [
    ...connectedProviders.map((a) => ({ id: a.id as AdapterId, label: a.name, unavailable: false })),
    ...(showUnavailableProvider
      ? [{
          id: currentAdapterId as AdapterId,
          label: `${currentAgent?.name ?? currentAdapterId} (not connected)`,
          unavailable: true,
        }]
      : []),
  ];

  const selectedProviderId = currentAdapterId ?? (connectedProviders[0]?.id as AdapterId | undefined);
  const modelsForProvider = selectedProviderId
    ? catalog.filter((m) => m.adapterId === selectedProviderId)
    : [];

  // An empty list for the selected provider means there is nothing valid to
  // select — disable the control rather than let the UI emit a choice that
  // fails contract validation (min(1) on modelId/ref) at save time with no context.
  const noModels = modelsForProvider.length === 0;

  // Option values carry the adapter so a selection can emit the adapter the
  // model actually belongs to; ids are only unique within an adapter.
  const groups = groupByFamily(modelsForProvider);

  function pinFirstOf(adapterId: AdapterId, models: CatalogEntry[]): NodeModelSelection {
    const first = models[0];
    return {
      kind: "pinned",
      adapterId,
      modelId: first?.id ?? "",
      contextVariant: "default",
      effort: first?.defaultEffort ?? null,
    };
  }

  return (
    <div className="model-picker">
      <div className="model-picker__modes">
        <label className="model-picker__mode">
          <input
            type="radio"
            name={`${idPrefix}model-kind`}
            checked={isPinned}
            disabled={disabled || noProviders || noModels}
            onChange={() => {
              const adapterId = selectedProviderId ?? "claude-code";
              onChange(pinFirstOf(adapterId, modelsForProvider));
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

      {noProviders && (
        <p className="model-picker__note">
          No agents are connected — enable one in Settings → Manage Agents.
        </p>
      )}
      {!noProviders && noModels && (
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
            <label htmlFor={providerSelectId}>Provider</label>
            <select
              id={providerSelectId}
              value={currentAdapterId ?? ""}
              disabled={disabled || noProviders}
              onChange={(e) => {
                const adapterId = e.target.value as AdapterId;
                const models = catalog.filter((m) => m.adapterId === adapterId);
                onChange(pinFirstOf(adapterId, models));
              }}
            >
              {providerOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          {showUnavailableProvider && !noProviders && (
            // Skipped when noProviders is also true — the broader "no agents
            // connected" note above already explains why nothing will dispatch.
            <p className="model-picker__note model-picker__note--warn">
              This step won't dispatch until {currentAgent?.name ?? currentAdapterId} is enabled in
              Settings, or another provider is chosen.
            </p>
          )}

          <div className="model-picker__field">
            <label htmlFor={modelSelectId}>Model</label>
            <select
              id={modelSelectId}
              value={`${value.adapterId}::${value.modelId}::${value.contextVariant}`}
              disabled={disabled || noProviders || noModels}
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
