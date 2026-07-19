import type { PipelineNode } from "@orca/contracts";

export function buildPipeline(graphJson: string | null): PipelineNode[] | undefined {
  if (!graphJson) return undefined;
  let graph: { nodes?: { id: string; type: string; name?: string }[]; edges?: { from: string; to: string }[] };
  try { graph = JSON.parse(graphJson); } catch { return undefined; }
  const nodes = graph.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const norm = (t: string): "step" | "gate" | "splitter" => (t === "gate" ? "gate" : t === "splitter" ? "splitter" : "step");
  return nodes.map((n) => {
    const base: PipelineNode = { nodeId: n.id, name: n.name ?? n.id, type: norm(n.type) };
    if (n.type === "gate") {
      const from = edges.find((e) => e.to === n.id)?.from;
      const gi = idx.get(n.id) ?? -1;
      const to = edges.filter((e) => e.from === n.id && (idx.get(e.to) ?? -1) > gi)
        .sort((a, b) => (idx.get(b.to)! - idx.get(a.to)!))[0]?.to;
      return from && to ? { ...base, guards: { from, to } } : base;
    }
    if (n.type === "splitter") {
      const branchesTo = edges.filter((e) => e.from === n.id).map((e) => e.to);
      return branchesTo.length ? { ...base, branchesTo } : base;
    }
    return base;
  });
}
