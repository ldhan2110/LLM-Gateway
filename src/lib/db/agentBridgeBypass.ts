/**
 * Database module: AgentBridgeBypass
 * CRUD + seed for agent_bridge_bypass table.
 */

import { getDbClient } from "./core.ts";
import type { AgentBridgeBypassRow } from "./_rowTypes.ts";

// SQLite rows have source as plain string
interface AgentBridgeBypassDbRow {
  pattern: string;
  source: string;
  created_at: string;
}

function mapRow(row: AgentBridgeBypassDbRow): AgentBridgeBypassRow {
  return {
    pattern: row.pattern,
    source: row.source as "default" | "user",
    created_at: row.created_at,
  };
}

export async function getAllBypassPatterns(): Promise<AgentBridgeBypassRow[]> {
  const db = getDbClient();
  const rows = await db.all<AgentBridgeBypassDbRow>(
    "SELECT pattern, source, created_at FROM agent_bridge_bypass ORDER BY source ASC, pattern ASC"
  );
  return rows.map(mapRow);
}

export async function getUserBypassPatterns(): Promise<string[]> {
  const db = getDbClient();
  const rows = await db.all<{ pattern: string }>(
    "SELECT pattern FROM agent_bridge_bypass WHERE source = 'user' ORDER BY pattern ASC"
  );
  return rows.map((r) => r.pattern);
}

export async function replaceUserBypassPatterns(patterns: string[]): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();

  await db.transaction(async (c) => {
    await c.run("DELETE FROM agent_bridge_bypass WHERE source = 'user'");
    for (const pattern of patterns) {
      await c.run(
        "INSERT INTO agent_bridge_bypass (pattern, source, created_at) VALUES (?, 'user', ?)",
        pattern, now
      );
    }
  });
}

/**
 * Seeds default bypass patterns — idempotent.
 * Only inserts a pattern if it does not already exist in the table.
 * Called at app boot by the AgentBridge manager (F3 will wire this).
 */
export async function seedDefaultBypassPatterns(defaults: string[]): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();

  await db.transaction(async (c) => {
    for (const pattern of defaults) {
      await c.run(
        "INSERT OR IGNORE INTO agent_bridge_bypass (pattern, source, created_at) VALUES (?, 'default', ?)",
        pattern, now
      );
    }
  });
}
