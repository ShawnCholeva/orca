// Workspaces tab — a repo-scoped home for goals. Left: the workspace list.
// Right: the selected workspace's profile plus every goal whose repos touch it,
// grouped by state. Ported from the design prototype's view-workspaces.jsx;
// workspaces live in local state (no backend) and seed a fixed list.

import { useState } from "react";
import { Icon } from "./icons";
import { Btn, Pill, Tip, Field, inputStyle } from "./primitives";
import {
  GOAL_STATE_META,
  GOAL_STATE_ORDER,
  SEED_WORKSPACES,
  SEED_GOALS,
  FS_FOLDERS,
  slugify,
  goalsInWorkspace,
  type Workspace,
  type WorkspaceGoal,
} from "./data";

interface WorkspacesPageProps {
  onCreateGoal: () => void;
  onOpenGoal?: (goal: WorkspaceGoal) => void;
}

// Preview the empty state without wiping the seed list: ?workspaces=empty or a
// window flag the harness can set.
function forceEmptyWorkspaces(): boolean {
  if (typeof window === "undefined") return false;
  if ((window as unknown as { __forceEmptyWorkspaces?: boolean }).__forceEmptyWorkspaces) return true;
  return new URLSearchParams(window.location.search).get("workspaces") === "empty";
}

export function WorkspacesPage({ onCreateGoal, onOpenGoal }: WorkspacesPageProps) {
  const goals = SEED_GOALS;
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() =>
    forceEmptyWorkspaces() ? [] : SEED_WORKSPACES,
  );
  const [selId, setSelId] = useState<string | null>(workspaces[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const selected = workspaces.find((w) => w.id === selId) ?? workspaces[0] ?? null;

  function addWorkspace(ws: Workspace) {
    setWorkspaces((list) => [...list, ws]);
    setSelId(ws.id);
    setCreating(false);
  }

  function updateWorkspace(id: string, patch: Partial<Workspace>) {
    setWorkspaces((list) => list.map((w) => (w.id === id ? { ...w, ...patch } : w)));
    setEditing(false);
  }

  if (!workspaces.length && !creating) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 15,
              marginBottom: 20,
              background: "var(--accent-soft)",
              border: "1px solid var(--accent-line)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--accent)",
            }}
          >
            <Icon.workspace size={26} />
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: -0.4 }}>Create your first workspace</h1>
          <p style={{ margin: "10px 0 22px", fontSize: 13.5, lineHeight: 1.6, color: "var(--text-2)" }}>
            A workspace points Orca at a single repository folder. Add one to organize your goals and start coordinating
            agents against that codebase.
          </p>
          <Btn kind="primary" size="md" icon={<Icon.folder />} onClick={() => setCreating(true)}>
            Add a folder
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, position: "relative" }}>
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
            {selected?.org ?? "local"}
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
              goals={goals}
              selected={ws.id === selId}
              onSelect={() => setSelId(ws.id)}
            />
          ))}
        </div>
      </div>

      {/* ── Selected workspace detail ── */}
      {selected && (
        <WorkspaceDetail
          ws={selected}
          goals={goalsInWorkspace(selected, goals)}
          onOpenGoal={onOpenGoal}
          onCreateGoal={onCreateGoal}
          onManage={() => setEditing(true)}
        />
      )}

      {editing && selected && (
        <WorkspaceEditModal
          ws={selected}
          existing={workspaces}
          onClose={() => setEditing(false)}
          onSave={(patch) => updateWorkspace(selected.id, patch)}
        />
      )}

      {creating && (
        <WorkspaceCreateModal existing={workspaces} onClose={() => setCreating(false)} onCreate={addWorkspace} />
      )}
    </div>
  );
}

function WorkspaceRow({
  ws,
  goals,
  selected,
  onSelect,
}: {
  ws: Workspace;
  goals: WorkspaceGoal[];
  selected: boolean;
  onSelect: () => void;
}) {
  const wgoals = goalsInWorkspace(ws, goals);
  const live = wgoals.reduce((n, g) => n + g.sessions, 0);
  const active = wgoals.filter((g) => g.state === "active").length;
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
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {ws.name}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 1 }}>
          {wgoals.length} goal{wgoals.length !== 1 ? "s" : ""}
          {active > 0 ? ` · ${active} active` : ""}
        </div>
      </div>
      {live > 0 && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          <span
            style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--run)", boxShadow: "0 0 0 3px var(--run-soft)" }}
          />
          <span className="mono" style={{ fontSize: 10.5, color: "var(--run)" }}>
            {live}
          </span>
        </span>
      )}
    </button>
  );
}

