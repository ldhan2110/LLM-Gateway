/**
 * db/usageLogs.ts — Read-only aggregation queries over `usage_logs`
 * extracted from the /api/analytics/auto-routing route handler.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/analytics/auto-routing route can delegate.
 *
 * Sliced out of #3500 (usage_logs cluster, slice 4).
 */

import { getDbClient } from "./core";

// ---------------------------------------------------------------------------
// Auto-routing analytics
// ---------------------------------------------------------------------------

export interface AutoRoutingTotalResult {
  count: number;
}

/**
 * Returns the total number of requests routed through auto/ prefix models.
 * Matches model = 'auto' OR model LIKE 'auto/%'.
 */
export async function getAutoRoutingTotalCount(): Promise<AutoRoutingTotalResult> {
  const db = getDbClient();
  const row = await db.get<AutoRoutingTotalResult>(
    `
      SELECT COUNT(*) as count
      FROM usage_logs
      WHERE model = 'auto' OR model LIKE 'auto/%'
    `
  );
  return row ?? { count: 0 };
}

export interface AutoRoutingVariantRow {
  variant: string;
  count: number;
}

/**
 * Returns per-variant request counts for auto/ prefix models.
 * Variant is derived from the model name:
 *   'auto'      → 'default'
 *   'auto/X'    → 'X'
 *   other       → 'other' (should not occur given the WHERE clause)
 */
export async function getAutoRoutingVariantBreakdown(): Promise<AutoRoutingVariantRow[]> {
  const db = getDbClient();
  return db.all<AutoRoutingVariantRow>(
    `
      SELECT
        CASE
          WHEN model = 'auto' THEN 'default'
          WHEN model LIKE 'auto/%' THEN SUBSTR(model, 6)
          ELSE 'other'
        END as variant,
        COUNT(*) as count
      FROM usage_logs
      WHERE model = 'auto' OR model LIKE 'auto/%'
      GROUP BY variant
      ORDER BY count DESC
    `
  );
}

export interface AutoRoutingTopProviderRow {
  provider: string;
  count: number;
}

/**
 * Returns the top 10 providers used for auto/ prefix model requests.
 */
export async function getAutoRoutingTopProviders(): Promise<AutoRoutingTopProviderRow[]> {
  const db = getDbClient();
  return db.all<AutoRoutingTopProviderRow>(
    `
      SELECT provider, COUNT(*) as count
      FROM usage_logs
      WHERE model = 'auto' OR model LIKE 'auto/%'
      GROUP BY provider
      ORDER BY count DESC
      LIMIT 10
      `
  );
}
