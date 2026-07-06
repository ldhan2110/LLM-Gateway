/**
 * PostgreSQL DbClient — pg.Pool-backed implementation of the DbClient interface.
 *
 * Rewrites SQLite `?` placeholders to PG `$1, $2, ...` so existing domain
 * module SQL works unchanged. Transactions use a dedicated checked-out client
 * from the pool to guarantee connection-scoped isolation.
 */

import type { Pool, PoolClient } from "pg";
import type { DbClient, RunResult } from "./dbClient";
import { toPgSql } from "./pgParamRewriter";

const INSERT_RE = /^\s*INSERT\s+INTO\s+/i;
const RETURNING_RE = /\bRETURNING\b/i;

/**
 * Build a DbClient that delegates to the given pg PoolClient (for transactions)
 * or Pool (for top-level queries).
 */
function buildClient(queryable: Pool | PoolClient, pool: Pool): DbClient {
  const client: DbClient = {
    backend: "postgres" as const,

    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
      const result = await queryable.query(toPgSql(sql), params);
      return result.rows as T[];
    },

    async get<T = Record<string, unknown>>(
      sql: string,
      ...params: unknown[]
    ): Promise<T | undefined> {
      const result = await queryable.query(toPgSql(sql), params);
      return (result.rows[0] as T) ?? undefined;
    },

    async run(sql: string, ...params: unknown[]): Promise<RunResult> {
      let pgSql = toPgSql(sql);

      // Auto-append RETURNING id for INSERTs without explicit RETURNING
      const isInsert = INSERT_RE.test(pgSql);
      const hasReturning = RETURNING_RE.test(pgSql);
      if (isInsert && !hasReturning) {
        pgSql = pgSql.replace(/;?\s*$/, " RETURNING id");
      }

      const result = await queryable.query(pgSql, params);
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: isInsert && result.rows[0]?.id != null
          ? result.rows[0].id
          : 0,
      };
    },

    async exec(sql: string): Promise<void> {
      await queryable.query(sql);
    },

    async transaction<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
      const pgClient = await pool.connect();
      try {
        await pgClient.query("BEGIN");
        const txClient = buildClient(pgClient, pool);
        const result = await fn(txClient);
        await pgClient.query("COMMIT");
        return result;
      } catch (err) {
        await pgClient.query("ROLLBACK");
        throw err;
      } finally {
        pgClient.release();
      }
    },

    async immediate<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
      // PG has no DEFERRED/IMMEDIATE distinction — same as transaction()
      return client.transaction(fn);
    },

    async pragma(_pragmaStr: string, _options?: { simple?: boolean }): Promise<unknown> {
      // No-op on PostgreSQL — pragmas are SQLite-specific
      return undefined;
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };

  return client;
}

export function createPostgresDbClient(pool: Pool): DbClient {
  return buildClient(pool, pool);
}
