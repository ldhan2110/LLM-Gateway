import { getDbClient, isBuildPhase, isCloud } from "./core";

type JsonRecord = Record<string, unknown>;

interface KeyValueRow {
  key: string;
  value: string;
}

export interface ProviderLimitsCacheEntry {
  quotas: JsonRecord | null;
  plan: unknown;
  message: string | null;
  fetchedAt: string;
  source?: string | null;
}

const PROVIDER_LIMITS_CACHE_NAMESPACE = "providerLimitsCache";

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function normalizeCacheEntry(value: unknown): ProviderLimitsCacheEntry | null {
  const record = toRecord(value);
  if (!record) return null;

  const fetchedAt =
    typeof record.fetchedAt === "string" && record.fetchedAt.trim() ? record.fetchedAt : null;
  if (!fetchedAt) return null;

  return {
    quotas: toRecord(record.quotas),
    plan: record.plan ?? null,
    message: typeof record.message === "string" ? record.message : null,
    fetchedAt,
    source: typeof record.source === "string" ? record.source : null,
  };
}

export async function getProviderLimitsCache(
  connectionId: string
): Promise<ProviderLimitsCacheEntry | null> {
  if (isBuildPhase || isCloud) return null;
  const db = getDbClient();
  const row = await db.get<KeyValueRow>(
    "SELECT value FROM key_value WHERE namespace = ? AND key = ?",
    PROVIDER_LIMITS_CACHE_NAMESPACE,
    connectionId
  );
  if (!row?.value) return null;
  return normalizeCacheEntry(parseJson(row.value));
}

export async function getAllProviderLimitsCache(): Promise<Record<string, ProviderLimitsCacheEntry>> {
  if (isBuildPhase || isCloud) return {};
  const db = getDbClient();
  const rows = await db.all<KeyValueRow>(
    "SELECT key, value FROM key_value WHERE namespace = ?",
    PROVIDER_LIMITS_CACHE_NAMESPACE
  );

  const result: Record<string, ProviderLimitsCacheEntry> = {};
  for (const row of rows) {
    const parsed = normalizeCacheEntry(parseJson(row.value));
    if (parsed) {
      result[row.key] = parsed;
    }
  }
  return result;
}

export async function setProviderLimitsCache(
  connectionId: string,
  entry: ProviderLimitsCacheEntry
): Promise<ProviderLimitsCacheEntry> {
  if (isBuildPhase || isCloud) return entry;
  const db = getDbClient();
  await db.run(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)",
    PROVIDER_LIMITS_CACHE_NAMESPACE,
    connectionId,
    JSON.stringify(entry)
  );
  return entry;
}

export async function setProviderLimitsCacheBatch(
  entries: Array<{ connectionId: string; entry: ProviderLimitsCacheEntry }>
): Promise<number> {
  if (isBuildPhase || isCloud || entries.length === 0) return 0;
  const db = getDbClient();
  await db.transaction(async (c) => {
    for (const item of entries) {
      await c.run(
        "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)",
        PROVIDER_LIMITS_CACHE_NAMESPACE,
        item.connectionId,
        JSON.stringify(item.entry)
      );
    }
  });
  return entries.length;
}

export async function deleteProviderLimitsCache(connectionId: string): Promise<void> {
  if (isBuildPhase || isCloud) return;
  const db = getDbClient();
  await db.run(
    "DELETE FROM key_value WHERE namespace = ? AND key = ?",
    PROVIDER_LIMITS_CACHE_NAMESPACE,
    connectionId
  );
}
