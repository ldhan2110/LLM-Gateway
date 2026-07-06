/**
 * db/quotaPools.ts — CRUD for quota_pools and quota_allocations tables.
 *
 * Quota pools group provider connections with per-API-key weight + cap +
 * policy allocations. Used by the Quota Sharing Engine (plan 22, Group B).
 *
 * All SQL goes through the async DbClient — never raw string interpolation.
 * Import getDbClient from ./core (Hard Rule #5).
 */

import { getDbClient } from "./core";
// Phase B2: auto-mint/prune quotaShared-* combos when pool allocations change.
// Imported lazily (dynamic import in the hook) to avoid circular-dependency
// risk between db/ and quota/ modules. The import is fire-and-forget; combo
// failures never break pool CRUD.
async function syncQuotaCombosGuarded(poolId: string): Promise<void> {
  try {
    const { syncQuotaCombos } = await import("@/lib/quota/quotaCombos");
    await syncQuotaCombos(poolId);
  } catch (err) {
    // Guard: combo-sync failure must never break pool CRUD callers.
    console.warn("[quota-pools] syncQuotaCombos failed (non-fatal):", (err as Error)?.message);
  }
}

async function removeQuotaCombosGuarded(poolId: string): Promise<void> {
  try {
    const { removeQuotaCombosForPool } = await import("@/lib/quota/quotaCombos");
    await removeQuotaCombosForPool(poolId);
  } catch (err) {
    console.warn(
      "[quota-pools] removeQuotaCombosForPool failed (non-fatal):",
      (err as Error)?.message
    );
  }
}

// ---------------------------------------------------------------------------
// Local type shapes (aligned with src/lib/quota/dimensions.ts — merged by F7)
// ---------------------------------------------------------------------------

type QuotaUnit = "percent" | "requests" | "tokens" | "usd";
type Policy = "hard" | "soft" | "burst";

export interface PoolAllocation {
  apiKeyId: string;
  weight: number;
  capValue?: number;
  capUnit?: QuotaUnit;
  policy: Policy;
}

export interface QuotaPool {
  id: string;
  /** Primary / legacy single connection. Kept for back-compat. */
  connectionId: string;
  /** All member connections (≥1 after backfill). Primary is always connectionIds[0]. */
  connectionIds: string[];
  name: string;
  /** Group this pool belongs to. Defaults to 'group-demo' for legacy pools. */
  groupId: string;
  createdAt: string;
  allocations: PoolAllocation[];
}

export interface PoolCreate {
  connectionId: string;
  name: string;
  /** Group to assign this pool to. Defaults to 'group-demo' when omitted. */
  groupId?: string;
  allocations?: PoolAllocation[];
  /**
   * Full member list. When provided, connectionId is ignored for the join table
   * and connectionIds[0] is used as the primary. When omitted, defaults to
   * [connectionId].
   */
  connectionIds?: string[];
}

