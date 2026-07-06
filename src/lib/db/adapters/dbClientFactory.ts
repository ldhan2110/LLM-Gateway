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
 * Return the singleton async DbClient for the configured backend.
 *
 * For SQLite: wraps the existing sync singleton via globalThis.__omnirouteDb
 * (set by getDbInstance() in core.ts). Both share the same underlying connection.
 *
 * For Postgres: (Phase 4) will create a pg.Pool-backed client.
 */
export function getDbClient(): DbClient {
  const existing = globalThis.__omnirouteDbClient;
  if (existing) return existing;

  const backend = resolveBackend();

  if (backend === "postgres") {
    // ponytail: Phase 4 (task 4.1) adds Postgres implementation
    throw new Error(
      "[DB] DATABASE_BACKEND=postgres is not yet implemented. " +
        "Set DATABASE_BACKEND=sqlite (or leave unset) to use the SQLite backend."
    );
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
  delete globalThis.__omnirouteDbClient;
}
