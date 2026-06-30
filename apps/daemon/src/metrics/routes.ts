import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { MetricPeriod } from "@orca/contracts";
import { getTemplateMetricsDetail, getTemplateMetricsSummaries } from "./usecases.js";

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
    const detail = getTemplateMetricsDetail(db, templateId, period.data);
    if (!detail) {
      reply.status(404);
      return { error: { code: "template_not_found", message: `Template not found or has no runs: ${templateId}` } };
    }
    return { detail };
  });
}
