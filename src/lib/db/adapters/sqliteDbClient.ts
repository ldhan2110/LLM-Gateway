/**
 * SQLite DbClient — async-over-sync shell wrapping the existing SqliteAdapter.
 *
 * Every method resolves synchronously (no microtask delay) so the behavioral
 * change vs the sync adapter is zero: same call order, same error semantics,
 * same transaction isolation (DEFERRED / IMMEDIATE).
 */

import type { SqliteAdapter } from "./types";
import type { DbClient, RunResult } from "./dbClient";

export function createSqliteDbClient(adapter: SqliteAdapter): DbClient {
  const client: DbClient = {
    backend: "sqlite" as const,

    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
      return adapter.prepare(sql).all(...params) as T[];
    },

    async get<T = Record<string, unknown>>(
      sql: string,
      ...params: unknown[]
    ): Promise<T | undefined> {
      return adapter.prepare(sql).get(...params) as T | undefined;
    },

    async run(sql: string, ...params: unknown[]): Promise<RunResult> {
      return adapter.prepare(sql).run(...params);
    },

    async exec(sql: string): Promise<void> {
      adapter.exec(sql);
    },

    async transaction<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
      // SQLite transactions are connection-scoped, so we pass the same client.
      // The sync adapter's transaction() expects a sync callback that it wraps
      // in BEGIN/COMMIT/ROLLBACK. We can't use it directly with an async fn
      // because better-sqlite3 transactions are synchronous.
      //
      // Instead we manually manage BEGIN/COMMIT/ROLLBACK:
      adapter.exec("BEGIN DEFERRED");
      try {
        const result = await fn(client);
        adapter.exec("COMMIT");
        return result;
      } catch (err) {
        adapter.exec("ROLLBACK");
        throw err;
      }
    },

    async immediate<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
      adapter.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(client);
        adapter.exec("COMMIT");
        return result;
      } catch (err) {
        adapter.exec("ROLLBACK");
        throw err;
      }
    },

    async pragma(pragmaStr: string, options?: { simple?: boolean }): Promise<unknown> {
      return adapter.pragma(pragmaStr, options);
    },

    async close(): Promise<void> {
      adapter.close();
    },
  };

  return client;
}
