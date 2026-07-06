/**
 * db/settings/lkgp.ts — Last Known Good Provider (LKGP) persistence.
 */

import { getDbClient } from "../core";

export interface LKGPRecord {
  provider: string;
  connectionId?: string;
}

export async function getLKGP(comboName: string, modelId: string): Promise<LKGPRecord | null> {
  const db = getDbClient();
  const key = `${comboName}:${modelId}`;
  const row = await db.get<{ value?: string }>(
    "SELECT value FROM key_value WHERE namespace = 'lkgp' AND key = ?",
    key
  );
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (typeof parsed === "object" && parsed !== null && "provider" in parsed) {
      return parsed as LKGPRecord;
    }
    return { provider: String(parsed) };
  } catch {
    return { provider: row.value };
  }
}

export async function setLKGP(
  comboName: string,
  modelId: string,
  providerId: string,
  connectionId?: string
): Promise<void> {
  const db = getDbClient();
  const key = `${comboName}:${modelId}`;
  const value: LKGPRecord = { provider: providerId };
  if (connectionId) value.connectionId = connectionId;
  await db.run(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('lkgp', ?, ?)",
    key,
    JSON.stringify(value)
  );
}

export async function clearAllLKGP(): Promise<void> {
  const db = getDbClient();
  await db.run("DELETE FROM key_value WHERE namespace = 'lkgp'");
}
