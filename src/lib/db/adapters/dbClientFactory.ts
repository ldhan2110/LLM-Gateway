/**
 * DbClient factory — singleton entry point for the async database interface.
 *
 * Reads `DATABASE_BACKEND` env once (default: "sqlite") and returns the
 * appropriate DbClient. Domain modules will eventually import this instead
 * of `getDbInstance()` from core.ts.
 *
 * During the transition period both paths coexist:
 *   - getDbInstance() → sync SqliteAdapter (existing, to be retired)
 *   - getDbClient()  → async DbClient     (new, backend-agnostic)
 */

import type { DbClient, DbBackend } from "./dbClient";
import type { SqliteAdapter } from "./types";
import { createSqliteDbClient } from "./sqliteDbClient";

// Survive Next.js dev HMR module re-evaluation (same pattern as core.ts).
declare global {
  // eslint-disable-next-line no-var
  var __omnirouteDbClient: DbClient | undefined;
}

function resolveBackend(): DbBackend {
  const env = process.env.DATABASE_BACKEND?.toLowerCase();
  if (env === "postgres" || env === "postgresql") return "postgres";
  return "sqlite";
}

/**
 * Resolve PostgreSQL pool configuration from environment.
 * Prefers DATABASE_URL; falls back to individual PG* vars (read natively by pg).
 */
function resolvePgConfig(): {
  connectionString?: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
} {
  return {
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_TIMEOUT_MS) || 30_000,
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECT_TIMEOUT_MS) || 5_000,
  };
}

/** Lazily initialized postgres client (async because of dynamic import). */
let pgClientPromise: Promise<DbClient> | null = null;

async function createPgClient(): Promise<DbClient> {
  let Pool: typeof import("pg").Pool;
  try {
    const pg = await import("pg");
    Pool = pg.default?.Pool ?? pg.Pool;
  } catch {
    throw new Error(
      "[DB] DATABASE_BACKEND=postgres requires the 'pg' package. " +
        "Install it: npm install pg"
    );
  }

  const { createPostgresDbClient } = await import("./postgresDbClient");
  const config = resolvePgConfig();
  const pool = new Pool(config);

  // Verify connectivity on first use
  try {
    const testClient = await pool.connect();
    testClient.release();
  } catch (err: unknown) {
    await pool.end();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[DB] Failed to connect to PostgreSQL: ${msg}. ` +
        "Check DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE."
    );
  }

  return createPostgresDbClient(pool);
}

/**
 * Return the singleton async DbClient for the configured backend.
 *
 * For SQLite: wraps the existing sync singleton via globalThis.__omnirouteDb
 * (set by getDbInstance() in core.ts). Both share the same underlying connection.
 *
 * For Postgres: creates a pg.Pool-backed client (async initialization).
 */
export function getDbClient(): DbClient | Promise<DbClient> {
  const existing = globalThis.__omnirouteDbClient;
  if (existing) return existing;

  const backend = resolveBackend();

  if (backend === "postgres") {
    if (!pgClientPromise) {
      pgClientPromise = createPgClient().then((client) => {
        globalThis.__omnirouteDbClient = client;
        return client;
      });
    }
    return pgClientPromise;
  }

  // SQLite: wrap the sync singleton that core.ts already placed on globalThis.
  const adapter = globalThis.__omnirouteDb as SqliteAdapter | undefined;
  if (!adapter) {
    throw new Error(
      "[DB] DbClient not initialized. Call getDbInstance() or ensureDbInitialized() first."
    );
  }

  const client = createSqliteDbClient(adapter);
  globalThis.__omnirouteDbClient = client;
  return client;
}

/**
 * Reset the singleton (used by tests and restore flows).
 * Does NOT close the underlying connection — that is managed by core.ts
 * closeDbInstance() / resetDbInstance() for the SQLite path.
 */
export function resetDbClient(): void {
  pgClientPromise = null;
  delete globalThis.__omnirouteDbClient;
}
