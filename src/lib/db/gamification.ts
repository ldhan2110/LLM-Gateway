/**
 * gamification.ts — DB domain module for the Gamification & Leaderboard system.
 *
 * Manages leaderboards, XP/levels, badges, token ledger, invite tokens,
 * and community server connections.
 */

import { getDbClient } from "./core";
import { calculateLevel } from "../gamification/xp";

// ──────────────── Types ────────────────

export interface LeaderboardRow {
  apiKeyId: string;
  scope: string;
  score: number;
  updatedAt: string;
}

export interface UserLevelRow {
  apiKeyId: string;
  totalXp: number;
  currentLevel: number;
  updatedAt: string;
}

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  rarity: string;
  criteria: string | null;
  hidden: number;
  createdAt: string;
}

export interface UserBadge {
  apiKeyId: string;
  badgeId: string;
  unlockedAt: string;
  badgeName?: string;
  badgeDescription?: string | null;
  badgeIcon?: string | null;
  badgeCategory?: string | null;
  badgeRarity?: string;
}

export interface XpAuditLogEntry {
  id: number;
  apiKeyId: string;
  action: string;
  xpEarned: number;
  metadata: string | null;
  createdAt: string;
}

export interface TokenLedgerEntry {
  id: number;
  fromApiKeyId: string;
  toApiKeyId: string;
  amount: number;
  reason: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface InviteToken {
  id: string;
  code: string;
  tokenHash: string;
  createdBy: string;
  usedBy: string | null;
  serverUrl: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CommunityServer {
  id: string;
  name: string;
  url: string;
  apiKeyHash: string;
  connectedAt: string;
  lastSyncAt: string | null;
  status: string;
  errorMessage: string | null;
}

// ──────────────── Leaderboard ────────────────

export async function updateScore(apiKeyId: string, scope: string, points: number): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT INTO leaderboard (api_key_id, scope, score, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(api_key_id, scope)
     DO UPDATE SET score = score + excluded.score, updated_at = datetime('now')`,
    apiKeyId,
    scope,
    points
  );
}

export async function getRank(apiKeyId: string, scope: string): Promise<number> {
  const db = getDbClient();
  const row = await db.get<{ score: number }>(
    `SELECT score FROM leaderboard WHERE api_key_id = ? AND scope = ?`,
    apiKeyId,
    scope
  );
  if (!row) return 0;
  const rankRow = await db.get<{ rank: number }>(
    `SELECT COUNT(*) + 1 AS rank FROM leaderboard WHERE scope = ? AND score > ?`,
    scope,
    row.score
  );
  return rankRow?.rank ?? 0;
}

export async function getTopN(
  scope: string,
  limit: number,
  offset: number = 0
): Promise<LeaderboardRow[]> {
  const db = getDbClient();
  const rows = await db.all<{
    api_key_id: string;
    scope: string;
    score: number;
    updated_at: string;
  }>(
    `SELECT api_key_id, scope, score, updated_at FROM leaderboard
     WHERE scope = ? ORDER BY score DESC LIMIT ? OFFSET ?`,
    scope,
    limit,
    offset
  );
  return rows.map((r) => ({
    apiKeyId: r.api_key_id,
    scope: r.scope,
    score: r.score,
    updatedAt: r.updated_at,
  }));
}

// ──────────────── XP & Levels ────────────────

export async function addXp(
  apiKeyId: string,
  action: string,
  amount: number,
  metadata?: string
): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT INTO xp_audit_log (api_key_id, action, xp_earned, metadata)
     VALUES (?, ?, ?, ?)`,
    apiKeyId,
    action,
    amount,
    metadata ?? null
  );

  await db.run(
    `INSERT INTO user_levels (api_key_id, total_xp, current_level, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(api_key_id)
     DO UPDATE SET total_xp = total_xp + excluded.total_xp, updated_at = datetime('now')`,
    apiKeyId,
    amount,
    calculateLevel(amount)
  );
}

export async function getXp(apiKeyId: string): Promise<UserLevelRow | null> {
  const db = getDbClient();
  const row = await db.get<{
    api_key_id: string;
    total_xp: number;
    current_level: number;
    updated_at: string;
  }>(
    `SELECT api_key_id, total_xp, current_level, updated_at FROM user_levels WHERE api_key_id = ?`,
    apiKeyId
  );
  if (!row) return null;
  return {
    apiKeyId: row.api_key_id,
    totalXp: row.total_xp,
    currentLevel: row.current_level,
    updatedAt: row.updated_at,
  };
}

export async function updateLevel(apiKeyId: string, level: number): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT INTO user_levels (api_key_id, total_xp, current_level, updated_at)
     VALUES (?, 0, ?, datetime('now'))
     ON CONFLICT(api_key_id)
     DO UPDATE SET current_level = ?, updated_at = datetime('now')`,
    apiKeyId,
    level,
    level
  );
}

// ──────────────── Badges ────────────────

export async function unlockBadge(apiKeyId: string, badgeId: string): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT OR IGNORE INTO user_badges (api_key_id, badge_id) VALUES (?, ?)`,
    apiKeyId,
    badgeId
  );
}

