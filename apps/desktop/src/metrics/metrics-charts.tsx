import { useId, type CSSProperties, type ReactElement, type ReactNode } from "react";

export function Panel({
  title,
  kicker,
  right,
  children,
  style,
  bodyStyle,
  bodyClassName,
}: {
  title?: string;
  kicker?: string;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  bodyClassName?: string;
}) {
  return (
    <section
      style={{
        background: "var(--panel)",
        border: "1px solid var(--hairline)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minHeight: 0,
        ...style,
      }}
    >
      {(title || right) && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderBottom: "1px solid var(--hairline)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
            {kicker && (
              <span className="mono" style={{ color: "var(--text-3)", fontSize: 10.5, letterSpacing: 1.2, textTransform: "uppercase" }}>
                {kicker}
              </span>
            )}
            {title && (
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", letterSpacing: -0.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {title}
              </h3>
            )}
          </div>
          {right && <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{right}</div>}
        </header>
      )}
      <div className={bodyClassName} style={{ flex: 1, minHeight: 0, ...bodyStyle }}>
        {children}
      </div>
    </section>
  );
}

export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      className="mono"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 10.5,
        letterSpacing: 1.4,
        textTransform: "uppercase",
        color: "var(--text-3)",
        fontWeight: 600,
        padding: "4px 0",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Sparkline({ data, color = "var(--text-2)", w = 76, h = 26 }: { data: number[]; color?: string; w?: number; h?: number }): ReactElement {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * (w - 2) + 1; // clamp divisor so a 1-point series renders a dot instead of NaN
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return [x, y] as const;
  });
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  const last = pts[pts.length - 1];
  const gid = useId().replace(/:/g, "");
  return (
    <svg width={w} height={h} style={{ display: "block", flexShrink: 0 }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.2" fill={color} />
    </svg>
  );
}

export function Delta({ value, good = "up", suffix = "", size = 11 }: { value: number | null; good?: "up" | "down"; suffix?: string; size?: number }): ReactElement {
  if (value === 0 || value == null) {
    return <span className="mono" style={{ fontSize: size, color: "var(--text-4)" }}>±0{suffix}</span>;
  }
  const up = value > 0;
  const isGood = (good === "up" && up) || (good === "down" && !up);
  const color = isGood ? "var(--run)" : "var(--err)";
  const arrow = up ? "▲" : "▼";
  return (
    <span className="mono" style={{ fontSize: size, color, display: "inline-flex", alignItems: "center", gap: 3 }}>
      <span style={{ fontSize: size - 3 }}>{arrow}</span>
      {`${up ? "+" : ""}${value}${suffix}`}
    </span>
  );
}

export function OutcomeBar({ passed, recovered, failed, height = 7 }: { passed: number; recovered: number; failed: number; height?: number }) {
  const total = passed + recovered + failed || 1;
  const seg = (n: number, c: string) =>
    n > 0 ? <div style={{ width: `${(n / total) * 100}%`, background: c, height: "100%" }} /> : null;
  return (
    <div style={{ display: "flex", width: "100%", height, borderRadius: 999, overflow: "hidden", background: "rgba(255,255,255,0.05)" }}>
      {seg(passed, "var(--run)")}
      {seg(recovered, "var(--warn)")}
      {seg(failed, "var(--err)")}
    </div>
  );
}

export function StatTile({
  label,
  value,
  unit,
  delta,
  deltaGood = "up",
  deltaSuffix = "",
  accent,
  spark,
  sparkColor,
  grade,
}: {
  label: string;
  value: number | string;
  unit?: string;
  delta?: number;
  deltaGood?: "up" | "down";
  deltaSuffix?: string;
  accent?: string;
  spark?: number[];
  sparkColor?: string;
  grade?: string;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: "var(--panel)", border: "1px solid var(--hairline)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="mono" style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: "var(--text-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        {delta !== undefined && <Delta value={delta} good={deltaGood} suffix={deltaSuffix} />}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.5, color: accent || "var(--text)", lineHeight: 1 }}>{value}</span>
          {unit && <span className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>{unit}</span>}
          {grade && (
            <span style={{ marginLeft: 4, fontSize: 12, fontWeight: 700, color: accent, border: `1px solid ${accent}`, borderRadius: 5, padding: "1px 6px", lineHeight: 1.3 }}>{grade}</span>
          )}
        </div>
        {spark && <Sparkline data={spark} color={sparkColor || "var(--text-3)"} w={64} h={24} />}
      </div>
    </div>
  );
}
