import { useEffect, useState } from "react";
import { OrcaMark } from "../onboarding/glyphs";
import { useTheme } from "../theme/ThemeProvider";
import "./titlebar.css";

interface TauriWindowApi {
  getCurrentWindow: () => {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onResized: (cb: () => void) => Promise<() => void>;
  };
}

async function loadWindowApi(): Promise<TauriWindowApi | null> {
  try {
    const core = await import("@tauri-apps/api/core");
    if (!core.isTauri()) return null;
    const mod = await import("@tauri-apps/api/window");
    return { getCurrentWindow: mod.getCurrentWindow };
  } catch {
    return null;
  }
}

export function Titlebar() {
  const { theme } = useTheme();
  const [api, setApi] = useState<TauriWindowApi | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    loadWindowApi().then(async (loaded) => {
      if (!loaded || cancelled) return;
      setApi(loaded);
      const win = loaded.getCurrentWindow();
      try { setMaximized(await win.isMaximized()); } catch { /* ignore */ }
      try {
        unlisten = await win.onResized(async () => {
          try { setMaximized(await win.isMaximized()); } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // In browser dev mode (vite without Tauri): render styled bar but hide controls.
  const inTauri = api !== null;

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <OrcaMark size={16} mode={theme.mode} />
        <span className="mono titlebar-wordmark" data-tauri-drag-region>ORCA</span>
      </div>
      <div className="titlebar-drag" data-tauri-drag-region />
      {inTauri && (
        <div className="titlebar-controls">
          <button
            type="button"
            className="titlebar-btn"
            aria-label="Minimize"
            onClick={() => api?.getCurrentWindow().minimize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
          <button
            type="button"
            className="titlebar-btn"
            aria-label={maximized ? "Restore" : "Maximize"}
            onClick={() => api?.getCurrentWindow().toggleMaximize()}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="1.5" y="3" width="5.5" height="5.5" />
                <path d="M3 3V1.5h5.5V7H7" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="1.5" y="1.5" width="7" height="7" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-btn--close"
            aria-label="Close"
            onClick={() => api?.getCurrentWindow().close()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
