// workspace-context.ts
// Assembles workspace metadata into a budget-bounded context block for step input payloads.

export interface WorkspaceContextInput {
  workspaces: Array<{ id: string; name: string; root: string }>;
  summaries: Array<{ workspaceId: string; summary: string }>;
  snippets: Array<{ path: string; excerpt: string }>;
  payloadBudget: number;
}

export interface WorkspaceContextOutput {
  workspaces: Array<{ id: string; name: string; root: string }>;
  summaries: Array<{ workspaceId: string; summary: string }>;
  snippets: Array<{ path: string; excerpt: string }>;
}

export function assembleWorkspaceContext(input: WorkspaceContextInput): WorkspaceContextOutput {
  const out: WorkspaceContextOutput = {
    workspaces: input.workspaces.slice(0, 8),
    summaries: input.summaries
      .slice(0, 8)
      .map((s) => ({ workspaceId: s.workspaceId, summary: s.summary.slice(0, 2048) })),
    snippets: input.snippets
      .slice(0, 8)
      .map((s) => ({ path: s.path.slice(0, 256), excerpt: s.excerpt.slice(0, 1024) })),
  };

  while (Buffer.byteLength(JSON.stringify(out), "utf8") > input.payloadBudget) {
    if (out.snippets.length > 0) {
      out.snippets.pop();
      continue;
    }
    if (out.summaries.length > 0) {
      const s = out.summaries[out.summaries.length - 1]!;
      if (s.summary.length > 128) {
        s.summary = s.summary.slice(0, Math.max(128, Math.floor(s.summary.length * 0.5)));
      } else {
        out.summaries.pop();
      }
      continue;
    }
    if (out.workspaces.length > 0) {
      out.workspaces.pop();
      continue;
    }
    break;
  }

  return out;
}
