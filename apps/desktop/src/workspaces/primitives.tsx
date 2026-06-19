// Small shared primitives for the Workspaces tab — ported from the design
// prototype's ui.jsx (Btn / Pill / Tip) plus a Field label-wrapper. Kept local
// to the feature; styling uses the app's existing token set.

import { useState, type ReactElement, type ReactNode, type CSSProperties } from "react";

export const inputStyle: CSSProperties = {
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

type BtnKind = "ghost" | "quiet" | "primary" | "danger";
type BtnSize = "xs" | "sm" | "md";

interface BtnProps {
  kind?: BtnKind;
  size?: BtnSize;
  children?: ReactNode;
  icon?: ReactElement<{ size?: number }>;
  onClick?: () => void;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
}

export function Btn({
  kind = "ghost",
  size = "sm",
  children,
  icon,
  onClick,
  title,
  active,
  disabled,
  type = "button",
}: BtnProps) {
  const sz =
    size === "xs"
      ? { h: 22, px: 8, fs: 11.5, gap: 5 }
      : size === "md"
        ? { h: 32, px: 12, fs: 13, gap: 7 }
        : { h: 26, px: 10, fs: 12, gap: 6 };
  const kinds: Record<BtnKind, { bg: string; fg: string; bd: string; hoverBg: string }> = {
    ghost: { bg: "transparent", fg: "var(--text-2)", bd: "1px solid transparent", hoverBg: "rgba(255,255,255,0.05)" },
    quiet: { bg: "rgba(255,255,255,0.04)", fg: "var(--text)", bd: "1px solid var(--hairline)", hoverBg: "rgba(255,255,255,0.07)" },
    primary: { bg: "var(--accent)", fg: "#FFFFFF", bd: "1px solid transparent", hoverBg: "var(--accent-hover, #78A1FF)" },
    danger: { bg: "var(--err-soft)", fg: "var(--err)", bd: "1px solid transparent", hoverBg: "rgba(239,68,68,0.22)" },
  };
  const k = kinds[kind];
  const [hover, setHover] = useState(false);
  const iconOnly = Boolean(icon) && !children;
  return (
    <button
      type={type}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: sz.gap,
        height: sz.h,
        padding: iconOnly ? 0 : `0 ${sz.px}px`,
        minWidth: iconOnly ? sz.h : undefined,
        background: active ? "rgba(255,255,255,0.08)" : hover && !disabled ? k.hoverBg : k.bg,
        color: k.fg,
        border: k.bd,
        borderRadius: 7,
        fontFamily: "inherit",
        fontSize: sz.fs,
        fontWeight: 500,
        letterSpacing: 0.1,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
        transition: "background 120ms ease, color 120ms ease",
      }}
    >
      {icon}
      {children}
    </button>
  );
}

type PillTone = "neutral" | "run" | "warn" | "err" | "info" | "accent";
type PillSize = "xs" | "sm" | "md";

interface PillProps {
  tone?: PillTone;
  size?: PillSize;
  children?: ReactNode;
  dot?: boolean;
}

export function Pill({ tone = "neutral", size = "sm", children, dot = false }: PillProps) {
  const tones: Record<PillTone, { bg: string; fg: string; bd: string }> = {
    neutral: { bg: "rgba(255,255,255,0.04)", fg: "var(--text-2)", bd: "var(--hairline)" },
    run: { bg: "var(--run-soft)", fg: "var(--run)", bd: "transparent" },
    warn: { bg: "var(--warn-soft)", fg: "var(--warn)", bd: "transparent" },
    err: { bg: "var(--err-soft)", fg: "var(--err)", bd: "transparent" },
    info: { bg: "var(--info-soft)", fg: "var(--info)", bd: "transparent" },
    accent: { bg: "var(--accent-soft)", fg: "var(--accent)", bd: "transparent" },
  };
  const t = tones[tone];
  const sz =
    size === "xs"
      ? { h: 18, px: 6, fs: 10.5, gap: 4, dotS: 5 }
      : size === "md"
        ? { h: 24, px: 9, fs: 12, gap: 6, dotS: 6 }
        : { h: 20, px: 7, fs: 11, gap: 5, dotS: 6 };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: sz.gap,
        height: sz.h,
        padding: `0 ${sz.px}px`,
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.bd}`,
        fontSize: sz.fs,
        fontWeight: 500,
        letterSpacing: 0.1,
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
    >
      {dot && (
        <span
          style={{
            width: sz.dotS,
            height: sz.dotS,
            borderRadius: "50%",
            background: t.fg,
            boxShadow: tone === "run" ? `0 0 0 3px ${t.bg}` : "none",
            animation: tone === "run" ? "pulse-dot 1.8s ease-in-out infinite" : "none",
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </span>
  );
}

interface TipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}

export function Tip({ label, children, side = "bottom" }: TipProps) {
  const [show, setShow] = useState(false);
  const offset = 6;
  const placement: CSSProperties =
    side === "top"
      ? { bottom: "100%", left: "50%", transform: `translate(-50%, -${offset}px)` }
      : side === "bottom"
        ? { top: "100%", left: "50%", transform: `translate(-50%, ${offset}px)` }
        : side === "right"
          ? { left: "100%", top: "50%", transform: `translate(${offset}px, -50%)` }
          : { right: "100%", top: "50%", transform: `translate(-${offset}px, -50%)` };
  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onMouseDown={() => setShow(false)}
    >
      {children}
      {show && (
        <span
          style={{
            position: "absolute",
            ...placement,
            zIndex: 100,
            background: "var(--raised)",
            color: "var(--text)",
            border: "1px solid var(--hairline-strong)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 11,
            fontWeight: 500,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            animation: "float-in 120ms ease",
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        className="mono"
        style={{ fontSize: 10, color: "var(--text-3)", letterSpacing: 1, textTransform: "uppercase" }}
      >
        {label}
        {hint && (
          <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-4)" }}>
            {" · "}
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}
