import { useState } from "react";
import type { RepairAction } from "@orca/contracts";

interface RepairBlockProps {
  repair: RepairAction;
  onOpenUrl: (url: string) => Promise<void>;
  onActionTaken?: () => void;
}

export function RepairBlock({ repair, onOpenUrl, onActionTaken }: RepairBlockProps) {
  const [copyError, setCopyError] = useState(false);

  if (repair.kind === "install_url" && repair.url) {
    return (
      <div className="repair-block">
        <button
          type="button"
          onClick={() => {
            onOpenUrl(repair.url!).then(() => onActionTaken?.()).catch(() => {});
          }}
        >
          {repair.label}
        </button>
      </div>
    );
  }
  if (repair.kind === "run_command" && repair.command) {
    return (
      <div className="repair-block">
        <code data-testid="repair-command" aria-label={repair.label}>{repair.command}</code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(repair.command!).then(
              () => setCopyError(false),
              () => setCopyError(true),
            );
          }}
        >
          Copy
        </button>
        {copyError && <span className="repair-block-error">Copy failed — paste manually.</span>}
        {repair.requiresAppRestart && (
          <span className="repair-block-hint">Restart Orca after running this.</span>
        )}
      </div>
    );
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn("RepairBlock: unhandled repair kind", (repair as { kind: string }).kind);
  }
  return null;
}
