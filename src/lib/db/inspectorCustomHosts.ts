/**
 * Database module: InspectorCustomHosts
 * CRUD operations for inspector_custom_hosts table.
 */

import { getDbClient } from "./core";
import type { InspectorCustomHostRow } from "./_rowTypes.ts";

// SQLite stores booleans as integers
interface InspectorCustomHostDbRow {
  host: string;
  enabled: number;
  label: string | null;
  kind: string;
  added_at: string;
  last_seen_at: string | null;
}

function mapRow(row: InspectorCustomHostDbRow): InspectorCustomHostRow {
  return {
    host: row.host,
    enabled: row.enabled === 1,
    label: row.label,
    kind: row.kind as "llm" | "app" | "custom",
    added_at: row.added_at,
    last_seen_at: row.last_seen_at,
  };
}

export async function listCustomHosts(opts?: { enabledOnly?: boolean }): Promise<InspectorCustomHostRow[]> {
  const db = getDbClient();
  const enabledOnly = opts?.enabledOnly === true;

  const rows = enabledOnly
    ? await db.all<InspectorCustomHostDbRow>("SELECT * FROM inspector_custom_hosts WHERE enabled = 1 ORDER BY host ASC")
    : await db.all<InspectorCustomHostDbRow>("SELECT * FROM inspector_custom_hosts ORDER BY host ASC");

  return rows.map(mapRow);
}

export async function addCustomHost(
  host: string,
  kind: "llm" | "app" | "custom" = "custom",
  label?: string
): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.run(
    `INSERT OR IGNORE INTO inspector_custom_hosts (host, enabled, label, kind, added_at)
     VALUES (?, 1, ?, ?, ?)`,
    host, label ?? null, kind, now
  );
}

export async function removeCustomHost(host: string): Promise<void> {
  const db = getDbClient();
  await db.run("DELETE FROM inspector_custom_hosts WHERE host = ?", host);
}

export async function toggleCustomHost(host: string, enabled: boolean): Promise<void> {
  const db = getDbClient();
  await db.run(
    "UPDATE inspector_custom_hosts SET enabled = ? WHERE host = ?",
    enabled ? 1 : 0, host
  );
}

export async function touchLastSeen(host: string): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.run(
    "UPDATE inspector_custom_hosts SET last_seen_at = ? WHERE host = ?",
    now, host
  );
}

/**
 * Returns true when `host` is present in inspector_custom_hosts with enabled=1.
 * Used by agentBridgeHook to distinguish custom-host intercepts from agent-bridge
 * intercepts so that Mode 2 (Custom Hosts) entries appear in the "Custom" profile.
 */
export async function isCustomHost(host: string): Promise<boolean> {
  const db = getDbClient();
  const row = await db.get<{ found: number }>(
    "SELECT 1 AS found FROM inspector_custom_hosts WHERE host = ? AND enabled = 1",
    host
  );
  return row !== undefined;
}
