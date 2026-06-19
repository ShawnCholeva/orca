// Local, seeded state for the Workspaces tab. No backend — a workspace is a
// single repo folder, and a goal belongs to a workspace when their repos
// intersect (membership is derived, never stored as a duplicate link).

export type GoalState = "active" | "paused" | "completed" | "abandoned";

export interface WorkspaceGoal {
  id: string;
  name: string;
  state: GoalState;
  progress: number; // 0..1
  age: string;
  repos: string[];
  sessions: number;
  summary: string;
}

export interface Workspace {
  id: string; // derived slug — also the uniqueness key
  name: string;
  org: string;
  desc: string;
  repos: string[];
}

export const GOAL_STATE_META: Record<GoalState, { label: string; tone: "run" | "warn" | "neutral" }> = {
  active: { label: "Active", tone: "run" },
  paused: { label: "Paused", tone: "warn" },
  completed: { label: "Completed", tone: "neutral" },
  abandoned: { label: "Abandoned", tone: "neutral" },
};

export const GOAL_STATE_ORDER: GoalState[] = ["active", "paused", "completed", "abandoned"];

export function slugify(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// A goal belongs to a workspace when any of its repos is one the workspace owns.
export function goalsInWorkspace(ws: Workspace, goals: WorkspaceGoal[]): WorkspaceGoal[] {
  const owned = new Set(ws.repos);
  return goals.filter((g) => g.repos.some((r) => owned.has(r)));
}

export const SEED_WORKSPACES: Workspace[] = [
  {
    id: "platform",
    name: "platform",
    org: "gravitas",
    desc: "Core backend — API, billing, auth, and the customer web app.",
    repos: ["platform/api", "platform/web", "platform/billing-svc", "platform/auth"],
  },
  {
    id: "edge",
    name: "edge",
    org: "gravitas",
    desc: "Edge workers, request routing, and the CDN cache layer.",
    repos: ["edge/worker"],
  },
  {
    id: "sdk",
    name: "sdk",
    org: "gravitas",
    desc: "Client SDKs for iOS and Android, plus shared codegen.",
    repos: ["sdk/ios", "sdk/android"],
  },
  {
    id: "infra",
    name: "infra",
    org: "gravitas",
    desc: "Observability, telemetry pipelines, and platform infrastructure.",
    repos: ["infra/otel"],
  },
  {
    id: "docs",
    name: "docs",
    org: "gravitas",
    desc: "Documentation site and the hybrid search index behind it.",
    repos: ["docs/site", "search/index"],
  },
];

export const SEED_GOALS: WorkspaceGoal[] = [
  {
    id: "g-stripe",
    name: "Migrate billing to Stripe v3",
    state: "active",
    progress: 0.58,
    age: "6d",
    repos: ["platform/api", "platform/web", "platform/billing-svc"],
    sessions: 4,
    summary:
      "Replace legacy /v1 billing endpoints with Stripe v3 SDK, preserve idempotency keys, run double-bookkeeping for one cycle, decommission v1 paths.",
  },
  {
    id: "g-rbac",
    name: "Replace RBAC with policy engine",
    state: "paused",
    progress: 0.21,
    age: "12d",
    repos: ["platform/auth", "platform/api"],
    sessions: 0,
    summary:
      "Retire hand-rolled RBAC checks in favor of a centralized policy engine with declarative rules, audit logging, and per-resource evaluation.",
  },
  {
    id: "g-cold",
    name: "Reduce cold-start P95 below 400ms",
    state: "active",
    progress: 0.74,
    age: "3d",
    repos: ["edge/worker", "platform/api"],
    sessions: 2,
    summary:
      "Cut p95 cold-start latency under 400ms by pre-warming edge workers, trimming the boot dependency graph, and caching compiled handlers.",
  },
  {
    id: "g-mobile",
    name: "Mobile SDK 4.0 release",
    state: "active",
    progress: 0.92,
    age: "21d",
    repos: ["sdk/ios", "sdk/android"],
    sessions: 1,
    summary:
      "Ship the 4.0 SDK for iOS and Android with a unified async API, smaller binary footprint, and a clean migration path off 3.x.",
  },
  {
    id: "g-obs",
    name: "Unified telemetry pipeline",
    state: "active",
    progress: 0.08,
    age: "1d",
    repos: ["infra/otel"],
    sessions: 0,
    summary:
      "Consolidate metrics, logs, and traces into a single OpenTelemetry pipeline with consistent sampling and one queryable backend.",
  },
  {
    id: "g-search",
    name: "Hybrid search MVP for docs",
    state: "completed",
    progress: 1,
    age: "34d",
    repos: ["docs/site", "search/index"],
    sessions: 0,
    summary:
      "Ship a hybrid keyword-plus-semantic search over the docs site, blending BM25 and vector recall behind a single ranked query.",
  },
  {
    id: "g-graphql",
    name: "Federate public API under GraphQL gateway",
    state: "abandoned",
    progress: 0.34,
    age: "58d",
    repos: ["platform/api", "edge/worker"],
    sessions: 0,
    summary:
      "Unify public REST endpoints behind a federated GraphQL gateway with a shared schema, stitched resolvers, and per-field auth.",
  },
];

// Folders shown by the create-workspace picker (a simulated ~/code listing).
export const FS_FOLDERS: string[] = [
  "web-app",
  "api-gateway",
  "billing-service",
  "auth-service",
  "edge-worker",
  "mobile-ios",
  "mobile-android",
  "design-system",
  "data-pipeline",
  "docs-site",
  "search-index",
  "growth-experiments",
  "internal-tools",
  "infra-terraform",
];