/**
 * Whether a specific badge has already been awarded to an API key.
 *
 * Reads `user_badges` directly (no JOIN), so the "already unlocked?" check is correct even
 * when `badge_definitions` is unpopulated. `getBadges()` INNER-JOINs `badge_definitions`, so
 * it returns nothing until the definitions are seeded — using it as a dedup guard caused
 * badge-unlock events to re-fire on every request (#3472).
 */
export async function hasBadge(apiKeyId: string, badgeId: string): Promise<boolean> {
  const db = getDbClient();
  const row = await db.get(
    `SELECT 1 FROM user_badges WHERE api_key_id = ? AND badge_id = ? LIMIT 1`,
    apiKeyId,
    badgeId
  );
  return !!row;
}

export async function getBadges(apiKeyId: string): Promise<UserBadge[]> {
  const db = getDbClient();
  const rows = await db.all<{
    api_key_id: string;
    badge_id: string;
    unlocked_at: string;
    name: string;
    description: string | null;
    icon: string | null;
    category: string | null;
    rarity: string;
  }>(
    `SELECT ub.api_key_id, ub.badge_id, ub.unlocked_at,
            bd.name, bd.description, bd.icon, bd.category, bd.rarity
     FROM user_badges ub
     JOIN badge_definitions bd ON bd.id = ub.badge_id
     WHERE ub.api_key_id = ?`,
    apiKeyId
  );
  return rows.map((r) => ({
    apiKeyId: r.api_key_id,
    badgeId: r.badge_id,
    unlockedAt: r.unlocked_at,
    badgeName: r.name,
    badgeDescription: r.description,
    badgeIcon: r.icon,
    badgeCategory: r.category,
    badgeRarity: r.rarity,
  }));
}

export async function getBadgeDefinitions(category?: string): Promise<BadgeDefinition[]> {
  const db = getDbClient();
  const rows = await (category
    ? db.all<{
        id: string;
        name: string;
        description: string | null;
        icon: string | null;
        category: string | null;
        rarity: string;
        criteria: string | null;
        hidden: number;
        created_at: string;
      }>(`SELECT * FROM badge_definitions WHERE category = ?`, category)
    : db.all<{
        id: string;
        name: string;
        description: string | null;
        icon: string | null;
        category: string | null;
        rarity: string;
        criteria: string | null;
        hidden: number;
        created_at: string;
      }>(`SELECT * FROM badge_definitions`));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    category: r.category,
    rarity: r.rarity,
    criteria: r.criteria,
    hidden: r.hidden,
    createdAt: r.created_at,
  }));
}

/**
 * Aggregate XP across every API key (the operator-wide profile view used by the
 * dashboard profile page, which is not scoped to a single key). Sums total XP and
 * takes the highest reached level. (#3484)
 */
export async function getAggregateXp(): Promise<UserLevelRow> {
  const db = getDbClient();
  const row = await db.get<{ total_xp: number; current_level: number; updated_at: string | null }>(
    `SELECT COALESCE(SUM(total_xp), 0) AS total_xp,
            COALESCE(MAX(current_level), 1) AS current_level,
            MAX(updated_at) AS updated_at
     FROM user_levels`
  );
  return {
    apiKeyId: "*",
    totalXp: row?.total_xp ?? 0,
    currentLevel: row?.current_level ?? 1,
    updatedAt: row?.updated_at ?? "",
  };
}

/**
 * Distinct badges earned by any API key (operator-wide earned set for the profile
 * page). Deduplicated by badge id, keeping the earliest unlock. (#3484)
 */
