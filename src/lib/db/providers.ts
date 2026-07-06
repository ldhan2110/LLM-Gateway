/**
 * db/providers.js — Provider connections and nodes CRUD.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbClient, rowToCamel, cleanNulls } from "./core";
import type { DbClient } from "./adapters/dbClient";
import { backupDbFile } from "./backup";
import {
  encryptConnectionFields,
  decryptConnectionFields,
  migrateLegacyEncryptedString,
} from "./encryption";
import { invalidateDbCache } from "./readCache";
import { normalizeProviderSpecificData } from "@/lib/providers/requestDefaults";
import { bumpProxyConfigGeneration } from "./settings";
import { webSessionCredentialKey, parseProviderSpecificData } from "./webSessionDedup";
import {
  withNullableMaxConcurrent,
  withNullableQuotaWindowThresholds,
  withNullableRateLimitOverrides,
  normalizeBooleanColumn,
  sanitizeRateLimitOverrides,
  serializeJsonField,
  toRecord,
  sanitizeQuotaWindowThresholds,
  toStringOrNull,
  toNumberOrZero,
} from "./providers/columns";

type JsonRecord = Record<string, unknown>;

// ──────────────── Provider Connections ────────────────

export async function getProviderConnections(filter: JsonRecord = {}) {
  const db = getDbClient();
  let sql = "SELECT * FROM provider_connections";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.provider) {
    conditions.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.isActive !== undefined) {
    conditions.push("is_active = ?");
    params.push(filter.isActive ? 1 : 0);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY priority ASC, updated_at DESC";

  const rows = await db.all(sql, ...params);
  return rows.map((r) => {
    const camelRow = rowToCamel(r);
    return decryptConnectionFields(
      withNullableRateLimitOverrides(
        withNullableQuotaWindowThresholds(
          withNullableMaxConcurrent(cleanNulls(camelRow), camelRow),
          camelRow
        ),
        camelRow
      )
    );
  });
}

export async function getProviderConnectionById(id: string) {
  const db = getDbClient();
  const row = await db.get("SELECT * FROM provider_connections WHERE id = ?", id);
  if (!row) return null;

  const camelRow = rowToCamel(row);
  return decryptConnectionFields(
    withNullableRateLimitOverrides(
      withNullableQuotaWindowThresholds(
        withNullableMaxConcurrent(cleanNulls(camelRow), camelRow),
        camelRow
      ),
      camelRow
    )
  );
}

// #3368 PR6 — dedup web-session cookie/token credentials on connection create.
// Re-importing the same session (e.g. via bulk web-session import) under a
// different or blank name must update the existing connection instead of
// inserting a duplicate, mirroring the apikey dedup (#3023). Extracted from
// createProviderConnection to keep that function below the complexity baseline.
// provider_specific_data is plaintext JSON, so the value is compared directly
// without decryption.
async function findExistingCookieConnection(
  db: DbClient,
  provider: unknown,
  name: unknown,
  normalizedProviderSpecificData: unknown
): Promise<JsonRecord | null> {
  // 1) Name-based upsert for parity with the apikey path.
  if (name) {
    const byName =
      (await db.get<JsonRecord>(
        "SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'cookie' AND name = ?",
        provider,
        name
      )) || null;
    if (byName) return byName;
  }
  // 2) Credential-value dedup against existing cookie rows.
  const newCredKey = webSessionCredentialKey(normalizedProviderSpecificData);
  if (!newCredKey) return null;
  const cookieRows = await db.all<JsonRecord>(
    "SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'cookie'",
    provider
  );
  for (const row of cookieRows) {
    const psd = parseProviderSpecificData(row.provider_specific_data);
    if (psd && webSessionCredentialKey(psd) === newCredKey) return row;
  }
  return null;
}

export async function createProviderConnection(data: JsonRecord) {
  const db = getDbClient();
  const now = new Date().toISOString();
  const normalizedProviderSpecificData = normalizeProviderSpecificData(
    toStringOrNull(data.provider),
    data.providerSpecificData
  );

  // Upsert check
  // For Codex/OpenAI, a single email can have multiple workspaces (Team + Personal)
  // We need to check for workspace uniqueness, not just email
  let existing: JsonRecord | null = null;

  if (data.authType === "oauth" && data.email) {
    // For Codex, check for existing connection with same workspace
    const providerSpecificData = toRecord(data.providerSpecificData);
    const workspaceId = toStringOrNull(providerSpecificData.workspaceId);
    if (data.provider === "codex" && workspaceId) {
      // For Codex, check for existing connection with same workspace AND email
      // A single workspace can have multiple users (Team/Business plans)
      // We need both workspace + email uniqueness to allow multiple accounts
      existing =
        (await db.get<JsonRecord>(
          "SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'oauth' AND json_extract(provider_specific_data, '$.workspaceId') = ? AND email = ?",
          data.provider,
          workspaceId,
          data.email
        )) || null;

      // If no match with workspace+email, also check workspace-only for backward compat
      // (old connections without email should still be updated, not duplicated)
      if (!existing) {
        existing =
          (await db.get<JsonRecord>(
            "SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'oauth' AND json_extract(provider_specific_data, '$.workspaceId') = ? AND (email IS NULL OR email = '')",
            data.provider,
            workspaceId
          )) || null;
      }
      // For Codex with workspaceId, don't fall back to email-only check
      // This allows creating new connections for different workspaces
    } else {
      // For other providers (or Codex without workspaceId), match on email —
      // disambiguated by providerSpecificData.username when present on both
      // sides. Two different IdPs can share the same email address (e.g. a
      // Google account and a HuggingFace account); matching on email alone
      // would silently overwrite the other account's connection on the
      // second login. Only fall back to the bare email-only match when
      // neither side carries a username (legacy rows created before this
      // disambiguation existed).
      const incomingUsername = toStringOrNull(providerSpecificData.username);
      const emailMatches = await db.all<JsonRecord>(
        "SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'oauth' AND email = ?",
        data.provider,
        data.email
      );
      existing =
        emailMatches.find((row) => {
          const existingUsername = toStringOrNull(
            parseProviderSpecificData(row.provider_specific_data)?.username
          );
          if (incomingUsername && existingUsername) {
            return incomingUsername === existingUsername;
          }
          if (incomingUsername || existingUsername) return false;
          return true;
        }) || null;
    }
  } else if (data.authType === "apikey") {
    // Name-based upsert (existing behavior): same provider + same name → update.
    if (data.name) {
      existing =
        (await db.get<JsonRecord>(
          "SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'apikey' AND name = ?",
          data.provider,
          data.name
        )) || null;
    }
    // #3023 — dedup by API key value: re-adding the same key (under a different
    // or blank name) must update the existing connection, not insert a duplicate
    // row. Stored keys use non-deterministic AES-GCM, so ciphertext can't be
    // compared directly — decrypt each apikey row for this provider and match the
    // plaintext (trimmed) instead.
    const newApiKey = typeof data.apiKey === "string" ? data.apiKey.trim() : "";
    if (!existing && newApiKey) {
      const apiKeyRows = await db.all<JsonRecord>(
        "SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'apikey'",
        data.provider
      );
      for (const row of apiKeyRows) {
        const decrypted = decryptConnectionFields(toRecord(rowToCamel(row)));
        if (toStringOrNull(decrypted.apiKey)?.trim() === newApiKey) {
          existing = row;
          break;
        }
      }
    }
  } else if (data.authType === "cookie") {
    existing = await findExistingCookieConnection(
      db,
      data.provider,
      data.name,
      normalizedProviderSpecificData
    );
  } else if (data.authType === "access_token") {
    // #1290 — bare access-token imports (e.g. a raw ChatGPT website access
    // token with no refresh token) are intentionally never deduped: every
    // import creates a new connection. Unlike oauth (workspace+email) or
    // apikey (key-value) imports, a bare access token has no refresh token
    // and no stable long-lived identity to safely dedup against — matching
    // on email alone here would risk silently overwriting an existing full
    // oauth connection for the same account.
  }

  if (existing) {
    const existingId = toStringOrNull(existing.id);
    if (!existingId) return null;
    const merged: JsonRecord = { ...toRecord(rowToCamel(existing)), ...data, updatedAt: now };
    merged.providerSpecificData = normalizeProviderSpecificData(
      toStringOrNull(merged.provider),
      merged.providerSpecificData
    );
    await _updateConnectionRow(db, existingId, merged);
    backupDbFile("pre-write");
    return withNullableRateLimitOverrides(
      withNullableQuotaWindowThresholds(
        withNullableMaxConcurrent(cleanNulls(merged), merged),
        merged
      ),
      merged
    );
  }

  // Generate name: prefer explicit name, then email, then a stable short-ID label.
  // Avoid sequential "Account N" — it reassigns when accounts are deleted/reordered.
  let connectionName = data.name || null;
  if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
    if (data.email) {
      connectionName = data.email as string;
    } else if (data.displayName) {
      connectionName = data.displayName as string;
    }
    // Otherwise leave null — UI will fall back to getAccountDisplayName() → "Account #<id>"
  }

  // Auto-increment priority
  let connectionPriority = data.priority;
  if (!connectionPriority) {
    const max = await db.get<JsonRecord>(
      "SELECT MAX(priority) as maxP FROM provider_connections WHERE provider = ?",
      data.provider
    );
    const maxPriority = toNumberOrZero(toRecord(max).maxP);
    connectionPriority = maxPriority + 1;
  }

  const connection: Record<string, unknown> = {
    id: uuidv4(),
    provider: data.provider,
    authType: data.authType || "oauth",
    name: connectionName,
    priority: connectionPriority,
    isActive: data.isActive !== undefined ? data.isActive : true,
    createdAt: now,
    updatedAt: now,
    proxyEnabled: normalizeBooleanColumn(data.proxyEnabled, true),
    perKeyProxyEnabled: normalizeBooleanColumn(data.perKeyProxyEnabled, false),
  };

  // Optional fields
  const optionalFields = [
    "displayName",
    "email",
    "globalPriority",
    "defaultModel",
    "accessToken",
    "refreshToken",
    "expiresAt",
    "tokenType",
    "scope",
    "idToken",
    "projectId",
    "apiKey",
    "testStatus",
    "lastTested",
    "lastError",
    "lastErrorAt",
    "lastErrorType",
    "lastErrorSource",
    "rateLimitedUntil",
    "expiresIn",
    "errorCode",
    "consecutiveUseCount",
    "rateLimitProtection",
    "group",
    "maxConcurrent",
    "proxyEnabled",
    "perKeyProxyEnabled",
    "quotaWindowThresholds",
    "rateLimitOverrides",
    "healthCheckInterval",
  ];
  for (const field of optionalFields) {
    if (data[field] !== undefined && data[field] !== null) {
      connection[field] = data[field];
    }
  }
  if (normalizedProviderSpecificData && Object.keys(normalizedProviderSpecificData).length > 0) {
    connection.providerSpecificData = normalizedProviderSpecificData;
  }
  // Sanitize the window-thresholds map up front so the in-memory `connection`
  // matches the row we're about to insert. The serialize path runs the same
  // sanitizer on the way to SQLite. Assigning null (when sanitize collapses
  // to no-overrides) keeps the field present on the returned object so the
  // UI can tell "field was read, no overrides" apart from "field absent."
  if ("quotaWindowThresholds" in connection) {
    connection.quotaWindowThresholds = sanitizeQuotaWindowThresholds(
      connection.quotaWindowThresholds
    );
  }

  // Same sanitization for rateLimitOverrides — keep in-memory representation
  // in sync with what gets persisted.
  if ("rateLimitOverrides" in connection) {
    connection.rateLimitOverrides = sanitizeRateLimitOverrides(connection.rateLimitOverrides);
  }

  await _insertConnectionRow(db, encryptConnectionFields({ ...connection }));
  const providerId = toStringOrNull(data.provider);
  if (providerId) {
    await _reorderConnections(db, providerId);
  }
  backupDbFile("pre-write");
  invalidateDbCache("connections"); // Bust connections read cache

  return withNullableRateLimitOverrides(
    withNullableQuotaWindowThresholds(
      withNullableMaxConcurrent(cleanNulls(connection), connection),
      connection
    ),
    connection
  );
}

async function _insertConnectionRow(db: DbClient, conn: JsonRecord) {
  await db.run(
    `INSERT INTO provider_connections (
      id, provider, auth_type, name, email, priority, is_active,
      access_token, refresh_token, expires_at, token_expires_at,
      scope, project_id, test_status, error_code, last_error,
      last_error_at, last_error_type, last_error_source, backoff_level,
      rate_limited_until, health_check_interval, last_health_check_at,
      last_tested, api_key, id_token, provider_specific_data,
      expires_in, display_name, global_priority, default_model,
      token_type, consecutive_use_count, rate_limit_protection, last_used_at, "group", max_concurrent,
      proxy_enabled, per_key_proxy_enabled, quota_window_thresholds_json, rate_limit_overrides_json,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )`,
    conn.id,
    conn.provider,
    conn.authType || null,
    conn.name || null,
    conn.email || null,
    conn.priority || 0,
    conn.isActive === false ? 0 : 1,
    conn.accessToken || null,
    conn.refreshToken || null,
    conn.expiresAt || null,
    conn.tokenExpiresAt || null,
    conn.scope || null,
    conn.projectId || null,
    conn.testStatus || null,
    conn.errorCode || null,
    conn.lastError || null,
    conn.lastErrorAt || null,
    conn.lastErrorType || null,
    conn.lastErrorSource || null,
    conn.backoffLevel || 0,
    conn.rateLimitedUntil || null,
    conn.healthCheckInterval ?? null,
    conn.lastHealthCheckAt || null,
    conn.lastTested || null,
    conn.apiKey || null,
    conn.idToken || null,
    conn.providerSpecificData ? JSON.stringify(conn.providerSpecificData) : null,
    conn.expiresIn || null,
    conn.displayName || null,
    conn.globalPriority || null,
    conn.defaultModel || null,
    conn.tokenType || null,
    conn.consecutiveUseCount || 0,
    conn.rateLimitProtection === true || conn.rateLimitProtection === 1 ? 1 : 0,
    conn.lastUsedAt || null,
    conn.group || null,
    conn.maxConcurrent ?? null,
    normalizeBooleanColumn(conn.proxyEnabled, true) ? 1 : 0,
    normalizeBooleanColumn(conn.perKeyProxyEnabled, false) ? 1 : 0,
    serializeJsonField(conn.quotaWindowThresholds),
    serializeJsonField(conn.rateLimitOverrides),
    conn.createdAt,
    conn.updatedAt
  );
}

async function _updateConnectionRow(db: DbClient, id: string, data: JsonRecord) {
  const now = data.updatedAt || new Date().toISOString();
  await db.run(
    `UPDATE provider_connections SET
      provider = ?, auth_type = ?, name = ?, email = ?,
      priority = ?, is_active = ?, access_token = ?,
      refresh_token = ?, expires_at = ?, token_expires_at = ?,
      scope = ?, project_id = ?, test_status = ?, error_code = ?,
      last_error = ?, last_error_at = ?, last_error_type = ?,
      last_error_source = ?, backoff_level = ?,
      rate_limited_until = ?, health_check_interval = ?,
      last_health_check_at = ?, last_tested = ?, api_key = ?,
      id_token = ?, provider_specific_data = ?,
      expires_in = ?, display_name = ?, global_priority = ?,
      default_model = ?, token_type = ?,
      consecutive_use_count = ?,
      rate_limit_protection = ?,
      last_used_at = ?,
      "group" = ?,
      max_concurrent = ?,
      quota_window_thresholds_json = ?,
      proxy_enabled = ?,
      per_key_proxy_enabled = ?,
      rate_limit_overrides_json = ?,
      updated_at = ?
    WHERE id = ?`,
    data.provider,
    data.authType || null,
    data.name || null,
    data.email || null,
    data.priority || 0,
    data.isActive === false ? 0 : 1,
    data.accessToken || null,
    data.refreshToken || null,
    data.expiresAt || null,
    data.tokenExpiresAt || null,
    data.scope || null,
    data.projectId || null,
    data.testStatus || null,
    data.errorCode || null,
    data.lastError || null,
    data.lastErrorAt || null,
    data.lastErrorType || null,
    data.lastErrorSource || null,
    data.backoffLevel || 0,
    data.rateLimitedUntil || null,
    data.healthCheckInterval ?? null,
    data.lastHealthCheckAt || null,
    data.lastTested || null,
    data.apiKey || null,
    data.idToken || null,
    data.providerSpecificData ? JSON.stringify(data.providerSpecificData) : null,
    data.expiresIn || null,
    data.displayName || null,
    data.globalPriority || null,
    data.defaultModel || null,
    data.tokenType || null,
    data.consecutiveUseCount || 0,
    data.rateLimitProtection === true || data.rateLimitProtection === 1 ? 1 : 0,
    data.lastUsedAt || null,
    data.group || null,
    data.maxConcurrent ?? null,
    serializeJsonField(data.quotaWindowThresholds),
    normalizeBooleanColumn(data.proxyEnabled, true) ? 1 : 0,
    normalizeBooleanColumn(data.perKeyProxyEnabled, false) ? 1 : 0,
    serializeJsonField(data.rateLimitOverrides),
    now,
    id
  );
}

export async function updateProviderConnection(id: string, data: JsonRecord) {
  const db = getDbClient();
  const existing = await db.get("SELECT * FROM provider_connections WHERE id = ?", id);
  if (!existing) return null;

  const merged: JsonRecord = {
    ...toRecord(rowToCamel(existing)),
    ...data,
    updatedAt: new Date().toISOString(),
  };
  merged.providerSpecificData = normalizeProviderSpecificData(
    toStringOrNull(merged.provider),
    merged.providerSpecificData
  );
  // Mirror the sanitization the create path applies — keep the returned
  // object in lockstep with what we persist.
  if ("quotaWindowThresholds" in merged) {
    const sanitized = sanitizeQuotaWindowThresholds(merged.quotaWindowThresholds);
    // For updates we always carry the key forward (even as null) so the read
    // path surfaces the cleared state to callers that just patched it.
    merged.quotaWindowThresholds = sanitized;
  }
  if ("rateLimitOverrides" in merged) {
    merged.rateLimitOverrides = sanitizeRateLimitOverrides(merged.rateLimitOverrides);
  }
  await _updateConnectionRow(db, id, encryptConnectionFields({ ...merged }));
  backupDbFile("pre-write");
  invalidateDbCache("connections"); // Bust connections read cache
  bumpProxyConfigGeneration();

  if (data.priority !== undefined) {
    const existingRecord = toRecord(existing);
    const providerId =
      typeof existingRecord.provider === "string"
        ? existingRecord.provider
        : String(existingRecord.provider || "");
    await _reorderConnections(db, providerId);
  }

  return withNullableRateLimitOverrides(
    withNullableQuotaWindowThresholds(
      withNullableMaxConcurrent(cleanNulls(merged), merged),
      merged
    ),
    merged
  );
}

/**
 * Atomic conditional clear of recoverable error state on a connection row.
 *
 * Returns true when the row was cleared, false when a concurrent writer
 * (markAccountUnavailable, connectionRecovery tick, test, etc.) changed the
 * row between the caller's snapshot read and this UPDATE — in which case the
 * clear is skipped to preserve the freshest error state. Closes the TOCTOU
 * window in the quota-recovery path.
 *
 * CAS token = (test_status, last_error_at, rate_limited_until).
 * markAccountUnavailable always bumps last_error_at on every cooldown/error
 * write, so an unchanged last_error_at reliably indicates no concurrent write.
 */
