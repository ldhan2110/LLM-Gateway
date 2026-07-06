/**
 * CLI Tool State Persistence
 *
 * Stores last-configured timestamps and initial config snapshots
 * for CLI tools in the key_value table.
 *
 * Namespaces:
 *   - cliToolLastConfig: ISO timestamp of last configuration
 *   - cliToolInitialConfig: JSON snapshot of pre-OmniRoute configuration
 *
 * @module lib/db/cliToolState
 */

import { getDbClient, isBuildPhase, isCloud } from "./core";

type JsonRecord = Record<string, unknown>;

interface KeyValueRow {
  key: string;
  value: string;
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

// ──────────────── Last Configured Timestamp ────────────────

/**
 * Save last-configured timestamp for a CLI tool.
 */
export async function saveCliToolLastConfigured(
  toolId: string,
  timestamp: string = new Date().toISOString()
): Promise<void> {
  if (isBuildPhase || isCloud) return;
  const db = getDbClient();
  await db.run(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)",
    "cliToolLastConfig",
    toolId,
    JSON.stringify(timestamp)
  );
}

/**
 * Get last-configured timestamp for a CLI tool.
 * @returns ISO timestamp string or null if never configured.
 */
export async function getCliToolLastConfigured(toolId: string): Promise<string | null> {
  if (isBuildPhase || isCloud) return null;
  const db = getDbClient();
  const row = await db.get<KeyValueRow>(
    "SELECT value FROM key_value WHERE namespace = ? AND key = ?",
    "cliToolLastConfig",
    toolId
  );
  if (!row) return null;
  const parsed = parseJsonValue(row.value);
  return typeof parsed === "string" ? parsed : null;
}

/**
 * Get all CLI tool last-configured timestamps.
 * @returns Record<toolId, ISO timestamp>
 */
export async function getAllCliToolLastConfigured(): Promise<Record<string, string>> {
  if (isBuildPhase || isCloud) return {};
  const db = getDbClient();
  const rows = await db.all<KeyValueRow>(
    "SELECT key, value FROM key_value WHERE namespace = ?",
    "cliToolLastConfig"
  );
  const result: Record<string, string> = {};
  for (const row of rows) {
    const parsed = parseJsonValue(row.value);
    if (typeof parsed === "string") {
      result[row.key] = parsed;
    }
  }
  return result;
}

/**
 * Delete last-configured timestamp for a CLI tool.
 */
export async function deleteCliToolLastConfigured(toolId: string): Promise<void> {
  if (isBuildPhase || isCloud) return;
  const db = getDbClient();
  await db.run(
    "DELETE FROM key_value WHERE namespace = ? AND key = ?",
    "cliToolLastConfig",
    toolId
  );
}

// ──────────────── Initial Config Snapshot ────────────────

/**
 * Save the initial (pre-OmniRoute) config snapshot for a CLI tool.
 * Only saves if no snapshot exists yet (first-time only).
 * @returns true if saved, false if snapshot already exists.
 */
export async function saveCliToolInitialConfig(
  toolId: string,
  config: JsonRecord
): Promise<boolean> {
  if (isBuildPhase || isCloud) return false;
  const db = getDbClient();
  // Only save if not already stored
  const existing = await db.get<KeyValueRow>(
    "SELECT value FROM key_value WHERE namespace = ? AND key = ?",
    "cliToolInitialConfig",
    toolId
  );
  if (existing) return false;

  await db.run(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)",
    "cliToolInitialConfig",
    toolId,
    JSON.stringify(config)
  );
  return true;
}

/**
 * Get the initial config snapshot for a CLI tool.
 * @returns Config object or null if no snapshot exists.
 */
export async function getCliToolInitialConfig(toolId: string): Promise<JsonRecord | null> {
  if (isBuildPhase || isCloud) return null;
  const db = getDbClient();
  const row = await db.get<KeyValueRow>(
    "SELECT value FROM key_value WHERE namespace = ? AND key = ?",
    "cliToolInitialConfig",
    toolId
  );
  if (!row) return null;
  const parsed = parseJsonValue(row.value);
  return toRecord(parsed);
}

/**
 * Delete the initial config snapshot for a CLI tool.
 */
export async function deleteCliToolInitialConfig(toolId: string): Promise<void> {
  if (isBuildPhase || isCloud) return;
  const db = getDbClient();
  await db.run(
    "DELETE FROM key_value WHERE namespace = ? AND key = ?",
    "cliToolInitialConfig",
    toolId
  );
}
