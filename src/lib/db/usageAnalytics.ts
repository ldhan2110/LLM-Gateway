/**
 * db/usageAnalytics.ts — Read-only aggregation queries over `usage_history`
 * and `daily_usage_summary` extracted from route handlers.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/usage/analytics and /api/settings/export-json routes can delegate.
 * Read-only aggregation; no writes.
 *
 * Sliced out of #3500 (usage_history / daily_usage_summary cluster).
 */

import { getDbClient } from "./core";
import type { AnalyticsParams } from "./usageAnalytics/sources";

export { buildUnifiedSource, buildPresetUnifiedSource } from "./usageAnalytics/sources";
export type {
  AnalyticsParams,
  BuildUnifiedSourceOptions,
  UnifiedSourceResult,
} from "./usageAnalytics/sources";

// ---------------------------------------------------------------------------
// Analytics summary — /api/usage/analytics
// ---------------------------------------------------------------------------

export interface UsageSummaryRow {
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  uniqueModels: number;
  uniqueAccounts: number;
  uniqueApiKeys: number;
  successfulRequests: number;
  avgLatencyMs: number;
  firstRequest: string;
  lastRequest: string;
}

/**
 * Scalar summary over the unified source CTE.
 *
 * @param unifiedSource - Pre-built subquery string (UNION of raw + aggregated rows).
 * @param params        - Named params referenced inside `unifiedSource`.
 */