export async function getAllEarnedBadges(): Promise<UserBadge[]> {
  const db = getDbClient();
  const rows = await db.all<{
    badge_id: string;
    unlocked_at: string;
    name: string;
    description: string | null;
    icon: string | null;
    category: string | null;
    rarity: string;
  }>(
    `SELECT ub.badge_id, MIN(ub.unlocked_at) AS unlocked_at,
            bd.name, bd.description, bd.icon, bd.category, bd.rarity
     FROM user_badges ub
     JOIN badge_definitions bd ON bd.id = ub.badge_id
     GROUP BY ub.badge_id`
  );
  return rows.map((r) => ({
    apiKeyId: "*",
    badgeId: r.badge_id,
    unlockedAt: r.unlocked_at,
    badgeName: r.name,
    badgeDescription: r.description,
    badgeIcon: r.icon,
    badgeCategory: r.category,
    badgeRarity: r.rarity,
  }));
}

// ──────────────── Token Ledger ────────────────

export async function transferTokens(
  fromId: string,
  toId: string,
  amount: number,
  reason: string,
  idempotencyKey: string
): Promise<{ success: boolean; error?: string }> {
  const db = getDbClient();
  return db.transaction(async (c) => {
    // Check for duplicate
    const existing = await c.get<{ id: number }>(
      `SELECT id FROM token_ledger WHERE idempotency_key = ?`,
      idempotencyKey
    );
    if (existing) return { success: true };

    // Balance check (inside transaction to prevent race)
    const balance = await getBalanceWithClient(c, fromId);
    if (balance < amount) {
      return { success: false, error: "insufficient_balance" };
    }

    await c.run(
      `INSERT INTO token_ledger (from_api_key_id, to_api_key_id, amount, reason, idempotency_key)
       VALUES (?, ?, ?, ?, ?)`,
      fromId,
      toId,
      amount,
      reason,
      idempotencyKey
    );

    return { success: true };
  });
}

async function getBalanceWithClient(
  c: import("./adapters/dbClient").DbClient,
  apiKeyId: string
): Promise<number> {
  const received = await c.get<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM token_ledger WHERE to_api_key_id = ?`,
    apiKeyId
  );
  const sent = await c.get<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM token_ledger WHERE from_api_key_id = ?`,
    apiKeyId
  );
  return (received?.total ?? 0) - (sent?.total ?? 0);
}

export async function getBalance(apiKeyId: string): Promise<number> {
  const db = getDbClient();
  return getBalanceWithClient(db, apiKeyId);
}

export async function getHistory(apiKeyId: string, limit: number): Promise<TokenLedgerEntry[]> {
  const db = getDbClient();
  const rows = await db.all<{
    id: number;
    from_api_key_id: string;
    to_api_key_id: string;
    amount: number;
    reason: string | null;
    idempotency_key: string | null;
    created_at: string;
  }>(
    `SELECT * FROM token_ledger
     WHERE from_api_key_id = ? OR to_api_key_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    apiKeyId,
    apiKeyId,
    limit
  );
  return rows.map((r) => ({
    id: r.id,
    fromApiKeyId: r.from_api_key_id,
    toApiKeyId: r.to_api_key_id,
    amount: r.amount,
    reason: r.reason,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  }));
}

// ──────────────── Invite Tokens ────────────────

export async function createInviteToken(
  id: string,
  code: string,
  tokenHash: string,
  createdBy: string,
  serverUrl?: string,
  maxUses?: number
): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT INTO invite_tokens (id, code, token_hash, created_by, server_url, max_uses)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    code,
    tokenHash,
    createdBy,
    serverUrl ?? null,
    maxUses ?? 1
  );
}

export async function getInviteByCode(code: string): Promise<InviteToken | null> {
  const db = getDbClient();
  const row = await db.get<{
    id: string;
    code: string;
    token_hash: string;
    created_by: string;
    used_by: string | null;
    server_url: string | null;
    max_uses: number;
    use_count: number;
    expires_at: string | null;
    revoked_at: string | null;
    created_at: string;
  }>(`SELECT * FROM invite_tokens WHERE code = ?`, code);
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    tokenHash: row.token_hash,
    createdBy: row.created_by,
    usedBy: row.used_by,
    serverUrl: row.server_url,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export async function redeemInvite(code: string, usedBy: string): Promise<boolean> {
  const db = getDbClient();
  const result = await db.run(
    `UPDATE invite_tokens
     SET use_count = use_count + 1, used_by = ?
     WHERE code = ? AND revoked_at IS NULL
       AND use_count < max_uses
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    usedBy,
    code
  );
  return result.changes > 0;
}

export async function revokeInvite(id: string): Promise<void> {
  const db = getDbClient();
  await db.run(`UPDATE invite_tokens SET revoked_at = datetime('now') WHERE id = ?`, id);
}

