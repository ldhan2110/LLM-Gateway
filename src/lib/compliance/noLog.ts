import { getDbClient } from "../db/core";

// #2650: extracted from compliance/index.ts to break the
// callLogs.ts → compliance/index.ts → callLogs.ts cycle that deadlocks
// the bundled MCP server under Node.js 24's stricter ESM evaluation.

const noLogKeys = new Set<string>();
const noLogDbCache = new Map<string, { value: boolean; timestamp: number }>();
let noLogColumnVerified = false;
let hasNoLogColumn = false;
const NO_LOG_CACHE_TTL_MS = 30_000;

const noLogIdsFromEnv = (process.env.NO_LOG_API_KEY_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
for (const id of noLogIdsFromEnv) {
  noLogKeys.add(id);
}

export function setNoLog(apiKeyId: string, noLog: boolean): void {
  if (noLog) {
    noLogKeys.add(apiKeyId);
  } else {
    noLogKeys.delete(apiKeyId);
  }
  noLogDbCache.set(apiKeyId, { value: noLog, timestamp: Date.now() });
}

async function ensureNoLogColumn(): Promise<boolean> {
  if (noLogColumnVerified) {
    return hasNoLogColumn;
  }

  try {
    const db = getDbClient();
    const columns = await db.all<{ name: string }>("PRAGMA table_info(api_keys)");
    hasNoLogColumn = columns.some((column) => column.name === "no_log");
  } catch {
    hasNoLogColumn = false;
  }

  noLogColumnVerified = true;
  return hasNoLogColumn;
}

async function readNoLogFromDb(apiKeyId: string): Promise<boolean> {
  if (!apiKeyId) return false;

  const cached = noLogDbCache.get(apiKeyId);
  if (cached && Date.now() - cached.timestamp < NO_LOG_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const db = getDbClient();
    const hasColumn = await ensureNoLogColumn();
    if (!hasColumn) return false;

    const row = await db.get<{ no_log?: number }>(
      "SELECT no_log FROM api_keys WHERE id = ?",
      apiKeyId
    );
    const value = Boolean(row && Number(row.no_log) === 1);
    noLogDbCache.set(apiKeyId, { value, timestamp: Date.now() });
    return value;
  } catch {
    return false;
  }
}

export function isNoLog(apiKeyId: string): boolean {
  if (!apiKeyId) return false;
  if (noLogKeys.has(apiKeyId)) return true;

  // Check in-memory cache (fast path)
  const cached = noLogDbCache.get(apiKeyId);
  if (cached && Date.now() - cached.timestamp < NO_LOG_CACHE_TTL_MS) {
    if (cached.value) noLogKeys.add(apiKeyId);
    return cached.value;
  }

  // Seed the cache asynchronously; return false conservatively until seeded.
  (async () => {
    const persistedNoLog = await readNoLogFromDb(apiKeyId);
    if (persistedNoLog) {
      noLogKeys.add(apiKeyId);
    }
  })();

  return false;
}
