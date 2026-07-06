import { createHash } from "crypto";

import { getDbClient } from "./core";

type SessionAccountAffinityRecord = {
  connectionId: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
};

const NAMESPACE = "session_account_affinity";
const CLEANUP_INTERVAL_MS = 5 * 60_000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function normalizePositiveTtl(ttlMs: number | null | undefined): number {
  return Number.isFinite(ttlMs) && Number(ttlMs) > 0 ? Number(ttlMs) : 0;
}

function affinityKey(sessionKey: string, provider: string): string {
  const hash = createHash("sha256").update(`${provider}:${sessionKey}`).digest("hex");
  return `${provider}:${hash}`;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function parseRecord(value: unknown): SessionAccountAffinityRecord | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Partial<SessionAccountAffinityRecord>;
    if (typeof parsed.connectionId !== "string" || parsed.connectionId.trim().length === 0) {
      return null;
    }
    if (typeof parsed.expiresAt !== "string" || Number.isNaN(Date.parse(parsed.expiresAt))) {
      return null;
    }
    return {
      connectionId: parsed.connectionId,
      createdAt:
        typeof parsed.createdAt === "string" && !Number.isNaN(Date.parse(parsed.createdAt))
          ? parsed.createdAt
          : parsed.expiresAt,
      lastUsedAt:
        typeof parsed.lastUsedAt === "string" && !Number.isNaN(Date.parse(parsed.lastUsedAt))
          ? parsed.lastUsedAt
          : parsed.expiresAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

async function deleteAffinityKey(key: string): Promise<void> {
  const db = getDbClient();
  await db.run("DELETE FROM key_value WHERE namespace = ? AND key = ?", NAMESPACE, key);
}

export async function getSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  ttlMs = 0,
  now: number = Date.now()
): Promise<SessionAccountAffinityRecord | null> {
  if (!sessionKey || !provider || normalizePositiveTtl(ttlMs) <= 0) return null;

  const key = affinityKey(sessionKey, provider);
  const db = getDbClient();
  const row = await db.get<{ value?: unknown }>(
    "SELECT value FROM key_value WHERE namespace = ? AND key = ?",
    NAMESPACE,
    key
  );
  const record = parseRecord(row?.value);
  if (!record) return null;

  if (Date.parse(record.expiresAt) <= now) {
    await deleteAffinityKey(key);
    return null;
  }

  return record;
}

export async function upsertSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  connectionId: string,
  now: number = Date.now(),
  ttlMs = 0
): Promise<void> {
  const normalizedTtlMs = normalizePositiveTtl(ttlMs);
  if (!sessionKey || !provider || !connectionId || normalizedTtlMs <= 0) return;

  const key = affinityKey(sessionKey, provider);
  const existing = await getSessionAccountAffinity(sessionKey, provider, normalizedTtlMs, now);
  const timestamp = isoFromMs(now);
  const record: SessionAccountAffinityRecord = {
    connectionId,
    createdAt: existing?.createdAt ?? timestamp,
    lastUsedAt: timestamp,
    expiresAt: isoFromMs(now + normalizedTtlMs),
  };

  const db = getDbClient();
  await db.run(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)",
    NAMESPACE,
    key,
    JSON.stringify(record)
  );
}

export async function touchSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  now: number = Date.now(),
  ttlMs = 0
): Promise<void> {
  const normalizedTtlMs = normalizePositiveTtl(ttlMs);
  if (normalizedTtlMs <= 0) return;

  const existing = await getSessionAccountAffinity(sessionKey, provider, normalizedTtlMs, now);
  if (!existing) return;

  await upsertSessionAccountAffinity(
    sessionKey,
    provider,
    existing.connectionId,
    now,
    normalizedTtlMs
  );
}

export async function deleteSessionAccountAffinity(
  sessionKey: string,
  provider: string
): Promise<void> {
  if (!sessionKey || !provider) return;
  await deleteAffinityKey(affinityKey(sessionKey, provider));
}

export async function cleanupStaleSessionAccountAffinities(
  _ttlMs: number = 30 * 60 * 1000,
  now: number = Date.now()
): Promise<number> {
  const db = getDbClient();
  const rows = await db.all<{ key?: unknown; value?: unknown }>(
    "SELECT key, value FROM key_value WHERE namespace = ?",
    NAMESPACE
  );
  let deleted = 0;

  await db.transaction(async (c) => {
    for (const row of rows) {
      if (typeof row.key !== "string") continue;
      const record = parseRecord(row.value);
      if (!record || Date.parse(record.expiresAt) <= now) {
        await c.run(
          "DELETE FROM key_value WHERE namespace = ? AND key = ?",
          NAMESPACE,
          row.key
        );
        deleted++;
      }
    }
  });

  return deleted;
}

export function startSessionAccountAffinityCleanup(): void {
  if (cleanupTimer) return;

  cleanupStaleSessionAccountAffinities().catch((error) => {
    console.warn("[SESSION_AFFINITY] Startup cleanup failed:", error);
  });

  cleanupTimer = setInterval(() => {
    cleanupStaleSessionAccountAffinities().catch((error) => {
      console.warn("[SESSION_AFFINITY] Periodic cleanup failed:", error);
    });
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) cleanupTimer.unref?.();
}

export function stopSessionAccountAffinityCleanupForTests(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
