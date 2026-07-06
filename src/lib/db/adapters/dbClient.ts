/**
 * DbClient — async, backend-agnostic database interface.
 *
 * Both SQLite (async-over-sync shell) and Postgres (pg.Pool) implement this
 * contract so domain modules depend on the interface, never a driver.
 */

import type { RunResult } from "./types";

export { type RunResult } from "./types";

export type DbBackend = "sqlite" | "postgres";

export interface DbClient {
  readonly backend: DbBackend;

  /**
   * Execute a parameterized query and return all matching rows.
   * Equivalent to prepare(sql).all(...params) on the sync adapter.
   */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;

  /**
   * Execute a parameterized query and return the first matching row, or undefined.
   * Equivalent to prepare(sql).get(...params) on the sync adapter.
   */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;

  /**
   * Execute a parameterized write statement (INSERT/UPDATE/DELETE).
   * Returns { changes, lastInsertRowid }.
   */
  run(sql: string, ...params: unknown[]): Promise<RunResult>;

  /**
   * Execute raw SQL (no params). Used for DDL, multi-statement scripts, etc.
   */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a DEFERRED transaction. If `fn` throws, the transaction
   * is rolled back and the error re-thrown.
   */
  transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;

  /**
   * Run `fn` inside an IMMEDIATE transaction (acquires write lock up front).
   * On Postgres this maps to a regular transaction (PG always serializes writes).
   */
  immediate<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;

  /**
   * Backend-specific pragma. Returns the pragma value on SQLite, undefined on PG.
   */
  pragma(pragmaStr: string, options?: { simple?: boolean }): Promise<unknown>;

  /**
   * Gracefully close the connection / pool.
   */
  close(): Promise<void>;
}