export async function clearConnectionErrorIfUnchanged(
  id: string,
  expected: {
    testStatus: string | null | undefined;
    lastErrorAt: string | null | undefined;
    rateLimitedUntil: string | null | undefined;
  }
): Promise<boolean> {
  const db = getDbClient();
  const result = await db.run(
    `UPDATE provider_connections SET
      test_status = 'active',
      last_error = NULL,
      last_error_at = NULL,
      last_error_type = NULL,
      last_error_source = NULL,
      error_code = NULL,
      rate_limited_until = NULL,
      backoff_level = 0,
      updated_at = ?
    WHERE id = ?
      AND IFNULL(test_status, '') = ?
      AND IFNULL(last_error_at, '') = ?
      AND IFNULL(rate_limited_until, '') = ?`,
    new Date().toISOString(),
    id,
    expected.testStatus ?? "",
    expected.lastErrorAt ?? "",
    expected.rateLimitedUntil ?? ""
  );
  const applied = (result.changes ?? 0) > 0;
  if (applied) {
    backupDbFile("pre-write");
    invalidateDbCache("connections");
    bumpProxyConfigGeneration();
  }
  return applied;
}

export async function deleteProviderConnection(id: string) {
  const db = getDbClient();
  const existing = await db.get("SELECT provider FROM provider_connections WHERE id = ?", id);
  if (!existing) return false;

  await db.run("DELETE FROM quota_snapshots WHERE connection_id = ?", id);
  await db.run("DELETE FROM provider_connections WHERE id = ?", id);
  bumpProxyConfigGeneration();
  const existingRecord = toRecord(existing);
  const providerId =
    typeof existingRecord.provider === "string"
      ? existingRecord.provider
      : String(existingRecord.provider || "");
  await _reorderConnections(db, providerId);
  backupDbFile("pre-write");
  invalidateDbCache("connections"); // Bust connections read cache
  return true;
}

