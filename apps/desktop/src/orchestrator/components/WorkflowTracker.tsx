import { Fragment } from "react";
import type { CSSProperties, ReactNode } from "react";

// Horizontal workflow tracker shown at the top of the Orchestrator tab so the
// user can see, at a glance, which step of the active workflow the orchestrator
// (Conductor) is currently executing.

export type TrackerStep = {
  name: string;
  role?: string;
  // Steps and gates share the stepper. A gate renders as a distinct node (rounded
  // square + shield glyph) so the user can see where a workflow's approval/critique
  // checkpoints sit in the flow, not just its steps. Absent means "step".
  kind?: "step" | "gate";
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
  // When the terminal step has done its work but the run is parked "active"
  // awaiting completion approval (the complete_workflow_run recommendation is
  // still proposed), the step must NOT render as a finished green check — that
  // reads as "done" and is why users think the goal completed. Instead it shows
  // an explicit "awaiting approval" indicator.
  awaitingApproval?: boolean;
  // Approve the parked terminal step's completion (accepts the pending
  // complete_workflow_run recommendation). Only surfaced while awaitingApproval.
  onApprove?: () => void;
  // Whether an approval request is in flight, to disable the button.
  approving?: boolean;
  // When the run is parked at a gate awaiting a human approve/reject decision,
  // the step at activeIndex (the gate's source step) renders "awaiting approval".
  // The Approve/Reject action lives in the chat thread, not here.
  awaitingGate?: boolean;
  // When a step has produced its output and is parked for the human to
  // Continue/Revise, the step at activeIndex renders "awaiting confirmation"
  // instead of pulsing "running" (honest status — the work has stopped, it's the
  // human's turn). The Continue/Revise action lives in the chat thread.
  awaitingConfirm?: boolean;
  // Indices of steps the run routed PAST (e.g. an approach_only skip of Clarify/
  // Research). They render as "skipped" — muted, no completion check — so the user
  // can tell a bypassed step from one that actually ran.
  skippedIndices?: number[];
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

// Shield-check: the gate node glyph (approval/critique checkpoint).
const GateIcon = (p: { size?: number; color?: string }) =>
  svg(
    <>
      <path d="M12 3l7 3v5c0 4-3 6.8-7 8-4-1.2-7-4-7-8V6l7-3z" />
      <path d="M9 11.5l2 2 4-4" />
    </>,
    p,
  );

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
  awaitingApproval = false,
  onApprove,
  approving = false,
  awaitingGate = false,
  awaitingConfirm = false,
  skippedIndices = [],
  onViewWorkflows,
}: Props) {
  if (steps.length === 0) return null;
  const active = completed || !activeRunning ? undefined : steps[activeIndex];
  // The header counts steps only — gates share the stepper but aren't "Step N".
  // When parked at a gate, the count reflects its source step (the last step at
  // or before the active index), which reads naturally ("Step 2 of 4" at the gate
  // that follows step 2).
  const totalSteps = steps.filter((s) => s.kind !== "gate").length;
  const currentStepNumber = steps.slice(0, activeIndex + 1).filter((s) => s.kind !== "gate").length;

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
          {completed ? "Completed" : `Step ${currentStepNumber} of ${totalSteps}`}
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
        {awaitingApproval && onApprove && (
          <button
            type="button"
            onClick={onApprove}
            disabled={approving}
            style={{
              all: "unset",
              cursor: approving ? "default" : "pointer",
              fontSize: 11,
              fontWeight: 600,
              color: "#fff",
              background: "var(--accent)",
              padding: "4px 11px",
              borderRadius: 6,
              opacity: approving ? 0.6 : 1,
              marginRight: 12,
            }}
          >
            {approving ? "Approving…" : "Approve to complete"}
          </button>
        )}
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
          const isGate = step.kind === "gate";
          const isSkipped = skippedIndices.includes(i);
          const isAwaiting =
            !completed && (awaitingApproval || awaitingGate || awaitingConfirm) && i === activeIndex;
          const done =
            !isSkipped &&
            (completed || i < activeIndex || (i === activeIndex && !activeRunning && !isAwaiting));
          const isActive = !completed && !isSkipped && activeRunning && i === activeIndex;
          const dotColor = done
            ? "var(--run)"
            : isActive || isAwaiting
              ? "var(--accent)"
              : "transparent";
          const ringColor = done
            ? "var(--run)"
            : isActive || isAwaiting
              ? "var(--accent)"
              : "var(--hairline-strong)";
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
                    borderRadius: isGate ? 7 : "50%",
                    flexShrink: 0,
                    background: dotColor,
                    border: "1.5px solid " + ringColor,
                    boxShadow: isActive || (isAwaiting && isGate) ? "0 0 0 4px var(--accent-soft)" : "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "background 160ms ease, box-shadow 160ms ease",
                  }}
                >
                  {done ? (
                    <span data-testid="tracker-done-check" style={{ display: "inline-flex" }}>
                      <CheckIcon size={13} color="#fff" />
                    </span>
                  ) : isSkipped ? (
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-4)" }}>
                      –
                    </span>
                  ) : isGate ? (
                    <GateIcon size={13} color={isActive || isAwaiting ? "#fff" : "var(--text-4)"} />
                  ) : isAwaiting ? (
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
                    fontWeight: isActive || isAwaiting ? 600 : 500,
                    color:
                      isActive || isAwaiting
                        ? "var(--text)"
                        : done
                          ? "var(--text-2)"
                          : "var(--text-4)",
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
                {isAwaiting && (
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
                        background: "var(--accent)",
                        boxShadow: "0 0 0 3px var(--accent-soft)",
                      }}
                    />
                    {awaitingGate
                      ? "awaiting gate"
                      : awaitingConfirm && !awaitingApproval
                        ? "awaiting confirmation"
                        : "awaiting approval"}
                  </span>
                )}
                {isSkipped && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                      color: "var(--text-4)",
                    }}
                  >
                    skipped
                  </span>
                )}
                {isGate && !isActive && !isAwaiting && !isSkipped && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                      color: done ? "var(--text-3)" : "var(--text-4)",
                    }}
                  >
                    gate
                  </span>
                )}
              </div>
              {i < steps.length - 1 &&
                (() => {
                  // The connector joins step i and step i+1. It's between two
                  // completed steps when the next step is done (step i is then
                  // necessarily done too), so it goes green to match the
                  // completed checkmark. Otherwise blue once we're past step i.
                  // A connector touching a skipped node is muted — the path was
                  // routed past, so it is neither a completed (green) nor an
                  // in-progress (blue) segment.
                  const touchesSkipped = isSkipped || skippedIndices.includes(i + 1);
                  const nextDone =
                    !touchesSkipped &&
                    (completed ||
                      i + 1 < activeIndex ||
                      (i + 1 === activeIndex && !activeRunning));
                  return (
                    <div
                      style={{
                        flex: 1,
                        minWidth: 12,
                        height: 2,
                        marginTop: 11,
                        borderRadius: 1,
                        background: touchesSkipped
                          ? "var(--hairline)"
                          : nextDone
                            ? "var(--run)"
                            : i < activeIndex
                              ? "var(--accent)"
                              : "var(--hairline)",
                        transition: "background 160ms ease",
                      }}
                    />
                  );
                })()}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
