import { getDbClient, rowToCamel } from "./core";
import type { QuotaSnapshotRow, ProviderUtilizationPoint } from "@/shared/types/utilization";

let lastCleanupAt = 0;

export async function saveQuotaSnapshot(
  snapshot: Omit<QuotaSnapshotRow, "id" | "created_at">
): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();

  try {
    await db.run(
      `INSERT INTO quota_snapshots
       (provider, connection_id, window_key, remaining_percentage, is_exhausted,
        next_reset_at, window_duration_ms, raw_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      snapshot.provider,
      snapshot.connection_id,
      snapshot.window_key,
      snapshot.remaining_percentage,
      snapshot.is_exhausted,
      snapshot.next_reset_at,
      snapshot.window_duration_ms,
      snapshot.raw_data,
      now
    );
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      console.warn(
        "[QuotaSnapshots] Skipping save: quota_snapshots table not found. Awaiting migration."
      );
      return;
    }
    throw err;
  }
}

export async function getQuotaSnapshots(opts: {
  provider?: string;
  connectionId?: string;
  since: string;
  until?: string;
}): Promise<QuotaSnapshotRow[]> {
  const db = getDbClient();
  const conditions: string[] = ["created_at >= ?"];
  const params: unknown[] = [opts.since];

  if (opts.provider) {
    conditions.push("provider = ?");
    params.push(opts.provider);
  }

  if (opts.connectionId) {
    conditions.push("connection_id = ?");
    params.push(opts.connectionId);
  }

  if (opts.until) {
    conditions.push("created_at <= ?");
    params.push(opts.until);
  }

  try {
    const sql = `SELECT * FROM quota_snapshots WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`;
    const rows = await db.all(sql, ...params);
    return rows.map((r) => rowToCamel(r) as unknown as QuotaSnapshotRow);
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

export async function getLatestQuotaSnapshotsForConnection(
  connectionId: string
): Promise<QuotaSnapshotRow[]> {
  const db = getDbClient();

  try {
    const rows = await db.all(
      `SELECT * FROM quota_snapshots
       WHERE connection_id = ?
       ORDER BY created_at DESC
       LIMIT 200`,
      connectionId
    );
    const latestByWindow = new Map<string, QuotaSnapshotRow>();

    for (const row of rows) {
      const snapshot = rowToCamel(row) as unknown as QuotaSnapshotRow;
      const windowKey =
        (snapshot as unknown as { windowKey?: string }).windowKey ?? snapshot.window_key;
      if (!windowKey || latestByWindow.has(windowKey)) continue;
      latestByWindow.set(windowKey, snapshot);
    }

    return [...latestByWindow.values()];
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

export async function getAggregatedSnapshots(opts: {
  provider?: string;
  since: string;
  until?: string;
  bucketMinutes: number;
  aggregateBy?: "provider" | "connection";
}): Promise<ProviderUtilizationPoint[]> {
  const db = getDbClient();
  const conditions: string[] = ["created_at >= ?"];
  const params: unknown[] = [opts.since];

  if (opts.provider) {
    conditions.push("provider = ?");
    params.push(opts.provider);
  }

  if (opts.until) {
    conditions.push("created_at <= ?");
    params.push(opts.until);
  }

  const bucketSeconds = Number(opts.bucketMinutes) * 60;
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error("Invalid bucket size");
  }

  const groupFields =
    opts.aggregateBy === "connection"
      ? "bucket, provider, connection_id, window_key"
      : "bucket, provider, window_key";
  const selectKey =
    opts.aggregateBy === "connection" ? "provider || ':' || connection_id as provider" : "provider";

  try {
    const sql = `
      SELECT
        datetime((strftime('%s', created_at) / ${bucketSeconds}) * ${bucketSeconds}, 'unixepoch') as bucket,
        ${selectKey},
        AVG(remaining_percentage) as remainingPct,
        MAX(is_exhausted) as isExhausted,
        window_key
      FROM quota_snapshots
      WHERE ${conditions.join(" AND ")}
      GROUP BY ${groupFields}
      ORDER BY bucket ASC
    `;

    const rows = await db.all<{
      bucket: string;
      provider: string;
      remainingPct: number | null;
      isExhausted: number;
      windowKey: string;
    }>(sql, ...params);

    return rows.map((r) => ({
      timestamp: r.bucket,
      provider: r.provider,
      remainingPct: r.remainingPct ?? 0,
      isExhausted: r.isExhausted === 1,
      windowKey: r.windowKey,
    }));
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

export async function cleanupOldSnapshots(retentionDays = 90): Promise<number> {
  const now = Date.now();
  const cleanupThresholdMs = 6 * 60 * 60 * 1000;

  if (now - lastCleanupAt < cleanupThresholdMs) {
    return 0;
  }

  const db = getDbClient();
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const result = await db.run(
      "DELETE FROM quota_snapshots WHERE created_at < ?",
      cutoffDate
    );
    lastCleanupAt = now;
    return result.changes;
  } catch (err: any) {
    if (err?.message?.includes("no such table")) {
      return 0;
    }
    throw err;
  }
}