export async function deleteProviderConnections(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const db = getDbClient();

  const deletedCount = await db.transaction(async (c) => {
    const placeholders = ids.map(() => "?").join(",");
    await c.run(`DELETE FROM quota_snapshots WHERE connection_id IN (${placeholders})`, ...ids);
    const result = await c.run(
      `DELETE FROM provider_connections WHERE id IN (${placeholders})`,
      ...ids
    );
    return result.changes ?? 0;
  });

  backupDbFile("pre-write");
  invalidateDbCache("connections");
  return deletedCount;
}

export async function deleteProviderConnectionsByProvider(providerId: string) {
  const db = getDbClient();
  const connectionIds = (
    await db.all<{ id: string }>(
      "SELECT id FROM provider_connections WHERE provider = ?",
      providerId
    )
  )
    .map((row) => (typeof row.id === "string" ? row.id : null))
    .filter((id): id is string => id !== null);

  if (connectionIds.length > 0) {
    for (const connectionId of connectionIds) {
      await db.run("DELETE FROM quota_snapshots WHERE connection_id = ?", connectionId);
    }
  }

  const result = await db.run(
    "DELETE FROM provider_connections WHERE provider = ?",
    providerId
  );
  backupDbFile("pre-write");
  return result.changes;
}

export async function reorderProviderConnections(providerId: string) {
  const db = getDbClient();
  await _reorderConnections(db, providerId);
}

