import "./empty-state.css";

const HINTS = [
  {
    title: "Frame it operationally",
    body: "Goals describe outcomes — a migration, a release, a hardening pass.",
  },
  {
    title: "Coordinate agents",
    body: "The Conductor delegates the goal's tasks to the agents you connected.",
  },
  {
    title: "Memory accrues",
    body: "Decisions, constraints, and tradeoffs are pinned to the goal.",
  },
];

export function EmptyGoalsView({
  onCreate,
  disabled = false,
}: {
  onCreate: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="empty-goals">
      <div className="empty-goals-wash" aria-hidden="true" />
      <div className="empty-goals-inner">
        <EmptyGoalsMark />
        <h1 className="empty-goals-title">Start with a goal.</h1>
        <p className="empty-goals-body">
          A goal is the operational unit Orca coordinates around — its sessions,
          memory, conflicts, and reasoning all live under one umbrella. Create
          your first goal and Orca takes it from there.
        </p>
        <div className="empty-goals-actions">
          <button
            type="button"
            className="empty-goals-btn"
            onClick={onCreate}
            disabled={disabled}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            Create your first goal
          </button>
        </div>

        <div className="empty-goals-hints">
          {HINTS.map((hint, i) => (
            <div key={hint.title} className="empty-goals-hint">
              <div className="empty-goals-hint-num">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="empty-goals-hint-title">{hint.title}</div>
              <div className="empty-goals-hint-body">{hint.body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyGoalsMark() {
  return (
    <div className="empty-goals-mark">
      <svg viewBox="0 0 116 116" width="116" height="116" aria-hidden="true">
        <defs>
          <linearGradient id="empty-goals-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-2, #8B5CF6)" />
          </linearGradient>
        </defs>
        <circle
          cx="58"
          cy="58"
          r="52"
          fill="none"
          stroke="var(--hairline)"
          strokeWidth="1"
          strokeDasharray="3 5"
        />
        <circle
          cx="58"
          cy="58"
          r="38"
          fill="none"
          stroke="url(#empty-goals-ring)"
          strokeWidth="1.5"
          strokeDasharray="120 360"
        />
        <circle cx="58" cy="58" r="22" fill="var(--accent-soft)" />
      </svg>
      <div className="empty-goals-mark-center">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1.5" fill="var(--accent)" />
        </svg>
      </div>
    </div>
  );
}
