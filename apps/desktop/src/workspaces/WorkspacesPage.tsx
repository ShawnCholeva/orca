// Workspaces tab — a repo-scoped home for goals. Left: the workspace list.
// Right: the selected workspace's profile plus every goal grouped by status.
// Data comes from the daemon API; changes are reflected via the event stream.

import { useState, useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { Icon } from "./icons";
import { Btn, Pill, Tip, Field, inputStyle } from "./primitives";
import { GOAL_STATE_META, GOAL_STATE_ORDER, slugify } from "./data";
import "../empty-state/empty-state.css";
import {
  listWorkspaces,
  getWorkspace,
  createWorkspace as apiCreateWorkspace,
  updateWorkspace as apiUpdateWorkspace,
  deleteWorkspace as apiDeleteWorkspace,
  inspectWorkspace,
  openEventStream,
  ApiError,
} from "../api";
import type { WorkspaceSummary, WorkspaceGoalView, Workspace, InspectWorkspacePreview } from "@orca/contracts";

interface WorkspacesPageProps {
  onCreateGoal: (workspace?: Workspace) => void;
  onOpenGoal?: (goal: WorkspaceGoalView) => void;
}

function formatAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffH = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffH < 1) return "<1h";
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export function WorkspacesPage({ onCreateGoal, onOpenGoal }: WorkspacesPageProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ workspace: Workspace; goals: WorkspaceGoalView[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);

  async function loadList() {
    const list = await listWorkspaces();
    setWorkspaces(list);
    setSelId((prev) => {
      if (prev && list.some((w) => w.id === prev)) return prev;
      return list[0]?.id ?? null;
    });
  }

  useEffect(() => {
    void loadList();
    const stream = openEventStream({
      onEvent(event) {
        if (event.type.startsWith("workspace.") || event.type.startsWith("goal.")) {
          void loadList();
        }
      },
      onStatus() {},
    });
    return () => stream.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selMissing = selId ? workspaces.find((w) => w.id === selId)?.exists === false : false;

  async function handleRemove(id: string) {
    await apiDeleteWorkspace(id);
    setDetail(null);
    await loadList();
  }

  useEffect(() => {
    if (!selId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    getWorkspace(selId).then((res) => {
      if (!cancelled) setDetail(res);
    }).catch(() => {
      if (!cancelled) setDetail(null);
    });
    return () => { cancelled = true; };
  }, [selId]);

  if (!workspaces.length && !creating) {
    return <EmptyWorkspacesView onCreate={() => setCreating(true)} />;
  }

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", minHeight: 0, position: "relative" }}>
      {/* ── Workspace list ── */}
      <div
        style={{
          width: 268,
          flexShrink: 0,
          borderRight: "1px solid var(--hairline)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "var(--panel)",
        }}
      >
        <div style={{ padding: "16px 16px 10px" }}>
          <div
            className="mono"
            style={{ fontSize: 10.5, color: "var(--text-3)", letterSpacing: 1.2, textTransform: "uppercase" }}
          >
            local
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: -0.3 }}>Workspaces</h1>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
              {workspaces.length}
            </span>
            <div style={{ flex: 1 }} />
            <Tip label="New workspace" side="bottom">
              <Btn icon={<Icon.plus />} size="xs" onClick={() => setCreating(true)} title="New workspace" />
            </Tip>
          </div>
        </div>
        <div className="scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "2px 8px 8px" }}>
          {workspaces.map((ws) => (
            <WorkspaceRow
              key={ws.id}
              ws={ws}
              selected={ws.id === selId}
              onSelect={() => setSelId(ws.id)}
            />
          ))}
        </div>
      </div>

      {/* ── Selected workspace detail ── */}
      {detail && (
        <WorkspaceDetail
          ws={detail.workspace}
          goals={detail.goals}
          missing={selMissing}
          onOpenGoal={onOpenGoal}
          onCreateGoal={onCreateGoal}
          onManage={() => setEditing(true)}
          onRemove={() => handleRemove(detail.workspace.id)}
        />
      )}

      {editing && detail && (
        <WorkspaceEditModal
          ws={detail.workspace}
          onClose={() => setEditing(false)}
          onSave={async (patch) => {
            await apiUpdateWorkspace(detail.workspace.id, patch);
            await loadList();
            const updated = await getWorkspace(detail.workspace.id);
            setDetail(updated);
            setEditing(false);
          }}
        />
      )}

      {creating && (
        <WorkspaceCreateModal
          onClose={() => setCreating(false)}
          onCreate={async (inputPath, name, description) => {
            const ws = await apiCreateWorkspace({ inputPath, name, description });
            await loadList();
            setSelId(ws.id);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

const WORKSPACE_HINTS = [
  {
    title: "Point at a repo",
    body: "A workspace maps to one repository folder on your machine.",
  },
  {
    title: "Group your goals",
    body: "Every goal you create is scoped to its workspace.",
  },
  {
    title: "Local-first",
    body: "Orca reads the folder directly — nothing leaves your machine.",
  },
];

function EmptyWorkspacesView({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-goals">
      <div className="empty-goals-wash" aria-hidden="true" />
      <div className="empty-goals-inner">
        <EmptyWorkspacesMark />
        <h1 className="empty-goals-title">Create your first workspace.</h1>
        <p className="empty-goals-body">
          A workspace points Orca at a single repository folder. Add one to
          organize your goals and start coordinating agents against that
          codebase.
        </p>
        <div className="empty-goals-actions">
          <button type="button" className="empty-goals-btn" onClick={onCreate}>
            <Icon.folder size={14} />
            Add a folder
          </button>
        </div>

        <div className="empty-goals-hints">
          {WORKSPACE_HINTS.map((hint, i) => (
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

function EmptyWorkspacesMark() {
  return (
    <div className="empty-goals-mark">
      <svg viewBox="0 0 116 116" width="116" height="116" aria-hidden="true">
        <defs>
          <linearGradient id="empty-workspaces-ring" x1="0" y1="0" x2="1" y2="1">
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
          stroke="url(#empty-workspaces-ring)"
          strokeWidth="1.5"
          strokeDasharray="120 360"
        />
        <circle cx="58" cy="58" r="22" fill="var(--accent-soft)" />
      </svg>
      <div className="empty-goals-mark-center" style={{ color: "var(--accent)" }}>
        <Icon.workspace size={22} />
      </div>
    </div>
  );
}

function WorkspaceRow({
  ws,
  selected,
  onSelect,
}: {
  ws: WorkspaceSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const total = ws.goalCounts.active + ws.goalCounts.completed + ws.goalCounts.archived;
  const active = ws.goalCounts.active;
  return (
    <button
      onClick={onSelect}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "10px 10px",
        borderRadius: 9,
        marginBottom: 3,
        position: "relative",
        background: selected ? "rgba(255,255,255,0.05)" : "transparent",
        transition: "background 100ms ease",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.025)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      {selected && (
        <div
          style={{ position: "absolute", left: 0, top: 9, bottom: 9, width: 2, borderRadius: 2, background: "var(--accent)" }}
        />
      )}
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          flexShrink: 0,
          background: selected ? "var(--accent-soft)" : "var(--panel-2)",
          border: "1px solid " + (selected ? "var(--accent-line)" : "var(--hairline)"),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: selected ? "var(--accent)" : "var(--text-3)",
        }}
      >
        <Icon.workspace size={15} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: ws.exists ? "var(--text)" : "var(--text-2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {ws.name}
          </div>
          {!ws.exists && (
            <span
              className="mono"
              title="This folder no longer exists on disk"
              style={{
                flexShrink: 0,
                fontSize: 9,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                color: "var(--err)",
                border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)",
                borderRadius: 5,
                padding: "1px 5px",
              }}
            >
              Missing
            </span>
          )}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 1 }}>
          {total} goal{total !== 1 ? "s" : ""} · {active} active
        </div>
      </div>
    </button>
  );
}

// Shown when the selected workspace's folder is gone from disk. Offers a
// two-step confirm to purge the stale registration (cascades goal links).
function MissingWorkspaceBanner({
  path,
  goalCount,
  onRemove,
}: {
  path: string;
  goalCount: number;
  onRemove: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doRemove() {
    setRemoving(true);
    setError(null);
    try {
      await onRemove();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Remove failed");
      setRemoving(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 14px",
        marginBottom: 20,
        borderRadius: 11,
        background: "color-mix(in srgb, var(--err) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--err) 32%, transparent)",
      }}
    >
      <div style={{ flexShrink: 0, marginTop: 1, color: "var(--err)" }}>
        <Icon.folder size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          This workspace's folder no longer exists
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2, wordBreak: "break-all" }}>
          {path}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 6, lineHeight: 1.5 }}>
          {confirming
            ? `Permanently delete this workspace${goalCount > 0 ? `, its ${goalCount} goal${goalCount !== 1 ? "s" : ""},` : ""} and all their sessions? This can't be undone.`
            : "It won't appear when creating goals. Removing it permanently deletes the workspace and the goals that live only here."}
        </div>
        {error && (
          <span className="mono" style={{ display: "block", fontSize: 11, color: "var(--err)", marginTop: 6 }}>
            {error}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {confirming ? (
          <>
            <Btn kind="ghost" size="sm" onClick={() => setConfirming(false)} disabled={removing}>
              Cancel
            </Btn>
            <Btn kind="danger" size="sm" onClick={() => void doRemove()} disabled={removing}>
              {removing ? "Removing…" : "Confirm remove"}
            </Btn>
          </>
        ) : (
          <Btn kind="quiet" size="sm" onClick={() => setConfirming(true)}>
            Remove
          </Btn>
        )}
      </div>
    </div>
  );
}

function WorkspaceDetail({
  ws,
  goals,
  missing,
  onOpenGoal,
  onCreateGoal,
  onManage,
  onRemove,
}: {
  ws: Workspace;
  goals: WorkspaceGoalView[];
  missing: boolean;
  onOpenGoal?: (goal: WorkspaceGoalView) => void;
  onCreateGoal: (workspace?: Workspace) => void;
  onManage: () => void;
  onRemove: () => Promise<void>;
}) {
  const grouped = GOAL_STATE_ORDER
    .map((st) => ({ status: st, items: goals.filter((g) => g.status === st) }))
    .filter((grp) => grp.items.length > 0);

  return (
    <div className="scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 24px 28px" }}>
      {missing && <MissingWorkspaceBanner path={ws.path} goalCount={goals.length} onRemove={onRemove} />}
      {/* header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 24 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 11,
            flexShrink: 0,
            background: "var(--accent-soft)",
            border: "1px solid var(--accent-line)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--accent)",
          }}
        >
          <Icon.workspace size={21} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="mono"
            style={{ fontSize: 10.5, color: "var(--text-3)", letterSpacing: 1.2, textTransform: "uppercase" }}
          >
            workspace
          </div>
          <h1 style={{ margin: "3px 0 0", fontSize: 24, fontWeight: 600, letterSpacing: -0.4 }}>{ws.name}</h1>
          {ws.description && (
            <p style={{ margin: "7px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--text-2)", maxWidth: "64ch" }}>
              {ws.description}
            </p>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <Btn kind="quiet" size="sm" icon={<Icon.settings />} onClick={onManage}>
            Manage
          </Btn>
          <Btn kind="primary" size="sm" icon={<Icon.plus />} onClick={() => onCreateGoal(ws)}>
            New goal
          </Btn>
        </div>
      </div>

      {/* goals */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Icon.goal size={14} color="var(--text-3)" />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Goals in this workspace</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--text-4)" }}>
          {goals.length}
        </span>
      </div>

      {goals.length === 0 ? (
        <div style={{ padding: "28px 16px", textAlign: "center", border: "1px dashed var(--hairline-strong)", borderRadius: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>No goals here yet</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4, marginBottom: 12 }}>
            Create a goal scoped to {ws.name} to start coordinating agents.
          </div>
          <Btn kind="primary" size="sm" icon={<Icon.plus />} onClick={() => onCreateGoal(ws)}>
            New goal
          </Btn>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {grouped.map(({ status, items }) => (
            <div key={status}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: "var(--text-3)",
                    letterSpacing: 1.2,
                    textTransform: "uppercase",
                    fontWeight: 600,
                  }}
                >
                  {GOAL_STATE_META[status].label}
                </span>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>
                  {items.length}
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--hairline)" }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                {items.map((g) => (
                  <WorkspaceGoalCard key={g.id} g={g} onOpen={() => onOpenGoal?.(g)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceGoalCard({ g, onOpen }: { g: WorkspaceGoalView; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const meta = GOAL_STATE_META[g.status];
  const muted = g.status === "completed" || g.status === "archived";

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: "pointer",
        position: "relative",
        background: "var(--panel)",
        border: "1px solid " + (hover ? "var(--hairline-strong)" : "var(--hairline)"),
        borderRadius: 11,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        opacity: muted ? 0.82 : 1,
        transition: "border-color 110ms ease, transform 110ms ease",
        transform: hover ? "translateY(-1px)" : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
        <span style={{ width: 14, marginTop: 2, flexShrink: 0, display: "inline-flex", justifyContent: "center" }}>
          {g.status === "completed" ? (
            <Icon.check size={13} color="var(--run)" />
          ) : g.status === "archived" ? (
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-4)" }} />
          ) : (
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-3)" }} />
          )}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: "var(--text)",
              lineHeight: 1.35,
            }}
          >
            {g.title}
          </div>
          {g.description && (
            <div
              style={{
                fontSize: 12,
                color: "var(--text-3)",
                lineHeight: 1.45,
                marginTop: 4,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {g.description}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
            <Pill tone={meta.tone} size="xs">
              {meta.label}
            </Pill>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-4)" }}>
              {formatAge(g.createdAt)}
            </span>
          </div>
        </div>
        <span
          style={{
            flexShrink: 0,
            color: "var(--accent)",
            opacity: hover ? 1 : 0,
            transform: hover ? "none" : "translateX(-4px)",
            transition: "opacity 110ms ease, transform 110ms ease",
          }}
        >
          <Icon.arrowRight size={14} />
        </span>
      </div>

      {/* progress — active goals show live progress; a completed goal shows a full 100% bar */}
      {(g.status === "active" || g.status === "completed") && g.progress != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.round(g.progress * 100)}%`,
                height: "100%",
                background: g.status === "completed" ? "#3fb950" : "var(--accent)",
              }}
            />
          </div>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", width: 30, textAlign: "right" }}>
            {Math.round(g.progress * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}

// ── Manage workspace (edit name + description) ──
function WorkspaceEditModal({
  ws,
  onClose,
  onSave,
}: {
  ws: Workspace;
  onClose: () => void;
  onSave: (patch: { name?: string; description?: string }) => Promise<void>;
}) {
  const [name, setName] = useState(ws.name);
  const [desc, setDesc] = useState(ws.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = Boolean(name.trim());

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), description: desc.trim() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--hairline)" }}>
        <Icon.settings size={16} color="var(--accent)" />
        <div style={{ flex: 1 }}>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", letterSpacing: 1.2, textTransform: "uppercase" }}>
            Manage workspace
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{ws.name}</div>
        </div>
        <Btn icon={<Icon.close />} size="xs" onClick={onClose} title="Close" />
      </header>

      <div className="scroll" style={{ flex: 1, padding: 20, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            placeholder="Workspace name"
            style={inputStyle}
          />
        </Field>

        <Field label="Description" hint="What this workspace owns.">
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="What this workspace owns."
            rows={3}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
          />
        </Field>

        <Field label="Folder">
          <span
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              alignSelf: "flex-start",
              fontSize: 12,
              color: "var(--text-3)",
              padding: "7px 10px",
              borderRadius: 7,
              background: "var(--panel-2)",
              border: "1px solid var(--hairline)",
            }}
          >
            <Icon.folder size={13} color="var(--text-4)" />
            {ws.path}
          </span>
        </Field>

        {error && <span className="mono" style={{ fontSize: 11, color: "var(--err)" }}>{error}</span>}
      </div>

      <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--hairline)" }}>
        <Btn kind="ghost" size="sm" onClick={onClose}>
          Cancel
        </Btn>
        <div style={{ flex: 1 }} />
        <Btn kind="primary" size="sm" icon={<Icon.check />} onClick={() => void submit()} disabled={!valid || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Btn>
      </footer>
    </ModalShell>
  );
}

// ── Create workspace (browse for a folder, inspect, confirm) ──
function WorkspaceCreateModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (inputPath: string, name?: string, description?: string) => Promise<void>;
}) {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<InspectWorkspacePreview | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");

  // Native folder picker only works in Tauri; in a plain browser (dev:browser)
  // the Tauri IPC bridge is absent, so we fall back to a typed absolute path.
  const tauri = isTauri();

  async function inspectPath(path: string) {
    setInspecting(true);
    setInspectError(null);
    setPreview(null);
    try {
      const res = await inspectWorkspace({ inputPath: path });
      setInputPath(path);
      setPreview(res.preview);
      setName(res.preview.name);
    } catch (err) {
      setInspectError(err instanceof ApiError ? err.message : "Inspection failed");
    } finally {
      setInspecting(false);
    }
  }

  async function handleBrowse() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    await inspectPath(selected as string);
  }

  async function submit() {
    if (!inputPath || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onCreate(inputPath, name.trim() || undefined, desc.trim() || undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === "workspace_duplicate") {
        setSaveError("This folder has already been added.");
      } else {
        setSaveError(err instanceof ApiError ? err.message : "Create failed");
      }
      setSaving(false);
    }
  }

  const valid = Boolean(inputPath) && !inspecting;

  return (
    <ModalShell onClose={onClose}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--hairline)" }}>
        <Icon.folder size={16} color="var(--accent)" />
        <div style={{ flex: 1 }}>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", letterSpacing: 1.2, textTransform: "uppercase" }}>
            New workspace
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Choose a folder</div>
        </div>
        <Btn icon={<Icon.close />} size="xs" onClick={onClose} title="Close" />
      </header>

      <div className="scroll" style={{ flex: 1, padding: 20, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
        {tauri ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Btn kind="quiet" size="sm" icon={<Icon.folder />} onClick={() => void handleBrowse()} disabled={inspecting}>
              {inspecting ? "Inspecting…" : "Browse…"}
            </Btn>
            {preview && (
              <span className="mono" style={{ fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {preview.path}
              </span>
            )}
          </div>
        ) : (
          <Field label="Folder path" hint="absolute path">
            <div style={{ display: "flex", gap: 8 }}>
              <input
                autoFocus
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && pathInput.trim()) void inspectPath(pathInput.trim()); }}
                placeholder="/Users/you/projects/my-repo"
                style={inputStyle}
              />
              <Btn kind="quiet" size="sm" icon={<Icon.folder />} onClick={() => void inspectPath(pathInput.trim())} disabled={inspecting || !pathInput.trim()}>
                {inspecting ? "Inspecting…" : "Inspect"}
              </Btn>
            </div>
          </Field>
        )}

        {inspectError && (
          <span className="mono" style={{ fontSize: 11, color: "var(--err)" }}>{inspectError}</span>
        )}

        {preview && (
          <>
            <Field label="Workspace name">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                placeholder={preview.name}
                style={inputStyle}
              />
            </Field>

            <Field label="Description" hint="optional">
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="What this workspace owns."
                rows={2}
                style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
              />
            </Field>
          </>
        )}

        {saveError && (
          <span className="mono" style={{ fontSize: 11, color: "var(--err)" }}>{saveError}</span>
        )}
      </div>

      <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--hairline)" }}>
        <Btn kind="ghost" size="sm" onClick={onClose}>
          Cancel
        </Btn>
        <div style={{ flex: 1 }} />
        <Btn kind="primary" size="sm" icon={<Icon.check />} onClick={() => void submit()} disabled={!valid || saving}>
          {saving ? "Adding…" : "Add workspace"}
        </Btn>
      </footer>
    </ModalShell>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        background: "rgba(5,5,8,0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "float-in 160ms ease",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxHeight: "85%",
          background: "var(--panel)",
          border: "1px solid var(--hairline-strong)",
          borderRadius: 14,
          boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}