function WorkspaceDetail({
  ws,
  goals,
  onOpenGoal,
  onCreateGoal,
  onManage,
}: {
  ws: Workspace;
  goals: WorkspaceGoal[];
  onOpenGoal?: (goal: WorkspaceGoal) => void;
  onCreateGoal: () => void;
  onManage: () => void;
}) {
  const grouped = GOAL_STATE_ORDER.map((st) => ({ state: st, items: goals.filter((g) => g.state === st) })).filter(
    (grp) => grp.items.length > 0,
  );

  return (
    <div className="scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 24px 28px" }}>
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
            {ws.org} / workspace
          </div>
          <h1 style={{ margin: "3px 0 0", fontSize: 24, fontWeight: 600, letterSpacing: -0.4 }}>{ws.name}</h1>
          <p style={{ margin: "7px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--text-2)", maxWidth: "64ch" }}>
            {ws.desc}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <Btn kind="quiet" size="sm" icon={<Icon.settings />} onClick={onManage}>
            Manage
          </Btn>
          <Btn kind="primary" size="sm" icon={<Icon.plus />} onClick={onCreateGoal}>
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
          <Btn kind="primary" size="sm" icon={<Icon.plus />} onClick={onCreateGoal}>
            New goal
          </Btn>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {grouped.map(({ state, items }) => (
            <div key={state}>
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
                  {GOAL_STATE_META[state].label}
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

function WorkspaceGoalCard({ g, onOpen }: { g: WorkspaceGoal; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const meta = GOAL_STATE_META[g.state];
  const live = g.sessions > 0;
  const muted = g.state === "abandoned" || g.state === "completed";

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
          {live ? (
            <span
              style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--run)", boxShadow: "0 0 0 3px var(--run-soft)" }}
            />
          ) : g.state === "completed" ? (
            <Icon.check size={13} color="var(--run)" />
          ) : g.state === "paused" ? (
            <Icon.pause size={11} color="var(--warn)" />
          ) : g.state === "abandoned" ? (
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
              textDecoration: g.state === "abandoned" ? "line-through" : "none",
              textDecorationColor: "var(--text-4)",
            }}
          >
            {g.name}
          </div>
          {g.summary && (
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
              {g.summary}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
            <Pill tone={meta.tone} dot={live} size="xs">
              {meta.label}
            </Pill>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-4)" }}>
              {g.age}
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

      {/* progress (only for in-flight goals) */}
      {g.state !== "completed" && g.state !== "abandoned" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${Math.round(g.progress * 100)}%`, height: "100%", background: "var(--accent)" }} />
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
  existing,
  onClose,
  onSave,
}: {
  ws: Workspace;
  existing: Workspace[];
  onClose: () => void;
  onSave: (patch: Partial<Workspace>) => void;
}) {
  const [name, setName] = useState(ws.name);
  const [desc, setDesc] = useState(ws.desc === "No description yet." ? "" : ws.desc);

  const slug = slugify(name);
  const taken = new Set(existing.filter((w) => w.id !== ws.id).map((w) => w.id));
  const dupe = Boolean(slug) && taken.has(slug);
  const valid = Boolean(name.trim()) && !dupe;

  function submit() {
    if (!valid) return;
    onSave({ name: name.trim(), desc: desc.trim() || "No description yet." });
  }

  const repo = ws.repos[0] ?? "—";

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
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Workspace name"
            style={{ ...inputStyle, borderColor: dupe ? "var(--warn)" : "var(--hairline)" }}
          />
          {dupe && (
            <span className="mono" style={{ fontSize: 11, color: "var(--warn)" }}>{`“${slug}” already exists`}</span>
          )}
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
            {repo}
          </span>
        </Field>
      </div>

      <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--hairline)" }}>
        <Btn kind="ghost" size="sm" onClick={onClose}>
          Cancel
        </Btn>
        <div style={{ flex: 1 }} />
        <Btn kind="primary" size="sm" icon={<Icon.check />} onClick={submit} disabled={!valid}>
          Save changes
        </Btn>
      </footer>
    </ModalShell>
  );
}

// ── Create workspace (pick a folder) ──
// A workspace is a single repo folder. Pick one; optionally override its name.
function WorkspaceCreateModal({
  existing,
  onClose,
  onCreate,
}: {
  existing: Workspace[];
  onClose: () => void;
  onCreate: (ws: Workspace) => void;
}) {
  const taken = new Set(existing.map((w) => w.id));
  const folders = FS_FOLDERS.map((name) => ({ name, path: `~/code/${name}`, added: taken.has(slugify(name)) }));

  const [sel, setSel] = useState<{ name: string; path: string } | null>(null);
  const [name, setName] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [desc, setDesc] = useState("");

  // name defaults to the folder name until the user overrides it
  const effectiveName = touchedName ? name : sel ? sel.name : "";
  const slug = slugify(effectiveName);
  const dupe = Boolean(slug) && taken.has(slug);
  const valid = Boolean(sel) && Boolean(slug) && !dupe;

  function pick(f: { name: string; path: string; added: boolean }) {
    if (f.added) return;
    setSel({ name: f.name, path: f.path });
    if (!touchedName) setName("");
  }

  function submit() {
    if (!valid || !sel) return;
    onCreate({
      id: slug,
      name: effectiveName.trim(),
      org: "local",
      desc: desc.trim() || "No description yet.",
      repos: [sel.path],
    });
  }

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

      {/* path bar */}
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 16px",
          fontSize: 11.5,
          color: "var(--text-3)",
          borderBottom: "1px solid var(--hairline)",
          background: "var(--panel-2)",
        }}
      >
        <Icon.folder size={12} color="var(--text-4)" />
        ~/code
      </div>

      <div className="scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 6 }}>
        {folders.map((f) => {
          const on = sel?.name === f.name;
          return (
            <button
              key={f.name}
              disabled={f.added}
              onClick={() => pick(f)}
              onDoubleClick={() => {
                if (!f.added) {
                  setSel({ name: f.name, path: f.path });
                  setTimeout(submit, 0);
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "8px 9px",
                borderRadius: 7,
                marginBottom: 2,
                cursor: f.added ? "default" : "pointer",
                background: on ? "var(--accent-soft)" : "transparent",
                border: "none",
                fontFamily: "inherit",
                textAlign: "left",
                opacity: f.added ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (!on && !f.added) e.currentTarget.style.background = "rgba(255,255,255,0.04)";
              }}
              onMouseLeave={(e) => {
                if (!on) e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon.folder size={15} color={on ? "var(--accent)" : "var(--text-3)"} />
              <span
                className="mono"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  color: on ? "var(--text)" : "var(--text-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {f.name}
              </span>
              {f.added && (
                <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: 0.6 }}>
                  Added
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* optional name override — appears once a folder is chosen */}
      {sel && (
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--hairline)", display: "flex", flexDirection: "column", gap: 6 }}>
          <label className="mono" style={{ fontSize: 10, color: "var(--text-3)", letterSpacing: 1, textTransform: "uppercase" }}>
            Workspace name
          </label>
          <input
            value={effectiveName}
            onChange={(e) => {
              setTouchedName(true);
              setName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={sel.name}
            style={{ ...inputStyle, borderColor: dupe ? "var(--warn)" : "var(--hairline)" }}
          />
          <span className="mono" style={{ fontSize: 11, color: dupe ? "var(--warn)" : "var(--text-4)" }}>
            {dupe ? `“${slug}” already exists` : sel.path}
          </span>
          <label
            className="mono"
            style={{ fontSize: 10, color: "var(--text-3)", letterSpacing: 1, textTransform: "uppercase", marginTop: 4 }}
          >
            Description{" "}
            <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-4)" }}>· optional</span>
          </label>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="What this workspace owns."
            rows={2}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
          />
        </div>
      )}

      <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--hairline)" }}>
        <Btn kind="ghost" size="sm" onClick={onClose}>
          Cancel
        </Btn>
        <div style={{ flex: 1 }} />
        <Btn kind="primary" size="sm" icon={<Icon.check />} onClick={submit} disabled={!valid}>
          Add workspace
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
