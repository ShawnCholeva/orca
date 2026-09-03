import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { MetricPeriod, MetricScope } from "@orca/contracts";
import { getTemplateMetricsDetail, getTemplateMetricsSummaries } from "./usecases.js";
import { getSampleDetail } from "./sample-detail.js";
import { getRunDetail, getRunSummaries } from "./runs-usecases.js";

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

  server.get("/v1/metrics/samples/:transitionId", async (request, reply) => {
    const { transitionId } = request.params as { transitionId: string };
    const sample = getSampleDetail(db, transitionId);
    if (!sample) { reply.status(404); return { error: { code: "not_found", message: "sample not found" } }; }
    return { sample };
  });
}