export async function getUsageSummary(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<UsageSummaryRow> {
  const db = getDbClient();
  const row = await db.get<UsageSummaryRow>(
    `
      SELECT
        COUNT(*) as totalRequests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COUNT(DISTINCT model) as uniqueModels,
        COUNT(DISTINCT connection_id) as uniqueAccounts,
        COUNT(DISTINCT COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''))) as uniqueApiKeys,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(MIN(timestamp), '') as firstRequest,
        COALESCE(MAX(timestamp), '') as lastRequest
      FROM ${unifiedSource} AS _u
    `,
    params
  );
  return (
    row ?? {
      totalRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      uniqueModels: 0,
      uniqueAccounts: 0,
      uniqueApiKeys: 0,
      successfulRequests: 0,
      avgLatencyMs: 0,
      firstRequest: "",
      lastRequest: "",
    }
  );
}

// ---------------------------------------------------------------------------

export interface DailyUsageRow {
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Daily request + token counts aggregated from the unified source CTE.
 */
export async function getDailyUsage(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<DailyUsageRow[]> {
  const db = getDbClient();
  return db.all<DailyUsageRow>(
    `
      SELECT
        DATE(timestamp) as date,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface DailyCostRow {
  date: string;
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * Per-day, per-provider, per-model token breakdown for cost calculation.
 */
export async function getDailyCostRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<DailyCostRow[]> {
  const db = getDbClient();
  return db.all<DailyCostRow>(
    `
      SELECT
        DATE(timestamp) as date,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
      FROM ${unifiedSource} AS _u
      GROUP BY DATE(timestamp), LOWER(provider), LOWER(model), serviceTier
      ORDER BY date ASC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface HeatmapRow {
  date: string;
  totalTokens: number;
}

/**
 * Per-day token totals for the activity heatmap.
 * Uses `usage_history` directly (not the unified CTE) since the heatmap has its
 * own independent time window and api_key filter.
 *
 * @param heatmapConditions - Array of SQL condition strings (combined with AND).
 * @param params            - Named params referenced inside the conditions.
 */
export async function getHeatmapRows(
  heatmapConditions: string[],
  params: AnalyticsParams
): Promise<HeatmapRow[]> {
  const db = getDbClient();
  return db.all<HeatmapRow>(
    `
      SELECT
        DATE(timestamp) as date,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM usage_history
      WHERE ${heatmapConditions.join(" AND ")}
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ModelUsageRow {
  model: string;
  provider: string;
  serviceTier: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
  lastUsed: string;
}

/**
 * Per-model usage aggregates from the unified source CTE.
 */
export async function getModelUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ModelUsageRow[]> {
  const db = getDbClient();
  return db.all<ModelUsageRow>(
    `
      SELECT
        LOWER(model) as model,
        LOWER(provider) as provider,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests,
        COALESCE(MAX(timestamp), '') as lastUsed
      FROM ${unifiedSource} AS _u
      GROUP BY LOWER(model), LOWER(provider), serviceTier
      ORDER BY requests DESC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ProviderCostRow {
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * Per-provider, per-model token breakdown for provider cost calculation.
 */
export async function getProviderCostRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ProviderCostRow[]> {
  const db = getDbClient();
  return db.all<ProviderCostRow>(
    `
      SELECT
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
      FROM ${unifiedSource} AS _u
      GROUP BY LOWER(provider), LOWER(model), serviceTier
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ProviderUsageRow {
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
}

/**
 * Per-provider usage aggregates from the unified source CTE.
 */
export async function getProviderUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ProviderUsageRow[]> {
  const db = getDbClient();
  return db.all<ProviderUsageRow>(
    `
      SELECT
        LOWER(provider) as provider,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests
      FROM ${unifiedSource} AS _u
      GROUP BY LOWER(provider)
      ORDER BY requests DESC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface AccountCostRow {
  account: string;
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * Per-account cost breakdown joined with provider_connections for display names.
 * Uses `usage_history` directly (JOIN requires real table, not a subquery alias).
 *
 * @param whereClause - SQL WHERE clause (may be empty string); column refs already
 *                      prefixed with `usage_history.` by the caller.
 * @param params      - Named params referenced inside `whereClause`.
 */
export async function getAccountCostRows(
  whereClause: string,
  params: AnalyticsParams
): Promise<AccountCostRow[]> {
  const db = getDbClient();
  return db.all<AccountCostRow>(
    `
      SELECT
        COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), NULLIF(c.name, ''), usage_history.connection_id, 'unknown') as account,
        LOWER(usage_history.provider) as provider,
        LOWER(usage_history.model) as model,
        COALESCE(NULLIF(usage_history.service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(usage_history.tokens_input), 0) as promptTokens,
        COALESCE(SUM(usage_history.tokens_output), 0) as completionTokens,
        COALESCE(SUM(usage_history.tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(usage_history.tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(usage_history.tokens_reasoning), 0) as reasoningTokens
      FROM usage_history
      LEFT JOIN provider_connections c ON c.id = usage_history.connection_id
      ${whereClause}
      GROUP BY account, LOWER(usage_history.provider), LOWER(usage_history.model), serviceTier
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface AccountUsageRow {
  account: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  lastUsed: string;
}

/**
 * Per-account usage aggregates joined with provider_connections for display names.
 *
 * @param whereClause - SQL WHERE clause (may be empty string); column refs already
 *                      prefixed with `usage_history.` by the caller.
 * @param params      - Named params referenced inside `whereClause`.
 */
export async function getAccountUsageRows(
  whereClause: string,
  params: AnalyticsParams
): Promise<AccountUsageRow[]> {
  const db = getDbClient();
  return db.all<AccountUsageRow>(
    `
      SELECT
        COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), NULLIF(c.name, ''), usage_history.connection_id, 'unknown') as account,
        COUNT(usage_history.id) as requests,
        COALESCE(SUM(usage_history.tokens_input), 0) as promptTokens,
        COALESCE(SUM(usage_history.tokens_output), 0) as completionTokens,
        COALESCE(SUM(usage_history.tokens_input + usage_history.tokens_output), 0) as totalTokens,
        COALESCE(AVG(usage_history.latency_ms), 0) as avgLatencyMs,
        COALESCE(MAX(usage_history.timestamp), '') as lastUsed
      FROM usage_history
      LEFT JOIN provider_connections c ON c.id = usage_history.connection_id
      ${whereClause}
      GROUP BY account
      ORDER BY requests DESC
      LIMIT 50
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ApiKeyUsageRow {
  apiKeyId: string | null;
  apiKeyGroupKey: string;
  provider: string;
  model: string;
  serviceTier: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/**
 * Per-API-key usage aggregates from usage_history.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export async function getApiKeyUsageRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): Promise<ApiKeyUsageRow[]> {
  const db = getDbClient();
  return db.all<ApiKeyUsageRow>(
    `
      SELECT
        NULLIF(api_key_id, '') as apiKeyId,
        COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown') as apiKeyGroupKey,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown'), NULLIF(api_key_id, ''), LOWER(provider), LOWER(model), serviceTier
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ServiceTierUsageRow {
  serviceTier: string;
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/**
 * Per-service-tier, per-provider, per-model usage aggregates.
 */
export async function getServiceTierUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ServiceTierUsageRow[]> {
  const db = getDbClient();
  return db.all<ServiceTierUsageRow>(
    `
      SELECT
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
      FROM ${unifiedSource} AS _u
      GROUP BY serviceTier, LOWER(provider), LOWER(model)
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ApiKeyMetadataRow {
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyGroupKey: string;
  lastUsed: string;
}

/**
 * Latest API key name + group key from usage_history for display metadata.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export async function getApiKeyMetadataRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): Promise<ApiKeyMetadataRow[]> {
  const db = getDbClient();
  return db.all<ApiKeyMetadataRow>(
    `
      SELECT
        NULLIF(api_key_id, '') as apiKeyId,
        NULLIF(api_key_name, '') as apiKeyName,
        COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown') as apiKeyGroupKey,
        MAX(timestamp) as lastUsed
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY NULLIF(api_key_id, ''), NULLIF(api_key_name, '')
      ORDER BY lastUsed DESC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface WeeklyPatternRow {
  dayOfWeek: string;
  days: number;
  requests: number;
  totalTokens: number;
}

/**
 * Day-of-week aggregates for the weekly activity pattern chart.
 */
export async function getWeeklyPatternRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<WeeklyPatternRow[]> {
  const db = getDbClient();
  return db.all<WeeklyPatternRow>(
    `
      SELECT
        dayOfWeek,
        COUNT(*) as days,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(totalTokens), 0) as totalTokens
      FROM (
        SELECT
          DATE(timestamp) as date,
          strftime('%w', timestamp) as dayOfWeek,
          COUNT(*) as requests,
          COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
        FROM ${unifiedSource} AS _u
        GROUP BY DATE(timestamp), strftime('%w', timestamp)
      )
      GROUP BY dayOfWeek
      ORDER BY dayOfWeek ASC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface PresetCostModelRow {
  model: string;
  provider: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * Per-model token breakdown for preset range cost calculation.
 * Uses a preset-specific unified source (may differ from the main query window).
 */
export async function getPresetCostModelRows(
  presetUnifiedSource: string,
  params: AnalyticsParams
): Promise<PresetCostModelRow[]> {
  const db = getDbClient();
  return db.all<PresetCostModelRow>(
    `
      SELECT
        LOWER(model) as model,
        LOWER(provider) as provider,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
      FROM ${presetUnifiedSource} AS _pu
      GROUP BY LOWER(model), LOWER(provider), serviceTier
    `,
    params
  );
}

// ---------------------------------------------------------------------------
// Endpoint dimension — ported from decolua/9router#152 (thanks @toanalien).
// Reads directly from usage_history (raw rows) so the unified CTE stays
// untouched; matches the pattern used by getAutoRoutingVariantBreakdown.
// ---------------------------------------------------------------------------

export interface EndpointUsageRow {
  endpoint: string;
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
  lastUsed: string;
}

export interface EndpointUsageParams {
  sinceIso?: string | null;
  untilIso?: string | null;
}

/**
 * Per-endpoint × provider × model usage aggregates from `usage_history`.
 * NULL endpoints fold into the 'unknown' bucket so legacy rows stay visible.
 *
 * Inspired by decolua/9router#152 (byEndpoint aggregation), reshaped for the
 * OmniRoute SQLite schema + analytics conventions.
 */
export async function getEndpointUsageRows(
  params: EndpointUsageParams = {}
): Promise<EndpointUsageRow[]> {
  const db = getDbClient();
  const conditions: string[] = [];
  const bind: unknown[] = [];
  if (params.sinceIso) {
    conditions.push("timestamp >= ?");
    bind.push(params.sinceIso);
  }
  if (params.untilIso) {
    conditions.push("timestamp <= ?");
    bind.push(params.untilIso);
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.all<EndpointUsageRow>(
    `
      SELECT
        COALESCE(NULLIF(endpoint, ''), 'unknown') as endpoint,
        LOWER(COALESCE(provider, 'unknown')) as provider,
        LOWER(COALESCE(model, 'unknown')) as model,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as promptTokens,
        COALESCE(SUM(tokens_output), 0) as completionTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
        COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
        COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests,
        COALESCE(MAX(timestamp), '') as lastUsed
      FROM usage_history
      ${whereSql}
      GROUP BY endpoint, LOWER(COALESCE(provider, 'unknown')), LOWER(COALESCE(model, 'unknown'))
      ORDER BY requests DESC
    `,
    ...bind
  );
}

// ---------------------------------------------------------------------------
// Export-JSON backup — /api/settings/export-json
// ---------------------------------------------------------------------------

/**
 * Returns all rows from `usage_history` for backup export.
 * Only called when `?includeHistory=true` is explicitly requested.
 */
export async function getAllUsageHistory(): Promise<Record<string, unknown>[]> {
  const db = getDbClient();
  return db.all("SELECT * FROM usage_history");
}

/**
 * Returns all rows from `domain_cost_history` for backup export.
 */
export async function getAllDomainCostHistory(): Promise<Record<string, unknown>[]> {
  const db = getDbClient();
  return db.all("SELECT * FROM domain_cost_history");
}

/**
 * Returns all rows from `domain_budgets` for backup export.
 */
export async function getAllDomainBudgets(): Promise<Record<string, unknown>[]> {
  const db = getDbClient();
  return db.all("SELECT * FROM domain_budgets");
}
