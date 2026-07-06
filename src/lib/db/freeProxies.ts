import { randomUUID } from "crypto";
import { getDbClient } from "./core";
import { backupDbFile } from "./backup";
import type { FreeProxyItem, FreeProxySourceId } from "@/lib/freeProxyProviders/types";

export interface FreeProxyRecord {
  id: string;
  source: FreeProxySourceId;
  host: string;
  port: number;
  type: string;
  countryCode: string | null;
  qualityScore: number | null;
  latencyMs: number | null;
  anonymity: string | null;
  lastValidated: string | null;
  inPool: boolean;
  poolProxyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FreeProxyStats {
  total: number;
  inPool: number;
  avgQuality: number | null;
  bySource: Array<{ source: string; count: number }>;
  lastSyncAt: string | null;
}

type DbRow = Record<string, unknown>;

function mapRow(row: unknown): FreeProxyRecord {
  const r = row as DbRow;
  return {
    id: String(r.id ?? ""),
    source: String(r.source ?? "1proxy") as FreeProxySourceId,
    host: String(r.host ?? ""),
    port: Number(r.port) || 0,
    type: String(r.type ?? "http"),
    countryCode: r.country_code != null ? String(r.country_code) : null,
    qualityScore: r.quality_score != null ? Number(r.quality_score) : null,
    latencyMs: r.latency_ms != null ? Number(r.latency_ms) : null,
    anonymity: r.anonymity != null ? String(r.anonymity) : null,
    lastValidated: r.last_validated != null ? String(r.last_validated) : null,
    inPool: r.in_pool === 1 || r.in_pool === true,
    poolProxyId: r.pool_proxy_id != null ? String(r.pool_proxy_id) : null,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

export async function upsertFreeProxy(
  item: FreeProxyItem
): Promise<{ id: string; action: "created" | "updated" }> {
  const db = getDbClient();
  const now = new Date().toISOString();

  const existing = await db.get<{ id?: string }>(
    "SELECT id FROM free_proxies WHERE source = ? AND host = ? AND port = ?",
    item.source,
    item.host,
    item.port
  );

  if (existing?.id) {
    await db.run(
      `UPDATE free_proxies
       SET type = ?, country_code = ?, quality_score = ?, latency_ms = ?,
           anonymity = ?, last_validated = ?, updated_at = ?
       WHERE id = ?`,
      item.type,
      item.countryCode ?? null,
      item.qualityScore ?? null,
      item.latencyMs ?? null,
      item.anonymity ?? null,
      item.lastValidated ?? now,
      now,
      existing.id
    );
    return { id: existing.id, action: "updated" };
  }

  const id = randomUUID();
  await db.run(
    `INSERT INTO free_proxies
     (id, source, host, port, type, country_code, quality_score, latency_ms,
      anonymity, last_validated, in_pool, pool_proxy_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    id,
    item.source,
    item.host,
    item.port,
    item.type,
    item.countryCode ?? null,
    item.qualityScore ?? null,
    item.latencyMs ?? null,
    item.anonymity ?? null,
    item.lastValidated ?? now,
    now,
    now
  );
  return { id, action: "created" };
}

export async function listFreeProxies(options?: {
  sources?: FreeProxySourceId[];
  protocol?: string;
  country?: string;
  minQuality?: number;
  onlyInPool?: boolean;
  onlyNotInPool?: boolean;
  limit?: number;
  offset?: number;
}): Promise<FreeProxyRecord[]> {
  const db = getDbClient();
  const params: unknown[] = [];
  let sql = "SELECT * FROM free_proxies WHERE 1=1";

  if (options?.sources?.length) {
    sql += ` AND source IN (${options.sources.map(() => "?").join(",")})`;
    params.push(...options.sources);
  }
  if (options?.protocol) {
    sql += " AND type = ?";
    params.push(options.protocol);
  }
  if (options?.country) {
    sql += " AND country_code = ?";
    params.push(options.country.toUpperCase());
  }
  if (options?.minQuality != null) {
    sql += " AND quality_score >= ?";
    params.push(options.minQuality);
  }
  if (options?.onlyInPool) {
    sql += " AND in_pool = 1";
  }
  if (options?.onlyNotInPool) {
    sql += " AND in_pool = 0";
  }

  sql += " ORDER BY quality_score DESC, last_validated DESC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
    if (options?.offset) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }
  }

  const rows = await db.all(sql, ...params);
  return rows.map(mapRow);
}

export async function listFreeProxiesBySource(
  source: FreeProxySourceId,
  filters: {
    protocol?: string;
    country?: string;
    minQuality?: number;
    limit?: number;
  }
): Promise<FreeProxyItem[]> {
  const records = await listFreeProxies({
    sources: [source],
    protocol: filters.protocol,
    country: filters.country,
    minQuality: filters.minQuality,
    limit: filters.limit,
  });
  return records.map((r) => ({
    source: r.source,
    host: r.host,
    port: r.port,
    type: r.type as FreeProxyItem["type"],
    countryCode: r.countryCode,
    qualityScore: r.qualityScore,
    latencyMs: r.latencyMs,
    anonymity: r.anonymity,
    lastValidated: r.lastValidated,
  }));
}

export async function getFreeProxyById(id: string): Promise<FreeProxyRecord | null> {
  const db = getDbClient();
  const row = await db.get("SELECT * FROM free_proxies WHERE id = ?", id);
  return row ? mapRow(row) : null;
}

export async function markFreeProxyInPool(id: string, poolProxyId: string): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.run(
    "UPDATE free_proxies SET in_pool = 1, pool_proxy_id = ?, updated_at = ? WHERE id = ?",
    poolProxyId,
    now,
    id
  );
  backupDbFile("pre-write");
}

/**
 * Atomically inserts the free proxy into `proxy_registry` and flips its
 * `in_pool` flag in a single transaction. Replaces the previous
 * non-atomic `createProxy() + markFreeProxyInPool()` pair which could leave
 * `free_proxies.in_pool=0` while the registry row already existed if the
 * second call failed.
 *
 * Returns the new `poolProxyId` on success, or `null` if the free proxy id
 * does not exist (caller should return 404).
 */
export async function promoteFreeProxyToPool(
  freeProxyId: string,
  registryPayload: {
    name: string;
    type: string;
    host: string;
    port: number;
    source: string;
  }
): Promise<string | null> {
  const db = getDbClient();
  const now = new Date().toISOString();
  const newRegistryId = randomUUID();

  let result: string | null = null;
  await db.transaction(async (c) => {
    const exists = await c.get<{ id?: string; in_pool?: number }>(
      "SELECT id, in_pool FROM free_proxies WHERE id = ? LIMIT 1",
      freeProxyId
    );
    if (!exists?.id) return;

    await c.run(
      `INSERT INTO proxy_registry
        (id, name, type, host, port, username, password, region, notes, status, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '', '', NULL, NULL, 'active', ?, ?, ?)`,
      newRegistryId,
      registryPayload.name,
      registryPayload.type,
      registryPayload.host,
      Number(registryPayload.port),
      registryPayload.source,
      now,
      now
    );

    await c.run(
      "UPDATE free_proxies SET in_pool = 1, pool_proxy_id = ?, updated_at = ? WHERE id = ?",
      newRegistryId,
      now,
      freeProxyId
    );

    result = newRegistryId;
  });

  if (result) backupDbFile("pre-write");
  return result;
}

export async function deleteFreeProxy(id: string): Promise<boolean> {
  const db = getDbClient();
  const result = await db.run("DELETE FROM free_proxies WHERE id = ?", id);
  backupDbFile("pre-write");
  return result.changes > 0;
}

export async function clearFreeProxiesBySource(source: FreeProxySourceId): Promise<number> {
  const db = getDbClient();
  const result = await db.run(
    "DELETE FROM free_proxies WHERE source = ? AND in_pool = 0",
    source
  );
  backupDbFile("pre-write");
  return result.changes;
}

/**
 * Tombstone rows for `source` whose `host:port` is no longer present in the
 * provider's latest list — e.g. Webshare recycles/retires proxy IDs between
 * syncs. Rows already promoted to the pool (`in_pool = 1`) are left alone so
 * runtime resolution of an in-use proxy is never disturbed; only stale,
 * not-yet-pooled candidates are pruned. Returns the number of rows removed.
 */
export async function pruneStaleFreeProxies(
  source: FreeProxySourceId,
  activeKeys: ReadonlySet<string>
): Promise<number> {
  const db = getDbClient();
  const rows = await db.all<{ id: string; host: string; port: number }>(
    "SELECT id, host, port FROM free_proxies WHERE source = ? AND in_pool = 0",
    source
  );

  const staleIds = rows.filter((r) => !activeKeys.has(`${r.host}:${r.port}`)).map((r) => r.id);

  if (staleIds.length === 0) return 0;

  const placeholders = staleIds.map(() => "?").join(",");
  const result = await db.run(
    `DELETE FROM free_proxies WHERE id IN (${placeholders})`,
    ...staleIds
  );
  backupDbFile("pre-write");
  return result.changes;
}

// #4878: the displayed "last sync" used to be derived from MAX(last_validated),
// which only advances when a provider returns at least one new/updated proxy. A
// sync that returns zero rows (or whose providers all fail) left the timestamp
// frozen, so "Sync All" appeared to do nothing. We persist an explicit sync
// timestamp in the generic key_value store and prefer it in the stats.
const FREE_PROXY_SYNC_NAMESPACE = "free_proxies";
const FREE_PROXY_SYNC_KEY = "last_sync_at";

/**
 * Persist the moment a free-proxy sync completed. Returns the stored ISO string
 * so the route can echo it back. `at` is overridable for deterministic tests.
 */
export async function recordFreeProxySync(at?: string): Promise<string> {
  const db = getDbClient();
  const ts = at ?? new Date().toISOString();
  await db.run(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)",
    FREE_PROXY_SYNC_NAMESPACE,
    FREE_PROXY_SYNC_KEY,
    ts
  );
  backupDbFile("pre-write");
  return ts;
}

async function getRecordedFreeProxySync(db: ReturnType<typeof getDbClient>): Promise<string | null> {
  const row = await db.get<{ value?: string }>(
    "SELECT value FROM key_value WHERE namespace = ? AND key = ?",
    FREE_PROXY_SYNC_NAMESPACE,
    FREE_PROXY_SYNC_KEY
  );
  return row?.value != null ? String(row.value) : null;
}

export async function getFreeProxyStats(): Promise<FreeProxyStats> {
  const db = getDbClient();
  const totals = await db.get<DbRow>(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN in_pool = 1 THEN 1 ELSE 0 END) as in_pool_count,
            AVG(quality_score) as avg_quality,
            MAX(last_validated) as last_sync_at
     FROM free_proxies`
  );

  const bySource = await db.all<DbRow>(
    "SELECT source, COUNT(*) as count FROM free_proxies GROUP BY source ORDER BY count DESC"
  );

  // Prefer the explicitly recorded sync timestamp (#4878); fall back to the
  // newest last_validated only when no sync has ever been recorded.
  const recordedSyncAt = await getRecordedFreeProxySync(db);
  const derivedSyncAt = totals?.last_sync_at != null ? String(totals.last_sync_at) : null;

  return {
    total: Number(totals?.total) || 0,
    inPool: Number(totals?.in_pool_count) || 0,
    avgQuality: totals?.avg_quality != null ? Math.round(Number(totals.avg_quality)) : null,
    bySource: bySource.map((r) => ({ source: String(r.source), count: Number(r.count) })),
    lastSyncAt: recordedSyncAt ?? derivedSyncAt,
  };
}
