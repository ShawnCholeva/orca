import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_THEME_ID,
  applyTheme,
  getTheme,
  listThemes,
  type ThemeDefinition,
} from "./themes";

interface ThemeContextValue {
  theme: ThemeDefinition;
  setThemeById: (id: string) => void;
  themes: ThemeDefinition[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "orca.themeId";

function readStoredThemeId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredThemeId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore — storage unavailable
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const initial = useMemo<ThemeDefinition>(() => {
    const stored = readStoredThemeId();
    return (stored && getTheme(stored)) || getTheme(DEFAULT_THEME_ID)!;
  }, []);

  const [theme, setTheme] = useState<ThemeDefinition>(initial);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setThemeById = useCallback((id: string) => {
    const next = getTheme(id);
    if (!next) return;
    writeStoredThemeId(id);
    setTheme(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setThemeById, themes: listThemes() }),
    [theme, setThemeById],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
