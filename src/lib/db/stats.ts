/**
 * Database Statistics Module
 *
 * Provides functions to retrieve database statistics including size, table counts, and performance metrics.
 */

import { getDbClient } from "./core";

export interface DatabaseStats {
  totalSize: number;
  pageSize: number;
  pageCount: number;
  tables: Array<{
    name: string;
    rowCount: number;
    size: number;
  }>;
  indexes: Array<{
    name: string;
    tableName: string;
  }>;
  walSize?: number;
  cacheSize: number;
}

export async function getDatabaseStats(): Promise<DatabaseStats> {
  const db = getDbClient();

  const pageSize = (await db.pragma("page_size", { simple: true })) as number;
  const pageCount = (await db.pragma("page_count", { simple: true })) as number;
  const cacheSize = (await db.pragma("cache_size", { simple: true })) as number;
  const totalSize = pageSize * pageCount;

  const tables = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );

  const tableStats = await Promise.all(
    tables.map(async (table) => {
      const rowCount = await db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${table.name}`
      );

      const tableSize = await db.get<{ size: number | null }>(
        `SELECT SUM(pgsize) as size FROM dbstat WHERE name = ?`,
        table.name
      );

      return {
        name: table.name,
        rowCount: rowCount?.count ?? 0,
        size: tableSize?.size || 0,
      };
    })
  );

  const indexes = await db.all<{ name: string; tableName: string }>(
    `SELECT name, tbl_name as tableName FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );

  return {
    totalSize,
    pageSize,
    pageCount,
    tables: tableStats,
    indexes,
    cacheSize,
  };
}