// ──────────────── Community Servers ────────────────

/**
 * Look up a connected community server by its API key hash.
 * Returns the server id if the key hash matches a 'connected' server, or undefined.
 * Used by federation routes to authenticate bearer tokens.
 */
export async function getConnectedServerByKeyHash(
  apiKeyHash: string
): Promise<{ id: string } | undefined> {
  const db = getDbClient();
  return db.get<{ id: string }>(
    "SELECT id FROM community_servers WHERE api_key_hash = ? AND status = 'connected'",
    apiKeyHash
  );
}

export async function connectServer(
  id: string,
  name: string,
  url: string,
  apiKeyHash: string
): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT OR REPLACE INTO community_servers (id, name, url, api_key_hash)
     VALUES (?, ?, ?, ?)`,
    id,
    name,
    url,
    apiKeyHash
  );
}

export async function disconnectServer(id: string): Promise<void> {
  const db = getDbClient();
  await db.run(`UPDATE community_servers SET status = 'disconnected' WHERE id = ?`, id);
}

/** List community servers (excludes api_key_hash for security). */
export async function listServers(): Promise<Omit<CommunityServer, "apiKeyHash">[]> {
  const db = getDbClient();
  const rows = await db.all<{
    id: string;
    name: string;
    url: string;
    connected_at: string;
    last_sync_at: string | null;
    status: string;
    error_message: string | null;
  }>(
    `SELECT id, name, url, connected_at, last_sync_at, status, error_message FROM community_servers`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    connectedAt: r.connected_at,
    lastSyncAt: r.last_sync_at,
    status: r.status,
    errorMessage: r.error_message,
  }));
}

/**
 * Get neighbors around a user on the leaderboard.
 */
export async function getLeaderboardNeighbors(
  apiKeyId: string,
  scope: string,
  radius: number = 5
): Promise<{
  above: Array<{ apiKeyId: string; score: number }>;
  below: Array<{ apiKeyId: string; score: number }>;
}> {
  const db = getDbClient();

  const scoreRow = await db.get<{ score: number }>(
    "SELECT score FROM leaderboard WHERE api_key_id = ? AND scope = ?",
    apiKeyId,
    scope
  );

  if (!scoreRow) return { above: [], below: [] };

  const above = await db.all<{ api_key_id: string; score: number }>(
    `SELECT api_key_id, score FROM leaderboard
       WHERE scope = ? AND score > ?
       ORDER BY score ASC LIMIT ?`,
    scope,
    scoreRow.score,
    radius
  );

  const below = await db.all<{ api_key_id: string; score: number }>(
    `SELECT api_key_id, score FROM leaderboard
       WHERE scope = ? AND score < ?
       ORDER BY score DESC LIMIT ?`,
    scope,
    scoreRow.score,
    radius
  );

  return {
    above: above.reverse().map((r) => ({ apiKeyId: r.api_key_id, score: r.score })),
    below: below.map((r) => ({ apiKeyId: r.api_key_id, score: r.score })),
  };
}

/**
 * Rotate weekly/monthly scopes. Archive old data, reset current.
 * Uses two-step approach (SELECT then parameterized INSERT) to avoid SQL injection.
 * Skips if archive scope already has data for this period (double-run protection).
 */
export async function rotateLeaderboardScope(scope: "weekly" | "monthly"): Promise<void> {
  const db = getDbClient();
  const archiveSuffix =
    scope === "weekly"
      ? `week_${new Date().toISOString().slice(0, 10)}`
      : `month_${new Date().toISOString().slice(0, 7)}`;

  // Double-run protection: skip if archive scope already has data
  const existing = await db.get<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM leaderboard WHERE scope = ?",
    archiveSuffix
  );
  if (existing && existing.cnt > 0) return;

  // Step 1: SELECT rows into memory
  const rows = await db.all<{ api_key_id: string; score: number; updated_at: string }>(
    "SELECT api_key_id, score, updated_at FROM leaderboard WHERE scope = ?",
    scope
  );

  // Step 2: INSERT with parameters (no string interpolation)
  if (rows.length > 0) {
    await db.transaction(async (c) => {
      for (const row of rows) {
        await c.run(
          "INSERT OR IGNORE INTO leaderboard (api_key_id, scope, score, updated_at) VALUES (?, ?, ?, ?)",
          row.api_key_id,
          archiveSuffix,
          row.score,
          row.updated_at
        );
      }
    });
  }

  await db.run("DELETE FROM leaderboard WHERE scope = ?", scope);
}