export interface PoolUpdate {
  name?: string;
  /** When provided, updates the pool's group assignment. */
  groupId?: string;
  allocations?: PoolAllocation[];
  /**
   * When provided, replaces the entire join-table membership for this pool.
   * connection_id column is synced to connectionIds[0].
   */
  connectionIds?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PoolRow {
  id: string;
  connection_id: string;
  name: string;
  group_id: string | null;
  created_at: string;
}

interface AllocationRow {
  pool_id: string;
  api_key_id: string;
  weight: number;
  cap_value: number | null;
  cap_unit: string | null;
  policy: string;
}

const VALID_POLICIES: ReadonlySet<string> = new Set<Policy>(["hard", "soft", "burst"]);

/**
 * Fail-safe policy normalization at the DB read boundary. A column value outside
 * `hard | soft | burst` (corrupted/legacy row, or a value inserted while the
 * table CHECK constraint was bypassed) is coerced to the most restrictive
 * policy, `hard`, instead of being trusted via a raw `as Policy` cast. This
 * prevents an unknown policy from reaching the fair-share engine, where it would
 * otherwise be a silent fail-OPEN (issue #10).
 */
function normalizePolicy(value: string): Policy {
  return VALID_POLICIES.has(value) ? (value as Policy) : "hard";
}

function rowToAllocation(row: AllocationRow): PoolAllocation {
  const alloc: PoolAllocation = {
    apiKeyId: row.api_key_id,
    weight: row.weight,
    policy: normalizePolicy(row.policy),
  };
  if (row.cap_value != null) alloc.capValue = row.cap_value;
  if (row.cap_unit != null) alloc.capUnit = row.cap_unit as QuotaUnit;
  return alloc;
}

interface PoolConnectionRow {
  connection_id: string;
}

/**
 * Asserts that all connections in the list belong to the same provider.
 * Throws if mixed providers are detected. No-op when list has 0 or 1 entry.
 */
async function assertSingleProvider(connectionIds: string[]): Promise<void> {
  if (!connectionIds || connectionIds.length <= 1) return;
  const db = getDbClient();
  const placeholders = connectionIds.map(() => "?").join(",");
  const rows = await db.all<{ provider: string }>(
    `SELECT DISTINCT provider FROM provider_connections WHERE id IN (${placeholders})`,
    ...connectionIds
  );
  const providers = rows.map((r) => r.provider).filter(Boolean);
  if (new Set(providers).size > 1) {
    throw new Error(
      `A quota pool must use a single provider (got: ${[...new Set(providers)].join(", ")})`
    );
  }
}

async function getConnectionIds(poolId: string, fallbackConnectionId: string): Promise<string[]> {
  const db = getDbClient();
  const rows = await db.all<PoolConnectionRow>(
    "SELECT connection_id FROM quota_pool_connections WHERE pool_id = ? ORDER BY created_at ASC",
    poolId
  );
  if (rows.length > 0) {
    return rows.map((r) => r.connection_id);
  }
  // Defensive fallback: join table empty (shouldn't happen post-backfill).
  return fallbackConnectionId ? [fallbackConnectionId] : [];
}

async function getAllocations(poolId: string): Promise<PoolAllocation[]> {
  const db = getDbClient();
  const rows = await db.all<AllocationRow>(
    "SELECT pool_id, api_key_id, weight, cap_value, cap_unit, policy FROM quota_allocations WHERE pool_id = ?",
    poolId
  );
  return rows.map(rowToAllocation);
}

async function rowToPool(row: PoolRow, allocations: PoolAllocation[]): Promise<QuotaPool> {
  return {
    id: row.id,
    connectionId: row.connection_id,
    connectionIds: await getConnectionIds(row.id, row.connection_id),
    name: row.name,
    groupId: row.group_id || "group-demo",
    createdAt: row.created_at,
    allocations,
  };
}

function makeId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all quota pools that belong to a specific group.
 * Returns an empty array when no pools match the given groupId.
 */
export async function getPoolsByGroup(groupId: string): Promise<QuotaPool[]> {
  const db = getDbClient();
  const rows = await db.all<PoolRow>(
    "SELECT id, connection_id, name, group_id, created_at FROM quota_pools WHERE group_id = ? ORDER BY created_at ASC",
    groupId
  );
  return Promise.all(rows.map(async (row) => rowToPool(row, await getAllocations(row.id))));
}

/**
 * List all quota pools with their allocations.
 */
export async function listPools(): Promise<QuotaPool[]> {
  const db = getDbClient();
  const rows = await db.all<PoolRow>(
    "SELECT id, connection_id, name, group_id, created_at FROM quota_pools ORDER BY created_at ASC"
  );
  return Promise.all(rows.map(async (row) => rowToPool(row, await getAllocations(row.id))));
}

/**
 * Get a single pool by id, or null if not found.
 */
export async function getPool(id: string): Promise<QuotaPool | null> {
  const db = getDbClient();
  const row = await db.get<PoolRow>(
    "SELECT id, connection_id, name, group_id, created_at FROM quota_pools WHERE id = ?",
    id
  );
  if (!row) return null;
  return rowToPool(row, await getAllocations(row.id));
}

/**
 * Create a new quota pool, optionally with initial allocations and member connections.
 * When `connectionIds` is provided, its first element becomes the primary connection_id.
 * When omitted, defaults to [connectionId].
 */
export async function createPool(input: PoolCreate): Promise<QuotaPool> {
  const id = makeId();
  const now = new Date().toISOString();

  // Resolve effective member list and primary connection.
  const members: string[] =
    input.connectionIds && input.connectionIds.length > 0
      ? input.connectionIds
      : [input.connectionId];
  const primaryConnectionId = members[0];

  // Guard: a pool must use a single provider.
  if (input.connectionIds && input.connectionIds.length > 1) {
    await assertSingleProvider(input.connectionIds);
  }

  const groupId = input.groupId || "group-demo";

  const db = getDbClient();
  await db.transaction(async (c) => {
    await c.run(
      "INSERT INTO quota_pools (id, connection_id, name, group_id, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      primaryConnectionId,
      input.name,
      groupId,
      now
    );

    for (const connId of members) {
      await c.run(
        "INSERT OR IGNORE INTO quota_pool_connections (pool_id, connection_id) VALUES (?, ?)",
        id,
        connId
      );
    }

    if (input.allocations && input.allocations.length > 0) {
      for (const alloc of input.allocations) {
        await c.run(
          `INSERT INTO quota_allocations (pool_id, api_key_id, weight, cap_value, cap_unit, policy)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          alloc.apiKeyId,
          alloc.weight,
          alloc.capValue ?? null,
          alloc.capUnit ?? null,
          alloc.policy
        );
      }
    }
  });

  const result = await rowToPool(
    {
      id,
      connection_id: primaryConnectionId,
      name: input.name,
      group_id: groupId,
      created_at: now,
    },
    await getAllocations(id)
  );

  // Phase B2: fire-and-forget combo sync; failures are logged but never thrown.
  void syncQuotaCombosGuarded(id);

  return result;
}

/**
 * Update an existing pool's name, allocations, and/or member connections.
 * Returns updated pool, or null if pool not found.
 * When `connectionIds` is provided, the join table is replaced atomically and
 * connection_id (primary) is synced to connectionIds[0].
 */
export async function updatePool(id: string, input: PoolUpdate): Promise<QuotaPool | null> {
  const db = getDbClient();
  const existing = await db.get<PoolRow>(
    "SELECT id, connection_id, name, group_id, created_at FROM quota_pools WHERE id = ?",
    id
  );
  if (!existing) return null;

  // Guard: a pool must use a single provider.
  if (input.connectionIds && input.connectionIds.length > 1) {
    await assertSingleProvider(input.connectionIds);
  }

  await db.transaction(async (c) => {
    if (input.name !== undefined) {
      await c.run("UPDATE quota_pools SET name = ? WHERE id = ?", input.name, id);
      existing.name = input.name;
    }

    if (input.groupId !== undefined) {
      await c.run("UPDATE quota_pools SET group_id = ? WHERE id = ?", input.groupId, id);
      existing.group_id = input.groupId;
    }

    if (input.connectionIds !== undefined && input.connectionIds.length > 0) {
      const newPrimary = input.connectionIds[0];
      // Replace join rows.
      await c.run("DELETE FROM quota_pool_connections WHERE pool_id = ?", id);
      for (const connId of input.connectionIds) {
        await c.run(
          "INSERT OR IGNORE INTO quota_pool_connections (pool_id, connection_id) VALUES (?, ?)",
          id,
          connId
        );
      }
      // Sync primary column.
      await c.run("UPDATE quota_pools SET connection_id = ? WHERE id = ?", newPrimary, id);
      existing.connection_id = newPrimary;
    }

    if (input.allocations !== undefined) {
      // Inline the allocation upsert inside the transaction (avoids nested transaction).
      await c.run("DELETE FROM quota_allocations WHERE pool_id = ?", id);
      for (const alloc of input.allocations) {
        await c.run(
          `INSERT INTO quota_allocations (pool_id, api_key_id, weight, cap_value, cap_unit, policy)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          alloc.apiKeyId,
          alloc.weight,
          alloc.capValue ?? null,
          alloc.capUnit ?? null,
          alloc.policy
        );
      }
    }
  });

  const result = await rowToPool(existing, await getAllocations(id));

  // Phase B2: fire-and-forget combo sync; failures are logged but never thrown.
  void syncQuotaCombosGuarded(id);

  return result;
}

/**
 * Delete a pool by id. CASCADE removes associated allocations.
 * Also removes join rows in quota_pool_connections.
 * Returns true if a row was deleted, false if not found.
 */
export async function deletePool(id: string): Promise<boolean> {
  // Phase B2: remove quota combos BEFORE deleting the pool row so that
  // removeQuotaCombosForPool can still resolve the pool name → slug.
  void removeQuotaCombosGuarded(id);

  const db = getDbClient();
  const result = await db.transaction(async (c) => {
    await c.run("DELETE FROM quota_pool_connections WHERE pool_id = ?", id);
    // Prune this pool id from every key's allowed_quotas JSON array.
    await c.run(
      `UPDATE api_keys SET allowed_quotas = COALESCE(
       (SELECT json_group_array(value) FROM json_each(api_keys.allowed_quotas) WHERE value != ?),
       '[]')
     WHERE allowed_quotas IS NOT NULL AND allowed_quotas != '[]'
       AND EXISTS (SELECT 1 FROM json_each(api_keys.allowed_quotas) WHERE value = ?)`,
      id,
      id
    );
    return c.run("DELETE FROM quota_pools WHERE id = ?", id);
  });
  return result.changes > 0;
}

/**
 * Replace all allocations for a pool with the provided list (delete + insert),
 * and propagate the same allocation rows to EVERY other pool in the same group.
 *
 * Task B6 — Group-level allocation propagation:
 * A key allocated to any pool of group G should be able to call any other
 * pool's model in G and have fair-share enforced. The mechanism is propagation:
 * we write the identical key/weight/cap/policy rows to every pool in the group
 * so that whichever pool's model the key calls, that pool already has the
 * allocation row for the key → enforceQuotaShare finds it and applies weight.
 *
 * Propagation semantics:
 * - The target pool (poolId) is the authoritative source; its allocations replace
 *   the allocations in every sibling pool in the same group.
 * - Idempotent: delete + insert per pool (same as the original single-pool upsert).
 * - Single-pool group: trivially correct — the group loop has exactly one pool.
 * - Cross-group isolation: pools in OTHER groups are never touched.
 *
 * Exclusivity reconciliation (reconcilePoolExclusivity, Phase C3):
 * That function operates at the key's allowedQuotas level and is invoked at the
 * API route layer (src/app/api/quota/pools/[id]/route.ts PATCH handler) after
 * updatePool, NOT inside upsertAllocations. We do NOT call reconcilePoolExclusivity
 * here to avoid double-firing side-effects on sibling pools; reconcile is keyed on
 * the exclusive flag which is a route-level concern, not a per-pool propagation
 * concern. The original target pool's reconcile call (from the route handler) is
 * sufficient — it updates the key's allowedQuotas to reference the target pool, and
 * the group-level expansion in resolveQuotaKeyScope then makes all sibling pools
 * accessible automatically.
 *
 * Combo sync (Phase B2):
 * Only the target pool triggers syncQuotaCombosGuarded. Sibling pools are already
 * synced whenever they themselves are created/updated; propagation only affects
 * allocation rows, not the pool's combo catalog.
 *
 * Runs atomically: all pool writes are inside a single transaction.
 */
export async function upsertAllocations(poolId: string, allocations: PoolAllocation[]): Promise<void> {
  const db = getDbClient();

  // Normalize: when all weights are 0, distribute equally so the pool is usable
  // without requiring a manual re-save. Persists the normalized weights.
  const totalWeight = allocations.reduce(
    (s, a) => s + (Number.isFinite(a.weight) ? a.weight : 0),
    0
  );
  const normalizedAllocations =
    totalWeight === 0 && allocations.length > 0
      ? allocations.map((a) => ({ ...a, weight: 100 / allocations.length }))
      : allocations;

  // Resolve the target pool's group so we can propagate to siblings.
  // Defensive: fall back to [poolId] (single-pool semantics) if pool not found.
  const targetPool = await db.get<PoolRow>(
    "SELECT id, connection_id, name, group_id, created_at FROM quota_pools WHERE id = ?",
    poolId
  );

  // Collect all pools in the group (includes the target pool itself).
  // If the pool has no group or is not found, default to writing only poolId.
  let poolIdsInGroup: string[] = [poolId];
  if (targetPool?.group_id) {
    const groupRows = await db.all<{ id: string }>(
      "SELECT id FROM quota_pools WHERE group_id = ?",
      targetPool.group_id
    );
    if (groupRows.length > 0) {
      poolIdsInGroup = groupRows.map((r) => r.id);
    }
  }

  await db.transaction(async (c) => {
    for (const pid of poolIdsInGroup) {
      await c.run("DELETE FROM quota_allocations WHERE pool_id = ?", pid);
      for (const alloc of normalizedAllocations) {
        await c.run(
          `INSERT INTO quota_allocations (pool_id, api_key_id, weight, cap_value, cap_unit, policy)
           VALUES (?, ?, ?, ?, ?, ?)`,
          pid,
          alloc.apiKeyId,
          alloc.weight,
          alloc.capValue ?? null,
          alloc.capUnit ?? null,
          alloc.policy
        );
      }
    }
  });

  // Phase B2: fire-and-forget combo sync for the target pool only; failures are
  // logged but never thrown. Sibling pools' combos are synced on their own lifecycle.
  void syncQuotaCombosGuarded(poolId);
}

/**
 * List all allocations across all pools where apiKeyId is assigned.
 * Returns pairs of { poolId, allocation }.
 */
export async function listAllocationsForApiKey(
  apiKeyId: string
): Promise<Array<{ poolId: string; allocation: PoolAllocation }>> {
  const db = getDbClient();
  const rows = await db.all<AllocationRow>(
    `SELECT pool_id, api_key_id, weight, cap_value, cap_unit, policy
     FROM quota_allocations
     WHERE api_key_id = ?`,
    apiKeyId
  );
  return rows.map((row) => ({ poolId: row.pool_id, allocation: rowToAllocation(row) }));
}
