import { getDbClient } from "./core";

const ENCRYPTED_COLUMNS = ["api_key", "access_token", "refresh_token", "id_token"] as const;

const ENCRYPTED_PATTERN = "enc:v1:%";

function buildWhereClause(): string {
  return ENCRYPTED_COLUMNS.map((col) => `${col} LIKE '${ENCRYPTED_PATTERN}'`).join(" OR ");
}

export async function countEncryptedCredentials(): Promise<number> {
  const db = getDbClient();
  const where = buildWhereClause();
  const row = await db.get<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM provider_connections WHERE ${where}`
  );
  return row?.cnt ?? 0;
}

export async function resetEncryptedColumns({
  dryRun,
}: {
  dryRun: boolean;
}): Promise<{ affected: number }> {
  const affected = await countEncryptedCredentials();
  if (dryRun || affected === 0) return { affected };

  const db = getDbClient();
  const nullCols = ENCRYPTED_COLUMNS.map((col) => `${col} = NULL`).join(", ");
  const where = buildWhereClause();
  await db.run(`UPDATE provider_connections SET ${nullCols} WHERE ${where}`);

  return { affected };
}
