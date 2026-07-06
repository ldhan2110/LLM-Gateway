import { getDbClient } from "./core";

export interface CacheStatsEntry {
  provider: string;
  model?: string;
  compressionMode: string;
  cacheControlPresent: boolean;
  estimatedCacheHit: boolean;
  tokensSavedCompression: number;
  tokensSavedCaching: number;
  netSavings: number;
}

export interface CacheStatsSummary {
  totalRequests: number;
  avgNetSavings: number;
  cacheHitRate: number;
  byProvider: Record<string, { count: number; avgNetSavings: number; cacheHitRate: number }>;
}

export async function recordCacheStats(entry: CacheStatsEntry): Promise<void> {
  const db = getDbClient();

  const sql = `INSERT INTO compression_cache_stats (
    provider,
    model,
    compression_mode,
    cache_control_present,
    estimated_cache_hit,
    tokens_saved_compression,
    tokens_saved_caching,
    net_savings
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

  await db.run(
    sql,
    entry.provider,
    entry.model ?? "",
    entry.compressionMode,
    entry.cacheControlPresent ? 1 : 0,
    entry.estimatedCacheHit ? 1 : 0,
    entry.tokensSavedCompression,
    entry.tokensSavedCaching,
    entry.netSavings
  );
}

export async function getCacheStatsSummary(since?: Date): Promise<CacheStatsSummary> {
  const db = getDbClient();

  // Global aggregates
  const globalRow = since
    ? await db.get<{ totalRequests: number; avgNetSavings: number; cacheHitRate: number }>(
        `SELECT COUNT(*) as totalRequests, AVG(net_savings) as avgNetSavings, SUM(estimated_cache_hit) * 1.0 / COUNT(*) as cacheHitRate FROM compression_cache_stats WHERE created_at >= ?`,
        since.toISOString()
      )
    : await db.get<{ totalRequests: number; avgNetSavings: number; cacheHitRate: number }>(
        `SELECT COUNT(*) as totalRequests, AVG(net_savings) as avgNetSavings, SUM(estimated_cache_hit) * 1.0 / COUNT(*) as cacheHitRate FROM compression_cache_stats`
      );

  if (!globalRow || globalRow.totalRequests === 0) {
    return { totalRequests: 0, avgNetSavings: 0, cacheHitRate: 0, byProvider: {} };
  }

  // Per-provider aggregates
  const providerRows = since
    ? await db.all<{ provider: string; count: number; avgNetSavings: number; cacheHitRate: number }>(
        `SELECT provider, COUNT(*) as count, AVG(net_savings) as avgNetSavings, SUM(estimated_cache_hit) * 1.0 / COUNT(*) as cacheHitRate FROM compression_cache_stats WHERE created_at >= ? GROUP BY provider`,
        since.toISOString()
      )
    : await db.all<{
        provider: string;
        count: number;
        avgNetSavings: number;
        cacheHitRate: number;
      }>(
        `SELECT provider, COUNT(*) as count, AVG(net_savings) as avgNetSavings, SUM(estimated_cache_hit) * 1.0 / COUNT(*) as cacheHitRate FROM compression_cache_stats GROUP BY provider`
      );

  const byProvider: Record<string, { count: number; avgNetSavings: number; cacheHitRate: number }> =
    {};
  for (const row of providerRows) {
    byProvider[row.provider] = {
      count: row.count,
      avgNetSavings: row.avgNetSavings,
      cacheHitRate: row.cacheHitRate,
    };
  }

  return {
    totalRequests: globalRow.totalRequests,
    avgNetSavings: globalRow.avgNetSavings ?? 0,
    cacheHitRate: globalRow.cacheHitRate ?? 0,
    byProvider,
  };
}
