import type { ConnectionStatus } from "../api";
import "./bootstrap-error.css";

interface Props {
  message: string;
  connectionStatus: ConnectionStatus;
  onRetry: () => void;
}

export function BootstrapErrorScreen({ message, connectionStatus, onRetry }: Props) {
  const daemonDown = connectionStatus !== "open";
  return (
    <div className="bootstrap-error" role="alert">
      <div className="bootstrap-error-card">
        <div className="mono bootstrap-error-kicker">Startup failed</div>
        <h1 className="bootstrap-error-title">Orca couldn't load</h1>
        <p className="bootstrap-error-message">
          {daemonDown
            ? "The daemon is unreachable. Start the daemon, then retry."
            : message}
        </p>
        <pre className="bootstrap-error-detail mono">{message}</pre>
        <div className="bootstrap-error-actions">
          <button type="button" className="bootstrap-error-btn bootstrap-error-btn--primary" onClick={onRetry}>
            Retry
          </button>
          <button
            type="button"
            className="bootstrap-error-btn bootstrap-error-btn--quiet"
            onClick={() => window.location.reload()}
          >
            Reload app
          </button>
        </div>
      </div>
    </div>
  );
}
