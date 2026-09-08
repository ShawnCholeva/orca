interface AdapterCatalog {
  adapterId: string;
  adapterVersion: string | null;
  source: string;
  models: { id: string; displayName: string }[];
}

/**
 * The source line is the point of this panel: a catalog served from the seed or
 * from an old cache is still usable, but the user has to be able to see that it
 * is not what their installed CLI knows today. `adapterVersion` is the version
 * the served models came FROM, not necessarily the version installed right now
 * — never relabel it as "your installed version".
 */
const SOURCE_LABEL: Record<string, string> = {
  extracted: "Read from the installed CLI",
  cached: "Cached from an earlier read",
  seed: "Built-in fallback — the CLI could not be read",
};

const ADAPTER_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

export function ModelCatalogPanel({
  adapters,
  onRefresh,
  refreshing = false,
}: {
  adapters: AdapterCatalog[];
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  return (
    <section className="settings-catalog">
      <div className="settings-catalog-header">
        <div className="settings-section-label">Models</div>
        <button
          type="button"
          className="settings-agent-btn settings-agent-btn--add"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="settings-catalog-list">
        {adapters.map((a) => (
          <div key={a.adapterId} className="settings-catalog-adapter">
            <div className="settings-catalog-adapter-head">
              <span className="settings-catalog-adapter-name">
                {ADAPTER_LABEL[a.adapterId] ?? a.adapterId}
              </span>
              <span className="mono settings-catalog-adapter-count">
                {a.models.length} model{a.models.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="settings-catalog-adapter-source">
              {SOURCE_LABEL[a.source] ?? a.source}
              {a.adapterVersion ? ` (CLI v${a.adapterVersion})` : ""}
            </div>
            {a.models.length > 0 ? (
              <ul className="settings-catalog-model-list">
                {a.models.map((m) => (
                  <li key={m.id} className="settings-catalog-model">
                    {m.displayName}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="settings-catalog-empty">No models found for this adapter.</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
