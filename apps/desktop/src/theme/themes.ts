// Theme registry — extensible via registerTheme(). Each theme is a flat map of
// CSS custom-property names to values. Themes are applied by setting
// `data-theme` and (optionally) `data-look` on <html>, which CSS selectors in
// theme.css read.

type ThemeMode = "dark" | "light";

type ThemeTokens = Readonly<Record<string, string>>;

export interface ThemeDefinition {
  id: string;
  label: string;
  mode: ThemeMode;
  tokens: ThemeTokens;
}

const operationalDark: ThemeDefinition = {
  id: "operational-dark",
  label: "Operational · Dark",
  mode: "dark",
  tokens: {
    "--bg": "#0B1020",
    "--panel": "#111827",
    "--panel-2": "#172033",
    "--raised": "#1E293B",
    "--overlay": "rgba(15, 23, 42, 0.85)",
    "--hairline": "rgba(255,255,255,0.06)",
    "--hairline-strong": "rgba(255,255,255,0.16)",
    "--text": "#E5EAF5",
    "--text-2": "rgba(245,245,245,0.82)",
    "--text-3": "rgba(229,234,245,0.46)",
    "--text-4": "rgba(229,234,245,0.24)",

    "--accent": "#5B8CFF",
    "--accent-hover": "#78A1FF",
    "--accent-active": "#3D73F5",
    "--accent-soft": "rgba(91,140,255,0.16)",
    "--accent-line": "rgba(91,140,255,0.40)",

    "--accent-2": "#8B5CF6",
    "--accent-2-soft": "rgba(139,92,246,0.16)",

    "--run": "#22C55E",
    "--run-soft": "rgba(34,197,94,0.16)",
    "--warn": "#F59E0B",
    "--warn-soft": "rgba(245,158,11,0.16)",
    "--err": "#EF4444",
    "--err-soft": "rgba(239,68,68,0.16)",
    "--info": "#38BDF8",
    "--info-soft": "rgba(56,189,248,0.16)",

    "--r-sm": "6px",
    "--r-md": "10px",
    "--r-lg": "14px",
    "--r-xl": "18px",

    "--shadow-sm": "0 1px 2px rgba(0,0,0,0.20)",
    "--shadow-md": "0 4px 12px rgba(0,0,0,0.24)",
    "--shadow-lg": "0 10px 24px rgba(0,0,0,0.32)",

    "--t-fast": "120ms",
    "--t-norm": "180ms",
    "--t-slow": "260ms",
    "--ease": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  },
};

const operationalLight: ThemeDefinition = {
  id: "operational-light",
  label: "Operational · Light",
  mode: "light",
  tokens: {
    ...operationalDark.tokens,
    "--bg": "#F4F6FA",
    "--panel": "#FFFFFF",
    "--panel-2": "#F8F9FC",
    "--raised": "#EFF2F8",
    "--hairline": "rgba(15,23,42,0.07)",
    "--hairline-strong": "rgba(15,23,42,0.14)",
    "--text": "#0F172A",
    "--text-2": "rgba(15,23,42,0.66)",
    "--text-3": "rgba(15,23,42,0.46)",
    "--text-4": "rgba(15,23,42,0.24)",
  },
};

const themes = new Map<string, ThemeDefinition>();

export function registerTheme(theme: ThemeDefinition): void {
  themes.set(theme.id, theme);
}

export function getTheme(id: string): ThemeDefinition | undefined {
  return themes.get(id);
}

export function listThemes(): ThemeDefinition[] {
  return Array.from(themes.values());
}

export function applyTheme(theme: ThemeDefinition, target: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(theme.tokens)) {
    target.style.setProperty(name, value);
  }
  target.dataset.theme = theme.id;
  target.dataset.themeMode = theme.mode;
}

export const DEFAULT_THEME_ID = operationalDark.id;

registerTheme(operationalDark);
registerTheme(operationalLight);
