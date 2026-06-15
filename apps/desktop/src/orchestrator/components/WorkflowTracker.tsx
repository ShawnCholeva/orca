import { Fragment } from "react";
import type { CSSProperties, ReactNode } from "react";

// Horizontal workflow tracker shown at the top of the Orchestrator tab so the
// user can see, at a glance, which step of the active workflow the orchestrator
// (Conductor) is currently executing.

export type TrackerStep = {
  name: string;
  role?: string;
};

type Props = {
  workflowName: string;
  steps: TrackerStep[];
  activeIndex: number;
  // Whether the step at activeIndex is genuinely executing. When false (e.g. a
  // terminal step that has passed and parked the run for completion approval),
  // the step renders done rather than pulsing "running".
  activeRunning?: boolean;
  // When the workflow has finished, every step is done and the header reads
  // "Completed" instead of a step position.
  completed?: boolean;
  onViewWorkflows?: () => void;
};

// 24px sketch-line icons (stroke 1.5), matching the app's inline-SVG style.
function svg(children: ReactNode, props: { size?: number; color?: string; style?: CSSProperties }) {
  const { size = 16, color = "currentColor", style } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const WorkflowIcon = (p: { size?: number; color?: string }) =>
  svg(
    <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="9" y="15" width="6" height="6" rx="1" />
      <path d="M6 9v3h12V9" />
      <path d="M12 12v3" />
    </>,
    p,
  );

const CheckIcon = (p: { size?: number; color?: string }) =>
  svg(<path d="M5 12l4.5 4.5L19 7" />, p);

const ArrowRightIcon = (p: { size?: number; color?: string; style?: CSSProperties }) =>
  svg(
    <>
      <path d="M5 12h14" />
      <path d="M13 5l7 7-7 7" />
    </>,
    p,
  );

export function WorkflowTracker({
  workflowName,
  steps,
  activeIndex,
  activeRunning = true,
  completed = false,
  onViewWorkflows,
}: Props) {
  if (steps.length === 0) return null;
  const active = completed || !activeRunning ? undefined : steps[activeIndex];

  return (
    <div
      style={{
        flexShrink: 0,
        background: "var(--panel)",
        border: "1px solid var(--hairline)",
        borderRadius: 12,
        padding: "13px 16px 15px",
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
        <WorkflowIcon size={14} color="var(--accent)" />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{workflowName}</span>
        <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--text-4)" }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
          {completed ? "Completed" : `Step ${activeIndex + 1} of ${steps.length}`}
        </span>
        {active && active.role && (
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--accent)",
              padding: "1px 7px",
              borderRadius: 4,
              background: "var(--accent-soft)",
              border: "1px solid var(--accent-line)",
            }}
          >
            {active.role}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {onViewWorkflows && (
          <button
            type="button"
            onClick={onViewWorkflows}
            style={{
              all: "unset",
              cursor: "pointer",
              fontSize: 11,
              color: "var(--text-3)",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-3)";
            }}
          >
            View workflow <ArrowRightIcon size={11} color="currentColor" />
          </button>
        )}
      </div>

      {/* stepper */}
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        {steps.map((step, i) => {
          const done = completed || i < activeIndex || (i === activeIndex && !activeRunning);
          const isActive = !completed && activeRunning && i === activeIndex;
          const dotColor = done || isActive ? "var(--accent)" : "transparent";
          const ringColor = done || isActive ? "var(--accent)" : "var(--hairline-strong)";
          return (
            <Fragment key={i}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 7,
                  flex: "0 0 auto",
                  width: 92,
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: dotColor,
                    border: "1.5px solid " + ringColor,
                    boxShadow: isActive ? "0 0 0 4px var(--accent-soft)" : "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "background 160ms ease, box-shadow 160ms ease",
                  }}
                >
                  {done ? (
                    <CheckIcon size={13} color="#fff" />
                  ) : (
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: isActive ? "#fff" : "var(--text-4)",
                      }}
                    >
                      {i + 1}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    lineHeight: 1.3,
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? "var(--text)" : done ? "var(--text-2)" : "var(--text-4)",
                    textWrap: "pretty",
                  }}
                >
                  {step.name}
                </div>
                {isActive && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                      color: "var(--accent)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: "var(--run)",
                        boxShadow: "0 0 0 3px var(--run-soft)",
                      }}
                    />
                    running
                  </span>
                )}
              </div>
              {i < steps.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    minWidth: 12,
                    height: 2,
                    marginTop: 11,
                    borderRadius: 1,
                    background: i < activeIndex ? "var(--accent)" : "var(--hairline)",
                    transition: "background 160ms ease",
                  }}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
