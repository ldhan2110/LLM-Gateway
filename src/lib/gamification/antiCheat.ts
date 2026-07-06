/**
 * Anti-cheat system — server-side validation and anomaly detection.
 *
 * @module lib/gamification/antiCheat
 */

import { getDbClient } from "../db/core";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScoreValidation {
  allowed: boolean;
  reason?: string;
}

interface AnomalyFlag {
  apiKeyId: string;
  xpLastHour: number;
  zScore: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const MAX_XP_PER_WINDOW = 1000;
const ANOMALY_Z_THRESHOLD = 3;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate a score change. Returns true if allowed, false if suspicious.
 */
export async function validateScoreChange(
  apiKeyId: string,
  _action: string,
  amount: number
): Promise<ScoreValidation> {
  // Rate limiting: max XP per window
  const recentXp = await getRecentXp(apiKeyId, RATE_LIMIT_WINDOW_MS);
  if (recentXp + amount > MAX_XP_PER_WINDOW) {
    return {
      allowed: false,
      reason: `Rate limit exceeded: ${recentXp + amount} > ${MAX_XP_PER_WINDOW} XP/min`,
    };
  }

  // Anomaly detection: check if this user's XP velocity is abnormal
  const isAnomaly = await detectAnomaly(apiKeyId);
  if (isAnomaly) {
    return { allowed: false, reason: "Anomalous XP velocity detected" };
  }

  return { allowed: true };
}

/**
 * Get flagged anomalies for admin review.
 */
export async function getAnomalies(): Promise<AnomalyFlag[]> {
  const db = getDbClient();

  const rows = await db.all<{ api_key_id: string; hourly_total: number }>(
    `SELECT api_key_id, SUM(xp_earned) AS hourly_total
       FROM xp_audit_log
       WHERE created_at > datetime('now', '-1 hour')
       GROUP BY api_key_id
       HAVING hourly_total > 1000`
  );

  const results: AnomalyFlag[] = [];
  for (const r of rows) {
    const z = await computeZScore(r.api_key_id);
    results.push({
      apiKeyId: r.api_key_id,
      xpLastHour: r.hourly_total,
      zScore: z ?? 0,
    });
  }
  return results;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Compute the z-score for a user's hourly XP against the global distribution.
 * Returns null if insufficient data.
 */
async function computeZScore(apiKeyId: string): Promise<number | null> {
  const db = getDbClient();

  const userRow = await db.get<{ total: number }>(
    `SELECT COALESCE(SUM(xp_earned), 0) AS total
       FROM xp_audit_log
       WHERE api_key_id = ? AND created_at > datetime('now', '-1 hour')`,
    apiKeyId
  );

  const statsRow = await db.get<{ mean: number; variance: number }>(
    `SELECT AVG(hourly_total) AS mean,
              CASE WHEN AVG(hourly_total) = 0 THEN 1
                   ELSE AVG(hourly_total * hourly_total) - AVG(hourly_total) * AVG(hourly_total)
              END AS variance
       FROM (
         SELECT api_key_id, SUM(xp_earned) AS hourly_total
         FROM xp_audit_log
         WHERE created_at > datetime('now', '-1 hour')
         GROUP BY api_key_id
       )`
  );

  if (!statsRow || statsRow.variance <= 0) return null;
  if (!userRow) return null;

  const stdDev = Math.sqrt(statsRow.variance);
  return (userRow.total - statsRow.mean) / stdDev;
}

/**
 * Get total XP earned in the last N milliseconds.
 */
async function getRecentXp(apiKeyId: string, windowMs: number): Promise<number> {
  const db = getDbClient();
  const since = new Date(Date.now() - windowMs).toISOString();

  const row = await db.get<{ total: number }>(
    "SELECT COALESCE(SUM(xp_earned), 0) AS total FROM xp_audit_log WHERE api_key_id = ? AND created_at > ?",
    apiKeyId,
    since
  );

  return row?.total ?? 0;
}

/**
 * Detect anomalous XP velocity using z-score.
 */
async function detectAnomaly(apiKeyId: string): Promise<boolean> {
  const z = await computeZScore(apiKeyId);
  return z !== null && z > ANOMALY_Z_THRESHOLD;
}
