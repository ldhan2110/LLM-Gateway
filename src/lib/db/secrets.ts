import { getDbClient } from "./core";

interface SecretRow {
  value?: string;
}

export async function getPersistedSecret(key: string): Promise<string | null> {
  try {
    const db = getDbClient();
    const row = await db.get<SecretRow>(
      "SELECT value FROM key_value WHERE namespace = 'secrets' AND key = ?",
      key
    );
    return typeof row?.value === "string" ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

export async function persistSecret(key: string, value: string): Promise<void> {
  try {
    const db = getDbClient();
    await db.run(
      "INSERT OR IGNORE INTO key_value (namespace, key, value) VALUES ('secrets', ?, ?)",
      key,
      JSON.stringify(value)
    );
  } catch {
    // Non-fatal: secrets still work for the current process if persistence fails.
  }
}
