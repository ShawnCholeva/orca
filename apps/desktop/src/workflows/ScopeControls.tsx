import type { WorkflowScope } from "@orca/contracts";

// ─── ScopeBadge ───────────────────────────────────────────────────────────────

interface ScopeBadgeProps {
  scope: WorkflowScope | null | undefined;
  scopeName?: string;
  size?: "xs" | "sm" | "md";
}

export function ScopeBadge({ scope, scopeName, size = "xs" }: ScopeBadgeProps) {
  if (!scope) return null;

  const sz =
    size === "xs"
      ? { h: 18, px: 6, fs: 10.5 }
      : size === "md"
        ? { h: 24, px: 9, fs: 12 }
        : { h: 20, px: 7, fs: 11 };

  if (scope === "global") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: sz.h,
          padding: `0 ${sz.px}px`,
          borderRadius: 999,
          background: "var(--info-soft)",
          color: "var(--info)",
          border: "1px solid transparent",
          fontSize: sz.fs,
          fontWeight: 500,
          letterSpacing: 0.1,
          whiteSpace: "nowrap",
          userSelect: "none",
        }}
      >
        global
      </span>
    );
  }

  const label = scope + (scopeName ? ` · ${scopeName}` : "");
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: sz.h,
        padding: `0 ${sz.px}px`,
        borderRadius: 999,
        background: "rgba(255,255,255,0.04)",
        color: "var(--text-2)",
        border: "1px solid var(--hairline)",
        fontSize: sz.fs,
        fontWeight: 500,
        letterSpacing: 0.1,
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
    >
      {label}
    </span>
  );
}

// ─── ScopeFilter ──────────────────────────────────────────────────────────────

type ScopeFilterValue = "all" | WorkflowScope;

interface ScopeFilterProps {
  value: ScopeFilterValue;
  setValue: (next: ScopeFilterValue) => void;
  counts?: Partial<Record<ScopeFilterValue, number>>;
}

const SCOPE_FILTER_OPTS: { id: ScopeFilterValue; label: string }[] = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "workspace", label: "Workspace" },
  { id: "goal", label: "Goal" },
];

export function ScopeFilter({ value, setValue, counts }: ScopeFilterProps) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {SCOPE_FILTER_OPTS.map((o) => {
        const active = value === o.id;
        const c = counts ? counts[o.id] : null;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => setValue(o.id)}
            style={{
              background: active ? "var(--accent-soft)" : "transparent",
              border: "1px solid " + (active ? "var(--accent-line)" : "var(--hairline)"),
              color: active ? "var(--accent)" : "var(--text-2)",
              padding: "4px 10px",
              borderRadius: 6,
              fontFamily: "inherit",
              fontSize: 11.5,
              fontWeight: 500,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {o.label}
            {c != null && (
              <span
                className="mono"
                style={{ fontSize: 10, color: active ? "var(--accent)" : "var(--text-4)" }}
              >
                {c}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── ScopePicker ─────────────────────────────────────────────────────────────

interface ScopePickerProps {
  scope: WorkflowScope;
  scopeName: string;
  onChange: (next: { scope: WorkflowScope; scopeName: string }) => void;
  goalOptions: string[];
}

const SCOPE_PICKER_OPTS: { id: WorkflowScope; label: string; desc: string }[] = [
  { id: "global", label: "Global", desc: "Available in every workspace and goal." },
  { id: "workspace", label: "Workspace", desc: "Available only inside one workspace." },
  { id: "goal", label: "Goal", desc: "Available only inside one specific goal." },
];

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg)",
  border: "1px solid var(--hairline)",
  borderRadius: 6,
  color: "var(--text)",
  fontFamily: "inherit",
  outline: "none",
  fontSize: 12,
  padding: "7px 10px",
  boxSizing: "border-box",
};

export function ScopePicker({ scope, scopeName, onChange, goalOptions }: ScopePickerProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {SCOPE_PICKER_OPTS.map((o) => {
        const active = scope === o.id;
        return (
          <div
            key={o.id}
            onClick={() => onChange({ scope: o.id, scopeName: o.id === "global" ? "" : scopeName })}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "10px 12px",
              background: active ? "var(--accent-soft)" : "var(--panel-2)",
              border: "1px solid " + (active ? "var(--accent-line)" : "var(--hairline)"),
              borderRadius: 7,
              cursor: "pointer",
            }}
          >
            {/* radio dot */}
            <span
              style={{
                marginTop: 2,
                width: 16,
                height: 16,
                borderRadius: "50%",
                border: "1px solid " + (active ? "var(--accent)" : "var(--hairline-strong)"),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {active && (
                <span
                  style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)" }}
                />
              )}
            </span>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{o.label}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.45 }}>{o.desc}</div>

              {active && o.id !== "global" && (
                <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                  {o.id === "goal" ? (
                    <select
                      value={scopeName ?? ""}
                      onChange={(e) => onChange({ scope: o.id, scopeName: e.target.value })}
                      style={inputStyle}
                    >
                      <option value="">Select goal…</option>
                      {goalOptions.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={scopeName ?? ""}
                      onChange={(e) => onChange({ scope: o.id, scopeName: e.target.value })}
                      placeholder="Workspace path…"
                      style={inputStyle}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
