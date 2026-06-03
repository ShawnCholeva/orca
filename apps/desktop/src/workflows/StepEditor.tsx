import { useRef, useState } from "react";
import type { CreateWorkflowTemplateRequest } from "@orca/contracts";
import { OutputSchemaEditor } from "./OutputSchemaEditor";
import { CloseIcon, PlusIcon } from "./icons";

export type WorkflowStepDraft = CreateWorkflowTemplateRequest["steps"][number];

export interface StepListEditorProps {
  steps: WorkflowStepDraft[];
  onChange: (next: WorkflowStepDraft[]) => void;
  disabled?: boolean;
}

// ── Drag icon (6-dot grid) ────────────────────────────────────────────────────
function DragIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="4" cy="3" r="1.2" />
      <circle cx="10" cy="3" r="1.2" />
      <circle cx="4" cy="7" r="1.2" />
      <circle cx="10" cy="7" r="1.2" />
      <circle cx="4" cy="11" r="1.2" />
      <circle cx="10" cy="11" r="1.2" />
    </svg>
  );
}

// ── ChevronDown icon ──────────────────────────────────────────────────────────
function ChevronDownIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function createStepDraft(steps: WorkflowStepDraft[]): WorkflowStepDraft {
  const numericSuffixes = steps
    .map((step) => /^step-(\d+)$/.exec(step.id)?.[1])
    .map((value) => Number(value ?? "0"));
  const nextIndex = (numericSuffixes.length === 0 ? 0 : Math.max(...numericSuffixes)) + 1;
  return {
    id: `step-${nextIndex}`,
    ordinal: steps.length,
    name: "New step",
    instructions: "",
    outputSchema: [{ key: "result", type: "string" as const, required: true }],
    agentPreference: [{ adapterId: "claude-code" as const, modelId: "claude-haiku-4-5" }],
  };
}

