/** db/models/mitmAlias.ts — MITM alias CRUD (mitmAlias namespace). */

import { getDbClient } from "../core";
import { backupDbFile } from "../backup";
import { getKeyValue } from "./shared";

export async function getMitmAlias(toolName?: string) {
  const db = getDbClient();
  if (toolName) {
    const row = await db.get(
      "SELECT value FROM key_value WHERE namespace = 'mitmAlias' AND key = ?",
      toolName
    );
    const value = getKeyValue(row).value;
    return value ? JSON.parse(value) : {};
  }
  const rows = await db.all("SELECT key, value FROM key_value WHERE namespace = 'mitmAlias'");
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const { key, value } = getKeyValue(row);
    if (!key || value === null) continue;
    result[key] = JSON.parse(value);
  }
  return result;
}

export async function setMitmAliasAll(toolName: string, mappings: unknown) {
  const db = getDbClient();
  await db.run(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('mitmAlias', ?, ?)",
    toolName,
    JSON.stringify(mappings || {})
  );
  backupDbFile("pre-write");
}
