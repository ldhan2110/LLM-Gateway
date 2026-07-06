import { getDbClient } from "./core";

const NOTION_NAMESPACE = "notion";
const NOTION_TOKEN_KEY = "integration_token";

type KeyValueRow = {
  value?: string;
};

export async function getNotionToken(): Promise<string | null> {
  try {
    const db = getDbClient();
    const row = await db.get<KeyValueRow>(
      "SELECT value FROM key_value WHERE namespace = ? AND key = ?",
      NOTION_NAMESPACE,
      NOTION_TOKEN_KEY
    );
    return typeof row?.value === "string" ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

export async function setNotionToken(token: string): Promise<void> {
  try {
    const db = getDbClient();
    await db.run(
      "INSERT OR IGNORE INTO key_value (namespace, key, value) VALUES (?, ?, ?)",
      NOTION_NAMESPACE,
      NOTION_TOKEN_KEY,
      JSON.stringify(token)
    );
  } catch {
    // Non-fatal — token still works in-memory if persistence fails.
  }
}

export async function clearNotionToken(): Promise<void> {
  try {
    const db = getDbClient();
    await db.run(
      "DELETE FROM key_value WHERE namespace = ? AND key = ?",
      NOTION_NAMESPACE,
      NOTION_TOKEN_KEY
    );
  } catch {
    // Non-fatal.
  }
}

export async function getNotionConfig(): Promise<{ token: string | null; connected: boolean }> {
  const token = await getNotionToken();
  return { token, connected: token !== null && token.length > 0 };
}