export function StepEditor({ steps, onChange, disabled = false }: StepListEditorProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const dragIdx = useRef<number | null>(null);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateStep(index: number, patch: Partial<WorkflowStepDraft>) {
    const next = steps.slice();
    next[index] = { ...next[index], ...patch };
    onChange(next);
  }

  function removeStep(index: number) {
    onChange(steps.filter((_, i) => i !== index));
  }

  function moveStep(fromIndex: number, toIndex: number) {
    if (toIndex < 0 || toIndex >= steps.length) return;
    const next = steps.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onChange(next);
  }

  function addStep() {
    onChange([...steps, createStepDraft(steps)]);
  }

  // ── Drag handlers ────────────────────────────────────────────────────────────
  function onDragStart(i: number) {
    return (e: React.DragEvent) => {
      dragIdx.current = i;
      e.dataTransfer.effectAllowed = "move";
    };
  }

  function onDragOver(i: number) {
    return (e: React.DragEvent) => {
      e.preventDefault();
      if (dragIdx.current === null || dragIdx.current === i) return;
      const next = steps.slice();
      const [moved] = next.splice(dragIdx.current, 1);
      next.splice(i, 0, moved);
      dragIdx.current = i;
      onChange(next);
    };
  }

  function onDragEnd() {
    dragIdx.current = null;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {steps.map((step, i) => {
        const isOpen = expanded.has(step.id);
        return (
          <div
            key={step.id}
            style={{
              background: "var(--panel-2)",
              border: "1px solid " + (isOpen ? "var(--accent-line)" : "var(--hairline)"),
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {/* ── Row ───────────────────────────────────────────────────────── */}
            <div
              draggable={!disabled}
              onDragStart={disabled ? undefined : onDragStart(i)}
              onDragOver={disabled ? undefined : onDragOver(i)}
              onDragEnd={disabled ? undefined : onDragEnd}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                cursor: disabled ? "default" : "grab",
              }}
            >
              <span
                style={{ color: "var(--text-4)", display: "inline-flex", flexShrink: 0 }}
                title="Drag to reorder"
              >
                <DragIcon size={14} />
              </span>

              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--text-4)", width: 22, flexShrink: 0 }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>

              <input
                value={step.name}
                onChange={(e) => updateStep(i, { name: e.target.value })}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={disabled}
                placeholder="Step name"
                aria-label={`Step ${i + 1} name`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--text)",
                  fontFamily: "inherit",
                  fontSize: 13,
                  fontWeight: 500,
                  padding: "4px 2px",
                  cursor: disabled ? "default" : undefined,
                }}
              />

              <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                {/* Edit/hide details toggle */}
                <button
                  type="button"
                  onClick={() => toggleExpand(step.id)}
                  title={isOpen ? "Collapse details" : "Edit details"}
                  style={{
                    height: 24,
                    padding: "0 8px",
                    borderRadius: 6,
                    background: isOpen ? "var(--accent-soft, rgba(100,140,255,0.12))" : "rgba(255,255,255,0.04)",
                    border: "1px solid " + (isOpen ? "var(--accent-line)" : "var(--hairline)"),
                    color: isOpen ? "var(--accent, #6486f8)" : "var(--text-2)",
                    fontFamily: "inherit",
                    fontSize: 11.5,
                    fontWeight: 500,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      transform: isOpen ? "rotate(180deg)" : undefined,
                      transition: "transform 150ms ease",
                    }}
                  >
                    <ChevronDownIcon size={12} />
                  </span>
                  {isOpen ? "Hide" : "Details"}
                </button>

                {/* Move up */}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => moveStep(i, i - 1)}
                    disabled={i === 0}
                    title="Move up"
                    aria-label={`Move step ${i + 1} up`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--hairline)",
                      color: "var(--text-2)",
                      cursor: i === 0 ? "not-allowed" : "pointer",
                      opacity: i === 0 ? 0.3 : 1,
                    }}
                  >
                    <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
                      <ChevronDownIcon size={13} />
                    </span>
                  </button>
                )}

                {/* Move down */}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => moveStep(i, i + 1)}
                    disabled={i === steps.length - 1}
                    title="Move down"
                    aria-label={`Move step ${i + 1} down`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--hairline)",
                      color: "var(--text-2)",
                      cursor: i === steps.length - 1 ? "not-allowed" : "pointer",
                      opacity: i === steps.length - 1 ? 0.3 : 1,
                    }}
                  >
                    <ChevronDownIcon size={13} />
                  </button>
                )}

                {/* Remove */}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => removeStep(i)}
                    title="Remove step"
                    aria-label={`Remove step ${i + 1}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      background: "var(--err-soft, rgba(220,60,60,0.1))",
                      border: "none",
                      color: "var(--err, #e05454)",
                      cursor: "pointer",
                    }}
                  >
                    <CloseIcon size={11} />
                  </button>
                )}
              </div>
            </div>

            {/* ── Detail panel ─────────────────────────────────────────────── */}
            {isOpen && (
              <div
                style={{
                  padding: "12px 14px 14px 44px",
                  borderTop: "1px solid var(--hairline)",
                  background: "var(--bg)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {/* Instructions */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: "var(--text-3)",
                      textTransform: "uppercase",
                      letterSpacing: 1.2,
                    }}
                  >
                    Instructions
                  </span>
                  <textarea
                    value={step.instructions}
                    onChange={(e) => updateStep(i, { instructions: e.target.value })}
                    disabled={disabled}
                    rows={5}
                    placeholder="Describe what this step does, in the second person."
                    aria-label={`Step ${i + 1} instructions`}
                    style={{
                      background: "var(--panel)",
                      border: "1px solid var(--hairline)",
                      borderRadius: 6,
                      padding: "8px 10px",
                      color: "var(--text)",
                      fontFamily: "inherit",
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      resize: "vertical",
                      outline: "none",
                      width: "100%",
                      boxSizing: "border-box",
                    }}
                  />
                </div>

                {/* Output schema */}
                <OutputSchemaEditor
                  schema={step.outputSchema}
                  onChange={(nextSchema) => updateStep(i, { outputSchema: nextSchema })}
                  disabled={disabled}
                />
              </div>
            )}
          </div>
        );
      })}

      {/* ── Add step button ──────────────────────────────────────────────────── */}
      {!disabled && (
        <button
          type="button"
          onClick={addStep}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "10px 12px",
            background: "transparent",
            border: "1px dashed var(--hairline-strong, var(--hairline))",
            borderRadius: 8,
            color: "var(--text-2)",
            fontFamily: "inherit",
            fontSize: 12.5,
            fontWeight: 500,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.02)";
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--text-2)";
          }}
        >
          <PlusIcon size={13} />
          Add step
        </button>
      )}
    </div>
  );
}
