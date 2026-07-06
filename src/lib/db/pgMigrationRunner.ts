/**
 * PostgreSQL Migration Runner — applies numbered .sql files from migrations-pg/
 * using the async DbClient interface.
 *
 * Same versioning scheme as the SQLite runner (NNN_description.sql tracked in
 * _omniroute_migrations), but uses DbClient.exec() instead of SqliteAdapter.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { DbClient } from "./adapters/dbClient";

export function resolvePgMigrationsDir(): string {
  const configuredDir = process.env.OMNIROUTE_PG_MIGRATIONS_DIR;
  if (typeof configuredDir === "string" && configuredDir.trim().length > 0) {
    return path.resolve(configuredDir);
  }

  const checkLocations = (basePath: string) => {
    const locations = [
      path.join(basePath, "migrations-pg"),
      path.join(basePath, "src", "lib", "db", "migrations-pg"),
    ];
    for (const loc of locations) {
      if (fs.existsSync(loc)) return loc;
    }
    return null;
  };

  try {
    let currentDir = path.dirname(fileURLToPath(import.meta.url));
    while (currentDir !== path.dirname(currentDir)) {
      const found = checkLocations(currentDir);
      if (found) return found;
      currentDir = path.dirname(currentDir);
    }
  } catch {
    // Fall through
  }

  const fromCwd = checkLocations(process.cwd());
  if (fromCwd) return fromCwd;

  throw new Error(
    "[PG Migration] Could not resolve migrations-pg directory. " +
      "Set OMNIROUTE_PG_MIGRATIONS_DIR."
  );
}

function getPgMigrationFiles(
  dir: string
): Array<{ version: string; name: string; path: string }> {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const match = filename.match(/^(\d+)_(.+)\.sql$/);
      if (!match) return null;
      return { version: match[1], name: match[2], path: path.join(dir, filename) };
    })
    .filter(Boolean) as Array<{ version: string; name: string; path: string }>;
}

export async function runPgMigrations(client: DbClient): Promise<void> {
  // Ensure tracking table exists
  await client.exec(`
    CREATE TABLE IF NOT EXISTS _omniroute_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
    );
  `);

  const dir = resolvePgMigrationsDir();
  const files = getPgMigrationFiles(dir);
  if (files.length === 0) return;

  // Get already-applied versions
  const applied = new Set(
    (await client.all<{ version: string }>(
      "SELECT version FROM _omniroute_migrations"
    )).map((r) => r.version)
  );

  const pending = files.filter((f) => !applied.has(f.version));
  if (pending.length === 0) return;

  console.log(`[PG Migration] ${pending.length} pending migration(s) to apply...`);

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.path, "utf-8");
    await client.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.run(
        "INSERT INTO _omniroute_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        new Date().toISOString()
      );
    });
    console.log(`[PG Migration] Applied ${migration.version}_${migration.name}`);
  }
}
