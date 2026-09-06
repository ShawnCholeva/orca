import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { MetricPeriod, MetricScope } from "@orca/contracts";
import { getTemplateMetricsDetail, getTemplateMetricsSummaries } from "./usecases.js";
import { listSessionIntervals } from "./sessions.js";
import { getSampleDetail } from "./sample-detail.js";
import { getRunDetail, getRunSummaries } from "./runs-usecases.js";
import { computeTimeseries } from "./timeseries.js";
import { TimeseriesId } from "@orca/contracts";

export interface MetricsRouteDeps { db: Database.Database }

export function registerMetricsRoutes(server: FastifyInstance, deps: MetricsRouteDeps): void {
  const { db } = deps;

  server.get("/v1/metrics/templates", async (request, reply) => {
    const period = MetricPeriod.safeParse((request.query as { period?: string }).period);
    if (!period.success) {
      reply.status(400);
      return { error: { code: "invalid_period", message: "period must be one of 24h, 7d, 30d" } };
    }
    return { summaries: getTemplateMetricsSummaries(db, period.data) };
  });

  server.get("/v1/metrics/templates/:templateId", async (request, reply) => {
    const period = MetricPeriod.safeParse((request.query as { period?: string }).period);
    if (!period.success) {
      reply.status(400);
      return { error: { code: "invalid_period", message: "period must be one of 24h, 7d, 30d" } };
    }
    const { templateId } = request.params as { templateId: string };
    const scopeParsed = MetricScope.safeParse((request.query as { scope?: string }).scope);
    const scope = scopeParsed.success ? scopeParsed.data : "current";
    const detail = getTemplateMetricsDetail(db, templateId, period.data, undefined, scope);
    if (!detail) {
      reply.status(404);
      return { error: { code: "template_not_found", message: `Template not found or has no runs: ${templateId}` } };
    }
    return { detail };
  });

  // The run-shaped read model: a run is a trace, a step run is a span. Distinct
  // from the per-template aggregate above, which cannot answer "how did THIS run
  // behave" — see docs/superpowers/specs/2026-09-02-run-trace-contract.md.
  server.get("/v1/metrics/runs", async (request) => {
    const raw = (request.query as { limit?: string }).limit;
    const parsed = raw === undefined ? 50 : Number(raw);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 200) : 50;
    return { runs: getRunSummaries(db, { limit }) };
  });

  server.get("/v1/metrics/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const detail = getRunDetail(db, runId);
    if (!detail) {
      reply.status(404);
      return { error: { code: "run_not_found", message: `Run not found: ${runId}` } };
    }
    return { detail };
  });

  // Curated series only — see the vocabulary note in contracts/metrics/timeseries.
  // An unknown id is a 400 rather than an empty series: a chart silently missing a
  // line is the failure mode this endpoint exists to avoid.
  server.get("/v1/metrics/timeseries", async (request, reply) => {
    const q = request.query as { series?: string; from?: string; to?: string };
    const parsed = (q.series ?? "").split(",").filter(Boolean).map((s) => TimeseriesId.safeParse(s));
    const unknown = (q.series ?? "").split(",").filter(Boolean)
      .filter((_, i) => !parsed[i]!.success);
    if (parsed.length === 0 || unknown.length > 0) {
      reply.status(400);
      return {
        error: {
          code: "invalid_series",
          message: unknown.length > 0
            ? `Unknown series: ${unknown.join(", ")}. Known: ${TimeseriesId.options.join(", ")}`
            : `series is required. Known: ${TimeseriesId.options.join(", ")}`,
        },
      };
    }
    const to = q.to ?? new Date().toISOString();
    // Default window: 30d, matching the rest of the metrics surface.
    const from = q.from ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) {
      reply.status(400);
      return { error: { code: "invalid_window", message: "from/to must be ISO timestamps" } };
    }
    return {
      timeseries: computeTimeseries(db, {
        ids: parsed.map((p) => p.success ? p.data : "session_started"),
        fromIso: from, toIso: to,
      }),
    };
  });

  // Session intervals overlapping a window. Facts, not a series: the desktop
  // samples them on the reader's own window and step.
  server.get("/v1/metrics/sessions", async (request, reply) => {
    const q = request.query as { from?: string; to?: string };
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) {
      reply.status(400);
      return { error: { code: "invalid_window", message: "from/to must be ISO timestamps" } };
    }
    return { sessions: listSessionIntervals(db, from, to) };
  });

  server.get("/v1/metrics/samples/:transitionId", async (request, reply) => {
    const { transitionId } = request.params as { transitionId: string };
    const sample = getSampleDetail(db, transitionId);
    if (!sample) { reply.status(404); return { error: { code: "not_found", message: "sample not found" } }; }
    return { sample };
  });
}
