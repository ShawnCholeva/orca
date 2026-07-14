// Small shared primitives for the Workspaces tab — ported from the design
// prototype's ui.jsx (Btn / Pill / Tip) plus a Field label-wrapper. Kept local
// to the feature; styling uses the app's existing token set.

import { useState, type ReactElement, type ReactNode, type CSSProperties } from "react";
import { Icon } from "./icons";

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

export interface MiniSelectOption {
  id: string;
  name: string;
  hint?: string;
}

interface MiniSelectProps {
  value: string | null;
  options: MiniSelectOption[];
  onChange: (id: string) => void;
  icon?: ReactElement<{ size?: number }>;
  placeholder?: string;
  disabled?: boolean;
}

export function MiniSelect({ value, options, onChange, icon, placeholder, disabled }: MiniSelectProps) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.id === value) ?? null;
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          width: "100%",
          padding: "9px 11px",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          textAlign: "left",
          fontFamily: "inherit",
          background: "var(--panel-2)",
          border: "1px solid " + (open ? "var(--accent-line)" : "var(--hairline)"),
          borderRadius: 8,
          transition: "border-color 100ms ease",
        }}
      >
        {icon && (
          <span
            style={{ flexShrink: 0, display: "inline-flex", color: cur ? "var(--accent)" : "var(--text-3)" }}
          >
            {icon}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: cur ? "var(--text)" : "var(--text-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {cur ? cur.name : placeholder ?? "Select…"}
          </span>
          {cur?.hint && <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>{cur.hint}</span>}
        </span>
        <Icon.chevronDown
          size={13}
          color="var(--text-3)"
          style={{
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 120ms ease",
          }}
        />
      </button>
      {open && (
        <>
          <div
            onClick={(e) => {
              // Field wraps this in a <label>; a plain-div click would bubble to
              // the label and re-fire the trigger button, reopening the dropdown.
              // Cancel the label's default activation so an outside click closes.
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 41,
              background: "var(--raised)",
              border: "1px solid var(--hairline-strong)",
              borderRadius: 10,
              boxShadow: "var(--shadow-lg)",
              overflow: "hidden",
              padding: 4,
              animation: "float-in 120ms ease",
            }}
          >
            {options.map((o) => {
              const on = o.id === value;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={(e) => {
                    // Same reason as the overlay: setOpen(false) detaches this
                    // node mid-click, and the wrapping <label> would then fire
                    // its associated control (the trigger), reopening the menu.
                    e.preventDefault();
                    e.stopPropagation();
                    onChange(o.id);
                    setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    width: "100%",
                    padding: "8px 9px",
                    borderRadius: 6,
                    cursor: "pointer",
                    background: on ? "var(--accent-soft)" : "transparent",
                    border: "none",
                    fontFamily: "inherit",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    if (!on) e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                  }}
                  onMouseLeave={(e) => {
                    if (!on) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      flexShrink: 0,
                      display: "inline-flex",
                      justifyContent: "center",
                      color: "var(--accent)",
                    }}
                  >
                    {on && <Icon.check size={12} />}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 12.5,
                        fontWeight: on ? 600 : 500,
                        color: on ? "var(--text)" : "var(--text-2)",
                      }}
                    >
                      {o.name}
                    </span>
                    {o.hint && (
                      <span style={{ display: "block", fontSize: 10.5, color: "var(--text-3)", marginTop: 1 }}>
                        {o.hint}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

function FieldLabelText({ label, hint }: { label: string; hint?: string }) {
  return (
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
  );
}

/** Label-wrapped field — use for a SINGLE control (implicit label association). */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <FieldLabelText label={label} hint={hint} />
      {children}
    </label>
  );
}

/**
 * Same layout as {@link Field} but a plain <div> — use for a GROUP of controls.
 * A <label> wrapping multiple/interactive controls mis-associates (its accessible
 * name absorbs the whole group, and clicks forward to the first control).
 */
export function FieldGroup({ label, hint, children }: FieldProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <FieldLabelText label={label} hint={hint} />
      {children}
    </div>
  );
}
