import { getDbClient } from "./core";

/**
 * Provider/model call statistics aggregated from `call_logs`.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/provider-stats route can delegate. Read-only aggregation; no writes.
 */

export interface ProviderCallStat {
  provider: string;
  nodeName: string | null;
  totalRequests: number;
  successfulRequests: number;
  avgLatencyMs: number | null;
  totalTokensIn: number | null;
  totalTokensOut: number | null;
}

export interface ModelCallStat {
  provider: string;
  nodeName: string | null;
  model: string;
  requests: number;
  avgLatencyMs: number | null;
  successfulRequests: number;
}

export async function getProviderCallStats(): Promise<ProviderCallStat[]> {
  const db = getDbClient();
  return db.all<ProviderCallStat>(
    `SELECT
       c.provider,
       pn.name AS nodeName,
       COUNT(*) AS totalRequests,
       SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END) AS successfulRequests,
       ROUND(AVG(c.duration)) AS avgLatencyMs,
       SUM(c.tokens_in) AS totalTokensIn,
       SUM(c.tokens_out) AS totalTokensOut
     FROM call_logs c
     LEFT JOIN provider_nodes pn ON pn.id = c.provider
     WHERE c.provider IS NOT NULL AND c.provider != '-'
     GROUP BY c.provider
     ORDER BY totalRequests DESC`
  );
}

export async function getModelCallStats(): Promise<ModelCallStat[]> {
  const db = getDbClient();
  return db.all<ModelCallStat>(
    `SELECT
       c.provider,
       pn.name AS nodeName,
       c.model,
       COUNT(*) AS requests,
       ROUND(AVG(c.duration)) AS avgLatencyMs,
       SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END) AS successfulRequests
     FROM call_logs c
     LEFT JOIN provider_nodes pn ON pn.id = c.provider
     WHERE c.provider IS NOT NULL AND c.model IS NOT NULL
     GROUP BY c.provider, c.model
     ORDER BY c.provider, requests DESC`
  );
}
