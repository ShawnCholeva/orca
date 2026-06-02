import type { ReactElement } from "react";
import orcaLogoDark from "../images/orca-logo-dark.png";
import orcaLogoLight from "../images/orca-logo-light.png";

export function glyphFor(id: string, color: string): ReactElement {
  switch (id) {
    case "claude-code":
      return (
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
          <rect x="2" y="2" width="28" height="28" rx="8" fill={color} opacity="0.18" />
          <path d="M11 10 L11 22 M11 16 L18 16 M18 10 L21 16 L18 22" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case "codex":
      return (
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
          <rect x="2" y="2" width="28" height="28" rx="8" fill={color} opacity="0.18" />
          <circle cx="16" cy="16" r="7" stroke={color} strokeWidth="1.8" fill="none" />
          <circle cx="16" cy="16" r="2.5" fill={color} />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
          <rect x="2" y="2" width="28" height="28" rx="8" fill={color} opacity="0.18" />
          <circle cx="16" cy="16" r="6" stroke={color} strokeWidth="1.8" fill="none" />
        </svg>
      );
  }
}

export function OrcaMark({ size = 18, mode = "dark" }: { size?: number; color?: string; mode?: "dark" | "light" }) {
  const src = mode === "light" ? orcaLogoDark : orcaLogoLight;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt="Orca"
      style={{ display: "block", flexShrink: 0, objectFit: "contain" }}
      draggable={false}
    />
  );
}

export function CheckIcon({ size = 13, color = "currentColor", strokeWidth = 2.2 }: { size?: number; color?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l4.5 4.5L19 7" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M13 5l7 7-7 7" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

export function XIcon({ size = 13, color = "currentColor", strokeWidth = 2.2 }: { size?: number; color?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function InfoIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01" />
      <path d="M11 12h1v5h1" />
    </svg>
  );
}
