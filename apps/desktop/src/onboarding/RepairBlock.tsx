import type { RepairAction } from "@orca/contracts";

interface RepairBlockProps {
  repair: RepairAction;
  onOpenUrl: (url: string) => void;
}

export function RepairBlock({ repair, onOpenUrl }: RepairBlockProps) {
  if (repair.kind === "install_url" && repair.url) {
    return (
      <div className="repair-block">
        <button type="button" onClick={() => onOpenUrl(repair.url!)}>
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
          onClick={() => void navigator.clipboard.writeText(repair.command!)}
        >
          Copy
        </button>
        {repair.requiresAppRestart && (
          <span className="repair-block-hint">Restart Orca after running this.</span>
        )}
      </div>
    );
  }
  return null;
}
