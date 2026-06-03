import { useEffect, useRef, useState } from "react";
import type { WorkflowGraph } from "@orca/contracts";
import { GateGlyph, PlusIcon, CloseIcon, ArrowRightIcon } from "./icons";

export interface WorkflowFlowProps {
  graph: WorkflowGraph;
  onGraphChange: (next: WorkflowGraph) => void;
  onOpenNode: (id: string) => void;
  onAddNode: (type: "step" | "gate") => void;
  onRemoveNode: (id: string) => void;
  onResetLayout: () => void;
  readOnly?: boolean;
}

const NODE_W = 240;
const NODE_H = 64;

export function WorkflowFlow({
  graph,
  onGraphChange,
  onOpenNode,
  onAddNode,
  onRemoveNode,
  onResetLayout,
  readOnly = false,
}: WorkflowFlowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    id: string;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [linkDrag, setLinkDrag] = useState<{
    fromId: string;
    x: number;
    y: number;
    overId: string | null;
  } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);

  const { nodes, edges, positions } = graph;

  const posList = Object.values(positions);
  const canvasHeight = Math.max(320, ...posList.map((p) => p.y + NODE_H + 60));
  const canvasWidth = Math.max(520, ...posList.map((p) => p.x + NODE_W + 40));

  useEffect(() => {
    if (!drag && !linkDrag) return;

    const handleMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const scrollLeft = containerRef.current?.scrollLeft ?? 0;
      const scrollTop = containerRef.current?.scrollTop ?? 0;
      const px = e.clientX - rect.left + scrollLeft;
      const py = e.clientY - rect.top + scrollTop;

      if (drag) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        const moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 4;
        if (moved !== drag.moved) setDrag((d) => d && { ...d, moved: true });
        onGraphChange({
          ...graph,
          positions: {
            ...graph.positions,
            [drag.id]: {
              x: Math.max(0, px - drag.offsetX),
              y: Math.max(0, py - drag.offsetY),
            },
          },
        });
      } else if (linkDrag) {
        let overId: string | null = null;
        for (const n of nodes) {
          if (n.id === linkDrag.fromId) continue;
          const p = positions[n.id];
          if (!p) continue;
          if (px >= p.x && px <= p.x + NODE_W && py >= p.y && py <= p.y + NODE_H) {
            overId = n.id;
            break;
          }
        }
        setLinkDrag((ld) => ld && { ...ld, x: px, y: py, overId });
      }
    };

    const handleUp = (e: MouseEvent) => {
      if (drag) {
        const moved = Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 4;
        if (!moved) onOpenNode(drag.id);
      }
      if (linkDrag) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const scrollLeft = containerRef.current?.scrollLeft ?? 0;
          const scrollTop = containerRef.current?.scrollTop ?? 0;
          const px = e.clientX - rect.left + scrollLeft;
          const py = e.clientY - rect.top + scrollTop;
          let overId: string | null = null;
          for (const n of nodes) {
            if (n.id === linkDrag.fromId) continue;
            const p = positions[n.id];
            if (!p) continue;
            if (px >= p.x && px <= p.x + NODE_W && py >= p.y && py <= p.y + NODE_H) {
              overId = n.id;
              break;
            }
          }
          if (overId != null) {
            const from = linkDrag.fromId;
            const to = overId;
            // Block self-loops and exact-duplicate directed edges, but allow a
            // directed back-edge (B→A when A→B already exists) — DAGs need it for
            // feedback/retry flows.
            const exists = graph.edges.some(([a, b]) => a === from && b === to);
            if (from !== to && !exists) {
              onGraphChange({ ...graph, edges: [...graph.edges, [from, to]] });
            }
          }
        }
      }
      setDrag(null);
      setLinkDrag(null);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [drag, linkDrag, graph, nodes, positions, onGraphChange, onOpenNode]);

  function pathFor(fromId: string, toId: string): string {
    const a = positions[fromId];
    const b = positions[toId];
    if (!a || !b) return "";
    const ax = a.x + NODE_W / 2;
    const ay = a.y + NODE_H;
    const bx = b.x + NODE_W / 2;
    const by = b.y;
    const dy = Math.max(28, (by - ay) / 2);
    return `M ${ax} ${ay} C ${ax} ${ay + dy}, ${bx} ${by - dy}, ${bx} ${by}`;
  }

  function removeEdge(i: number) {
    onGraphChange({ ...graph, edges: graph.edges.filter((_, ei) => ei !== i) });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Toolbar */}
      {!readOnly && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={() => onAddNode("step")}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              height: 22, padding: "0 8px", borderRadius: 7,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--hairline)",
              color: "var(--text)", fontFamily: "inherit",
              fontSize: 11.5, fontWeight: 500, cursor: "pointer",
            }}
          >
            <PlusIcon size={13} />
            Add step
          </button>
          <button
            type="button"
            onClick={() => onAddNode("gate")}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              height: 22, padding: "0 8px", borderRadius: 7,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--hairline)",
              color: "var(--text)", fontFamily: "inherit",
              fontSize: 11.5, fontWeight: 500, cursor: "pointer",
            }}
          >
            <GateGlyph size={12} />
            Add gate
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onResetLayout}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              height: 22, padding: "0 8px", borderRadius: 7,
              background: "transparent", border: "1px solid transparent",
              color: "var(--text-2)", fontFamily: "inherit",
              fontSize: 11.5, fontWeight: 500, cursor: "pointer",
            }}
          >
            Reset layout
          </button>
        </div>
      )}

      {/* Hint row */}
      {!readOnly && <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.5 }}>
        Drag a node to move it · drag the{" "}
        <span
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 14, height: 14, borderRadius: 7,
            border: "1px solid var(--hairline-strong)",
            fontSize: 9, color: "var(--text-2)",
            verticalAlign: "middle", margin: "0 2px",
          }}
        >
          +
        </span>{" "}
        port onto another node to link · click a line to unlink · click a node to edit
      </div>}

      {/* Canvas */}
      <div
        ref={containerRef}
        style={{
          position: "relative",
          width: "100%",
          height: canvasHeight,
          minWidth: 0,
          background: "var(--bg)",
          border: "1px solid var(--hairline)",
          borderRadius: 10,
          overflow: "auto",
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 0)",
          backgroundSize: "14px 14px",
        }}
      >
        <div style={{ position: "relative", width: canvasWidth, height: canvasHeight }}>
          <svg
            width={canvasWidth}
            height={canvasHeight}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            <defs>
              <marker
                id="wf-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="var(--text-3)" />
              </marker>
              <marker
                id="wf-arrow-hot"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
              </marker>
            </defs>

            {edges.map(([from, to], i) => {
              const edgeKey = `${from}-${to}`;
              const isHot = hoverEdge === edgeKey;
              const d = pathFor(from, to);
              if (!d) return null;
              return (
                <g
                  key={edgeKey}
                  style={{ pointerEvents: "all", cursor: "pointer" }}
                  onMouseEnter={() => setHoverEdge(edgeKey)}
                  onMouseLeave={() => setHoverEdge((h) => (h === edgeKey ? null : h))}
                  onClick={() => removeEdge(i)}
                >
                  <path d={d} stroke="transparent" strokeWidth={16} fill="none" />
                  <path
                    d={d}
                    stroke={isHot ? "var(--accent)" : "var(--text-3)"}
                    strokeWidth={isHot ? 2 : 1.4}
                    fill="none"
                    markerEnd={isHot ? "url(#wf-arrow-hot)" : "url(#wf-arrow)"}
                  />
                </g>
              );
            })}

            {linkDrag && positions[linkDrag.fromId] && (
              <path
                d={`M ${positions[linkDrag.fromId].x + NODE_W / 2} ${positions[linkDrag.fromId].y + NODE_H} L ${linkDrag.x} ${linkDrag.y}`}
                stroke="var(--accent)"
                strokeWidth={1.6}
                fill="none"
                strokeDasharray="5 4"
              />
            )}
          </svg>

          {nodes.map((n, i) => {
            const p = positions[n.id];
            if (!p) return null;
            const isDragging = drag?.id === n.id;
            const isLinkTarget = linkDrag != null && linkDrag.overId === n.id;
            const isGate = n.type === "gate";
            const baseBg = isGate ? "rgba(255, 160, 100, 0.06)" : "var(--panel-2)";
            const baseBorder = isGate ? "var(--accent-line)" : "var(--hairline)";

            return (
              <div
                key={n.id}
                data-node-id={n.id}
                style={{
                  position: "absolute",
                  left: p.x,
                  top: p.y,
                  width: NODE_W,
                  height: NODE_H,
                  background: isLinkTarget ? "var(--accent-soft)" : baseBg,
                  border:
                    "1px solid " +
                    (isLinkTarget
                      ? "var(--accent-line)"
                      : isDragging
                        ? "var(--hairline-strong)"
                        : baseBorder),
                  borderRadius: isGate ? 28 : 8,
                  padding: "0 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: isDragging ? "grabbing" : "grab",
                  userSelect: "none",
                  boxShadow: isDragging ? "0 8px 24px rgba(0,0,0,0.45)" : "none",
                  transition: isDragging
                    ? "none"
                    : "border-color 120ms ease, background 120ms ease, box-shadow 120ms ease",
                  zIndex: isDragging ? 5 : 1,
                }}
                onMouseDown={(e) => {
                  if (readOnly || e.button !== 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDrag({
                    id: n.id,
                    offsetX: e.clientX - rect.left,
                    offsetY: e.clientY - rect.top,
                    startX: e.clientX,
                    startY: e.clientY,
                    moved: false,
                  });
                }}
                onClick={(e) => {
                  if (!readOnly) return;
                  // In readOnly mode there's no drag, so click always opens the node
                  e.stopPropagation();
                  onOpenNode(n.id);
                }}
              >
                {isGate ? (
                  <span style={{ display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
                    <GateGlyph size={13} />
                  </span>
                ) : (
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: "var(--text-4)", flexShrink: 0 }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                )}

                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: isGate ? "var(--accent)" : "var(--text)",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      letterSpacing: isGate ? 0.2 : 0,
                    }}
                  >
                    {n.name || (isGate ? "Gate" : "Step")}
                  </span>
                </div>

                {!isGate && <ArrowRightIcon size={11} color="var(--text-4)" />}

                {/* link-out port — hidden in readOnly */}
                {!readOnly && (
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (e.button !== 0) return;
                      setLinkDrag({
                        fromId: n.id,
                        x: p.x + NODE_W / 2,
                        y: p.y + NODE_H,
                        overId: null,
                      });
                    }}
                    title="Drag to another node to connect"
                    style={{
                      position: "absolute",
                      bottom: -9,
                      left: "50%",
                      transform: "translateX(-50%)",
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      background: "var(--panel)",
                      border: "1px solid var(--hairline-strong)",
                      color: "var(--text-2)",
                      cursor: "crosshair",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 0,
                      fontFamily: "inherit",
                      fontSize: 13,
                      lineHeight: "1",
                      fontWeight: 500,
                    }}
                  >
                    +
                  </button>
                )}

                {/* delete button — hidden in readOnly */}
                {!readOnly && <NodeDeleteButton onDelete={() => onRemoveNode(n.id)} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NodeDeleteButton({ onDelete }: { onDelete: () => void }) {
  const [visible, setVisible] = useState(false);
  return (
    <button
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      title="Remove node"
      style={{
        position: "absolute",
        top: -8,
        right: -8,
        width: 18,
        height: 18,
        borderRadius: 9,
        background: "var(--panel)",
        border: "1px solid var(--hairline-strong)",
        color: "var(--text-3)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        opacity: visible ? 1 : 0,
        transition: "opacity 120ms ease",
      }}
    >
      <CloseIcon size={10} />
    </button>
  );
}
