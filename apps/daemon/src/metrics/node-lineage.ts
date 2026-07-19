import type Database from "better-sqlite3";
import type { NodeVersionHistory } from "@orca/contracts";

type NodeType = "step" | "gate";

interface SnapshotRow { template_version: number; template_snapshot_json: string | null }
interface VersionRunCountRow { template_version: number; cnt: number }
interface Observation { version: number; type: NodeType; name: string }

function isNodeType(t: string): t is NodeType {
  return t === "step" || t === "gate";
}

// Cross-version node lineage from per-run template snapshots. Orca renames nodes in
// place — the node id is stable across renames/type changes — so lineage is keyed
// by node id, not name. Resilient to malformed/absent snapshots (skip, never throw).
export function computeNodeLineage(
  db: Database.Database,
  templateId: string,
  sinceIso: string,
  untilIso: string
): Map<string, NodeVersionHistory> {
  const snapshotRows = db.prepare(
    `SELECT DISTINCT template_version, template_snapshot_json FROM workflow_runs
     WHERE template_id = ? AND started_at >= ? AND started_at < ? ORDER BY template_version`
  ).all(templateId, sinceIso, untilIso) as SnapshotRow[];

  const runCountRows = db.prepare(
    `SELECT template_version, COUNT(*) as cnt FROM workflow_runs
     WHERE template_id = ? AND started_at >= ? AND started_at < ? GROUP BY template_version`
  ).all(templateId, sinceIso, untilIso) as VersionRunCountRow[];
  const runsByVersion = new Map(runCountRows.map((r) => [r.template_version, r.cnt]));

  const observationsById = new Map<string, Observation[]>();
  for (const row of snapshotRows) {
    if (!row.template_snapshot_json) continue;
    let snapshot: { graph?: { nodes?: { id: string; type: string; name?: string }[] } };
    try {
      snapshot = JSON.parse(row.template_snapshot_json);
    } catch {
      continue;
    }
    const nodes = snapshot?.graph?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const n of nodes) {
      if (!n || typeof n.id !== "string" || !isNodeType(n.type)) continue;
      const list = observationsById.get(n.id) ?? observationsById.set(n.id, []).get(n.id)!;
      list.push({ version: row.template_version, type: n.type, name: n.name ?? n.id });
    }
  }

  const lineage = new Map<string, NodeVersionHistory>();
  for (const [nodeId, obsUnsorted] of observationsById) {
    const obs = [...obsUnsorted].sort((a, b) => a.version - b.version);
    if (obs.length === 0) continue;

    const earliest = obs[0];
    const latest = obs[obs.length - 1];
    const changedFrom = earliest.type !== latest.type ? earliest.type : undefined;

    // Most-recent prior name that differs from the current (latest) name.
    let renamedFrom: string | undefined;
    for (let i = obs.length - 2; i >= 0; i--) {
      if (obs[i].name !== latest.name) { renamedFrom = obs[i].name; break; }
    }

    // Contiguous same-type spans (by observation order), summing run counts.
    const eras: NodeVersionHistory["eras"] = [];
    for (const o of obs) {
      const runs = runsByVersion.get(o.version) ?? 0;
      const last = eras[eras.length - 1];
      if (last && last.type === o.type) {
        last.toVersion = o.version;
        last.runs += runs;
      } else {
        eras.push({ type: o.type, fromVersion: o.version, toVersion: o.version, runs });
      }
    }

    if (changedFrom === undefined && renamedFrom === undefined && eras.length <= 1) continue;
    lineage.set(nodeId, { changedFrom, renamedFrom, eras });
  }
  return lineage;
}
