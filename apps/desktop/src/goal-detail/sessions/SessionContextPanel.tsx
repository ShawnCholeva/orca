import type { ContextAssembly, ContextPackage } from "@orca/contracts";
import { ContextPreviewPanel } from "../context-preview-panel/index";

type Props = {
  goalId: string;
  pkg: ContextPackage | null;
  assembly: ContextAssembly | null;
  open: boolean;
  onToggle: () => void;
};

export function SessionContextPanel({ goalId, pkg, assembly, open, onToggle }: Props) {
  if (!pkg && !assembly) return null;

  return (
    <div className="session-context-panel">
      <button
        type="button"
        className="session-context-panel-toggle"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Context package
      </button>
      {open && (
        <div className="session-context-panel-body">
          <ContextPreviewPanel
            goalId={goalId}
            assembly={assembly}
            pkg={pkg}
            readOnly
            onStartSession={() => {}}
            onRegenerate={() => {}}
            onRetry={() => {}}
          />
        </div>
      )}
    </div>
  );
}
