/**
 * Middleware Hooks DB — CRUD operations for middleware_hooks table
 *
 * Module: src/lib/db/middleware.ts
 * Table: middleware_hooks
 * Logs:  middleware_logs
 */

import { getDbClient } from "@/lib/db/core";
import type { HookConfig, HookConfigRow, HookLogEntry, HookScope } from "@/lib/middleware/types";

// ── Helpers ───────────────────────────────────────────────────────────────

function rowToHookConfig(row: HookConfigRow): HookConfig {
  return {
    name: row.name,
    description: row.description,
    priority: row.priority,
    scope:
      row.scope_type === "combo" && row.combo_id
        ? { type: "combo", comboId: row.combo_id }
        : { type: "global" },
    enabled: row.enabled === 1,
    code: row.code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runCount: row.run_count,
    lastError: row.last_error || undefined,
  };
}

function hookConfigToRow(config: HookConfig): HookConfigRow {
  return {
    name: config.name,
    description: config.description,
    priority: config.priority,
    scope_type: config.scope.type,
    combo_id: config.scope.type === "combo" ? config.scope.comboId : null,
    enabled: config.enabled ? 1 : 0,
    code: config.code,
    created_at: config.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    run_count: config.runCount || 0,
    last_error: config.lastError,
  };
}

// ── CRUD Operations ───────────────────────────────────────────────────────

/**
 * Get all hooks from DB.
 */
export async function getAllMiddlewareHooks(): Promise<HookConfig[]> {
  const db = getDbClient();
  const rows = await db.all<HookConfigRow>(
    "SELECT * FROM middleware_hooks ORDER BY priority ASC, name ASC"
  );
  return rows.map(rowToHookConfig);
}

/**
 * Get enabled hooks from DB (for runtime loading).
 */
export async function getEnabledMiddlewareHooks(): Promise<HookConfig[]> {
  const db = getDbClient();
  const rows = await db.all<HookConfigRow>(
    "SELECT * FROM middleware_hooks WHERE enabled = 1 ORDER BY priority ASC"
  );
  return rows.map(rowToHookConfig);
}

/**
 * Get scoped hooks for a given combo ID.
 */
export async function getComboMiddlewareHooks(comboId: string): Promise<HookConfig[]> {
  const db = getDbClient();
  const rows = await db.all<HookConfigRow>(
    "SELECT * FROM middleware_hooks WHERE enabled = 1 AND (scope_type = 'global' OR (scope_type = 'combo' AND combo_id = ?)) ORDER BY priority ASC",
    comboId
  );
  return rows.map(rowToHookConfig);
}

/**
 * Get a single hook by name.
 */
export async function getMiddlewareHook(name: string): Promise<HookConfig | undefined> {
  const db = getDbClient();
  const row = await db.get<HookConfigRow>(
    "SELECT * FROM middleware_hooks WHERE name = ?",
    name
  );
  return row ? rowToHookConfig(row) : undefined;
}

/**
 * Create a new middleware hook.
 */
export async function createMiddlewareHook(config: HookConfig): Promise<HookConfig> {
  const db = getDbClient();
  const row = hookConfigToRow(config);
  row.created_at = new Date().toISOString();
  row.updated_at = row.created_at;

  await db.run(
    `INSERT INTO middleware_hooks (name, description, priority, scope_type, combo_id, enabled, code, created_at, updated_at, run_count, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.name,
    row.description,
    row.priority,
    row.scope_type,
    row.combo_id,
    row.enabled,
    row.code,
    row.created_at,
    row.updated_at,
    row.run_count,
    row.last_error
  );

  return (await getMiddlewareHook(config.name))!;
}

/**
 * Update an existing middleware hook.
 */
export async function updateMiddlewareHook(
  name: string,
  updates: Partial<HookConfig>
): Promise<HookConfig | undefined> {
  const existing = await getMiddlewareHook(name);
  if (!existing) return undefined;

  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  const row = hookConfigToRow(updated);
  const db = getDbClient();

  await db.run(
    `UPDATE middleware_hooks SET
      description = ?,
      priority = ?,
      scope_type = ?,
      combo_id = ?,
      enabled = ?,
      code = ?,
      updated_at = ?,
      run_count = ?,
      last_error = ?
    WHERE name = ?`,
    row.description,
    row.priority,
    row.scope_type,
    row.combo_id,
    row.enabled,
    row.code,
    row.updated_at,
    row.run_count,
    row.last_error,
    row.name
  );

  return getMiddlewareHook(name);
}

/**
 * Delete a middleware hook.
 */
export async function deleteMiddlewareHook(name: string): Promise<boolean> {
  const db = getDbClient();
  const result = await db.run("DELETE FROM middleware_hooks WHERE name = ?", name);
  return result.changes > 0;
}

/**
 * Increment run count and optionally update last error.
 */
export async function recordHookExecution(name: string, error?: string): Promise<void> {
  const db = getDbClient();
  if (error) {
    await db.run(
      "UPDATE middleware_hooks SET run_count = run_count + 1, last_error = ?, updated_at = datetime('now') WHERE name = ?",
      error,
      name
    );
  } else {
    await db.run(
      "UPDATE middleware_hooks SET run_count = run_count + 1, last_error = NULL, updated_at = datetime('now') WHERE name = ?",
      name
    );
  }
}

// ── Log Operations ────────────────────────────────────────────────────────

/**
 * Insert a hook execution log entry.
 */
export async function insertHookLog(entry: HookLogEntry): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT INTO middleware_logs (id, hook_name, request_id, duration_ms, mutated, skipped, error, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    entry.id,
    entry.hookName,
    entry.requestId,
    entry.durationMs,
    entry.mutated ? 1 : 0,
    entry.skipped ? 1 : 0,
    entry.error || null,
    entry.timestamp
  );
}

/**
 * Get hook execution logs, optionally filtered by hook name.
 */
export async function getHookLogs(hookName?: string, limit = 50): Promise<HookLogEntry[]> {
  const db = getDbClient();
  let rows: any[];
  if (hookName) {
    rows = await db.all(
      "SELECT * FROM middleware_logs WHERE hook_name = ? ORDER BY timestamp DESC LIMIT ?",
      hookName,
      limit
    );
  } else {
    rows = await db.all(
      "SELECT * FROM middleware_logs ORDER BY timestamp DESC LIMIT ?",
      limit
    );
  }
  return rows.map((r: any) => ({
    id: r.id,
    hookName: r.hook_name,
    requestId: r.request_id,
    durationMs: r.duration_ms,
    mutated: r.mutated === 1,
    skipped: r.skipped === 1,
    error: r.error,
    timestamp: r.timestamp,
  }));
}

/**
 * Clean up old hook logs (keep last N entries).
 */
export async function cleanupHookLogs(maxEntries = 10000): Promise<number> {
  const db = getDbClient();
  const result = await db.run(
    `DELETE FROM middleware_logs WHERE id NOT IN (
      SELECT id FROM middleware_logs ORDER BY timestamp DESC LIMIT ?
    )`,
    maxEntries
  );
  return result.changes;
}
