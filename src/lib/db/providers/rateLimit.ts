/**
 * db/providers/rateLimit.ts — Rate-limit/quota runtime helpers for provider_connections.
 */

import { getDbClient } from "../core";
import { invalidateDbCache } from "../readCache";

// ──────────────── T05: Rate-Limit DB Persistence ──────────────────────────
// Allows rate-limit state to survive token refresh without being accidentally
// cleared. DB column rate_limited_until already exists in schema.
// Ref: sub2api PR #1218 (fix(openai): prevent rescheduling rate-limited accounts)

/**
 * T05: Persist when a connection is rate-limited, directly in DB.
 * This survives token refresh — OAuth flows must NOT override this field.
 *
 * @param connectionId - The provider_connections.id
 * @param until - Epoch ms when the rate limit expires (null to clear)
 */
export async function setConnectionRateLimitUntil(
  connectionId: string,
  until: number | null
): Promise<void> {
  const db = getDbClient();
  await db.run(
    "UPDATE provider_connections SET rate_limited_until = ?, updated_at = ? WHERE id = ?",
    until,
    new Date().toISOString(),
    connectionId
  );
  invalidateDbCache("connections");
}

/**
 * Mark a connection as rate-limited until `Date.now() + retryAfterMs`.
 *
 * Best-effort: never throws — a DB failure must not crash the chat path. The T05
 * startup helper `clearStaleCrashCooldowns` will not undo a write made here because
 * the timestamp is always strictly in the future at the moment of write. See Issue #1
 * (per-account 429 cascade not persisting).
 */
export async function markConnectionRateLimitedUntil(
  connectionId: string,
  retryAfterMs: number
): Promise<void> {
  if (typeof connectionId !== "string" || connectionId.length === 0) return;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
  try {
    await setConnectionRateLimitUntil(connectionId, Date.now() + retryAfterMs);
  } catch {
    // best-effort
  }
}

/**
 * Clear a connection's persisted 429 cooldown.
 *
 * Best-effort: never throws. Mirrors `resetAccountState`'s in-memory clear so the
 * in-memory AccountState and the DB row agree.
 */
export async function clearConnectionRateLimit(connectionId: string): Promise<void> {
  if (typeof connectionId !== "string" || connectionId.length === 0) return;
  try {
    await setConnectionRateLimitUntil(connectionId, null);
  } catch {
    // best-effort
  }
}

/**
 * T05: Check if a connection is currently rate-limited (DB-backed).
 * Use this before account selection to skip transiently rate-limited accounts.
 *
 * @returns true if rate_limited_until is set and in the future
 */
export async function isConnectionRateLimited(connectionId: string): Promise<boolean> {
  const db = getDbClient();
  const row = await db.get<{ rate_limited_until?: number | null }>(
    "SELECT rate_limited_until FROM provider_connections WHERE id = ?",
    connectionId
  );
  if (!row?.rate_limited_until) return false;
  return Date.now() < row.rate_limited_until;
}

/**
 * T05: Get all connections for a provider that are currently rate-limited.
 * Returns an array of { id, rateLimitedUntil } for dashboard display.
 */
export async function getRateLimitedConnections(
  provider: string
): Promise<Array<{ id: string; rateLimitedUntil: number }>> {
  const db = getDbClient();
  const now = Date.now();
  const rows = await db.all<{ id: string; rate_limited_until: number }>(
    "SELECT id, rate_limited_until FROM provider_connections WHERE provider = ? AND rate_limited_until > ?",
    provider,
    now
  );
  return rows.map((r) => ({ id: r.id, rateLimitedUntil: r.rate_limited_until }));
}

// ──────────────── T13: Stale Quota Display Fix ─────────────────────────────
// Codex/Claude quotas display stale cumulative usage after the window resets.
// By comparing resetAt timestamp to now(), we can show 0 when window has passed.
// Ref: sub2api PR #1171 (fix: quota display shows stale cumulative usage after reset)

/**
 * T13: Get effective quota usage, zeroing it out if the window has already reset.
 *
 * @param used - Stored usage value (tokens used in the window)
 * @param resetAt - ISO-8601 string or epoch ms when the window resets, or null
 * @returns Effective usage: 0 if window expired, original value otherwise
 */
export function getEffectiveQuotaUsage(
  used: number,
  resetAt: string | number | null | undefined
): number {
  if (!resetAt) return used;
  const resetTime = typeof resetAt === "number" ? resetAt : new Date(resetAt).getTime();
  if (isNaN(resetTime)) return used;
  // Window has passed — display should show 0 (pending next snapshot)
  if (Date.now() >= resetTime) return 0;
  return used;
}

/**
 * T05: Startup crash-recovery — clear stale transient connection cooldowns.
 *
 * After an unclean crash (SIGKILL, OOM-kill, large-body burst) the normal
 * error-handler paths that would clear/normalise cooldowns never run.
 * A connection's `rate_limited_until` may have been pushed far into the
 * future by exponential back-off.  On next startup that leaves all affected
 * connections excluded by `getProviderCredentials()`, so every request sits
 * in the Bottleneck queue and times out at `maxWaitMs` (120 s default).
 *
 * Safe invariants:
 *  - Only connections with `rate_limited_until IS NOT NULL` are touched.
 *  - Terminal states (`banned`, `expired`, `credits_exhausted`) are skipped —
 *    those require a deliberate credential change or operator reset.
 *  - Past timestamps are also cleared: they are already expired in the lazy
 *    expiry sense, but clearing them resets `backoffLevel` / transient error
 *    fields so the connection gets a clean slate on this fresh process.
 *
 * Must be called once, early in the startup sequence, before any request
 * is handled.  Returns the number of connections that were cleared.
 */
export async function clearStaleCrashCooldowns(): Promise<{ cleared: number }> {
  const db = getDbClient();
  const now = new Date().toISOString();

  // Fetch all connections that have a rate_limited_until set and are NOT in
  // a terminal state.  We do the terminal-status filter in JS to reuse the
  // canonical `TERMINAL_STATUSES` set rather than duplicating the list in SQL.
  const TERMINAL_STATUSES = new Set(["banned", "expired", "credits_exhausted"]);

  const rows = await db.all<{ id: string; test_status: string | null }>(
    `SELECT id, test_status FROM provider_connections WHERE rate_limited_until IS NOT NULL`
  );

  const toReset = rows.filter((r) => {
    const status = (r.test_status || "").trim().toLowerCase();
    return !TERMINAL_STATUSES.has(status);
  });

  if (toReset.length === 0) return { cleared: 0 };

  const resetSql = `UPDATE provider_connections SET
       rate_limited_until = NULL,
       test_status        = 'active',
       backoff_level      = 0,
       last_error         = NULL,
       last_error_at      = NULL,
       last_error_type    = NULL,
       last_error_source  = NULL,
       error_code         = NULL,
       updated_at         = ?
     WHERE id = ?`;

  for (const row of toReset) {
    await db.run(resetSql, now, row.id);
  }

  invalidateDbCache("connections");

  return { cleared: toReset.length };
}

// T13: Format a reset countdown as a human-readable string ("2h 35m" / "4m 30s").
// The implementation lives in the client-safe formatting utils so client
// components (e.g. CoolingConnectionsPanel) can import it without pulling this
// server-only DB module (better-sqlite3/ioredis) into the browser bundle.
// Re-exported here for existing server-side callers and the db/providers barrel.
export { formatResetCountdown } from "@/shared/utils/formatting";
