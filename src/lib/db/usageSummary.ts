import { getDbClient } from "./core.ts";

/** Total input+output tokens rolled up in daily_usage_summary for the current calendar month. */
export async function sumUsageTokensThisMonth(): Promise<number> {
  try {
    const db = getDbClient();
    const row = await db.get<{ used: number }>(
      `SELECT COALESCE(SUM(total_input_tokens + total_output_tokens), 0) AS used
         FROM daily_usage_summary
         WHERE date >= strftime('%Y-%m-01','now')`
    );
    return row?.used ?? 0;
  } catch {
    return 0; // table may not exist yet on a fresh install — treat as 0 used
  }
}
