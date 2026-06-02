import type { AdapterId, ContextPackage, SessionSummary } from "@orca/contracts";

// claude-code and codex receive context as preview_only.
const PREVIEW_ONLY_ADAPTERS = new Set<AdapterId>(["claude-code", "codex"]);

type BadgeState = "ready" | "sparse" | "truncated" | "preview-only" | "failed" | "none";

export function getContextBadgeState(
  session: SessionSummary,
  pkg: ContextPackage | null | undefined
): BadgeState {
  if (!session.contextPackageId) return "none";
  if (pkg === null) return "failed";
  if (pkg === undefined) return "none";
  if (PREVIEW_ONLY_ADAPTERS.has(pkg.adapterId)) return "preview-only";
  if (pkg.sparse) return "sparse";
  if (pkg.truncated) return "truncated";
  return "ready";
}

function formatKiB(bytes: number): string {
  return (bytes / 1024).toFixed(1) + " KiB";
}

type Props = {
  session: SessionSummary;
  pkg: ContextPackage | null | undefined;
  onClick: () => void;
};

export function SessionContextBadge({ session, pkg, onClick }: Props) {
  const state = getContextBadgeState(session, pkg);
  if (state === "none") return null;

  const detail = pkg ? ` · ${formatKiB(pkg.renderedBytes)} · ${pkg.sourceCount} sources` : "";

  return (
    <button
      type="button"
      className={`session-context-badge session-context-badge--${state}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={`Context: ${state}`}
    >
      ctx: {state}{detail}
    </button>
  );
}