async function _reorderConnections(db: DbClient, providerId: string) {
  const rows = await db.all<{ id: unknown; priority: unknown; updated_at: unknown }>(
    "SELECT id, priority, updated_at FROM provider_connections WHERE provider = ? ORDER BY priority ASC, updated_at DESC",
    providerId
  );

  for (let index = 0; index < rows.length; index++) {
    const current = toRecord(rows[index]);
    await db.run("UPDATE provider_connections SET priority = ? WHERE id = ?", index + 1, current.id);
  }
}

export async function cleanupProviderConnections() {
  return 0;
}

export async function getDistinctGroups(): Promise<string[]> {
  const db = getDbClient();
  const rows = await db.all<{ group?: string }>(
    'SELECT DISTINCT "group" FROM provider_connections WHERE "group" IS NOT NULL ORDER BY "group"'
  );
  return rows.map((r) => String(r.group ?? "")).filter(Boolean);
}

// ──────────────── Auto Migration ────────────────

/**
 * Scans all connections and re-encrypts any fields using the old dynamic salt
 * so they use the new canonical static salt.
 */
export async function autoMigrateLegacyEncryptedConnections(): Promise<number> {
  const db = getDbClient();
  const rows = await db.all("SELECT * FROM provider_connections");
  let migratedCount = 0;

  for (const row of rows) {
    const camelRow = rowToCamel(row);
    if (!camelRow) continue;

    let updatedRow = false;

    const encryptedFields = ["apiKey", "idToken", "accessToken", "refreshToken"];
    for (const field of encryptedFields) {
      if (typeof camelRow[field] === "string") {
        const { updated, value } = migrateLegacyEncryptedString(camelRow[field] as string);
        if (updated) {
          camelRow[field] = value;
          updatedRow = true;
        }
      }
    }

    if (updatedRow) {
      // camelRow[field] is already re-encrypted!
      // But _updateConnectionRow does not re-encrypt automatically, so we pass it safely.
      // Wait, _updateConnectionRow runs the full data through `encryptConnectionFields`,
      // but `encryptConnectionFields` will re-encrypt plain text.
      // BUT `migrateLegacyEncryptedString` returns ALREADY ENCRYPTED ciphertext!
      // Wait... if we pass ALREADY ENCRYPTED text to `_updateConnectionRow`,
      // `encryptConnectionFields` in `_updateConnectionRow` will encrypt it AGAIN!
      // Let's modify the DB directly so we don't double encrypt.

      await db.run(
        "UPDATE provider_connections SET api_key = ?, id_token = ?, access_token = ?, refresh_token = ?, updated_at = ? WHERE id = ?",
        camelRow.apiKey ?? null,
        camelRow.idToken ?? null,
        camelRow.accessToken ?? null,
        camelRow.refreshToken ?? null,
        new Date().toISOString(),
        camelRow.id
      );
      migratedCount++;
    }
  }

  if (migratedCount > 0) {
    backupDbFile("pre-write");
    invalidateDbCache("connections");
    console.log(`[DB] Auto-migrated ${migratedCount} connection(s) to new static-salt encryption.`);
  }

  return migratedCount;
}

// ──────────────── Re-exports from leaf modules ────────────────

export {
  getProviderNodes,
  getProviderNodeById,
  resolveProviderNodeForConnection,
  createProviderNode,
  updateProviderNode,
  deleteProviderNode,
} from "./providers/nodes";
export {
  setConnectionRateLimitUntil,
  markConnectionRateLimitedUntil,
  clearConnectionRateLimit,
  isConnectionRateLimited,
  getRateLimitedConnections,
  getEffectiveQuotaUsage,
  clearStaleCrashCooldowns,
  formatResetCountdown,
} from "./providers/rateLimit";
