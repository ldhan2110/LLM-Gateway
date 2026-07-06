/**
 * db/quotaModelCaps.ts — CRUD for quota_allocation_model_caps table.
 *
 * Per-(pool_id, api_key_id, model) budget caps for the Quota Share Engine.
 * Closes the "one key drains the pool on a single model" attack (Fase 3 #7).
 *
 * cap_unit aligns with QuotaUnit: "requests" | "tokens" | "usd" | "percent".
 * cap_value of ≤ Number.EPSILON is treated as a placeholder by the enforce
 * layer (not enforced), consistent with the planRegistry EPSILON convention.
 *
 * All SQL goes through prepared statements — never raw string interpolation
 * (Hard Rule #5).
 */

import { getDbClient } from "./core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QuotaUnit = "percent" | "requests" | "tokens" | "usd";

export interface ModelCap {
  poolId: string;
  apiKeyId: string;
  model: string;
  capValue: number;
  capUnit: QuotaUnit;
}

interface ModelCapRow {
  pool_id: string;
  api_key_id: string;
  model: string;
  cap_value: number;
  cap_unit: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToModelCap(row: ModelCapRow): ModelCap {
  return {
    poolId: row.pool_id,
    apiKeyId: row.api_key_id,
    model: row.model,
    capValue: row.cap_value,
    capUnit: row.cap_unit as QuotaUnit,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the cap for a specific (pool, key, model) triple.
 * Returns null if no cap is configured.
 */
export async function getModelCap(
  poolId: string,
  apiKeyId: string,
  model: string
): Promise<ModelCap | null> {
  const db = getDbClient();
  const row = await db.get<ModelCapRow>(
    `SELECT pool_id, api_key_id, model, cap_value, cap_unit
     FROM quota_allocation_model_caps
     WHERE pool_id = ? AND api_key_id = ? AND model = ?`,
    poolId,
    apiKeyId,
    model
  );
  return row ? rowToModelCap(row) : null;
}

/**
 * List all model caps for a given (pool, key) pair.
 */
export async function listModelCaps(poolId: string, apiKeyId: string): Promise<ModelCap[]> {
  const db = getDbClient();
  const rows = await db.all<ModelCapRow>(
    `SELECT pool_id, api_key_id, model, cap_value, cap_unit
     FROM quota_allocation_model_caps
     WHERE pool_id = ? AND api_key_id = ?`,
    poolId,
    apiKeyId
  );
  return rows.map(rowToModelCap);
}

/**
 * Insert or replace a model cap.
 * cap_value must be > 0 (enforced by DB CHECK constraint).
 */
export async function setModelCap(cap: ModelCap): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT INTO quota_allocation_model_caps
       (pool_id, api_key_id, model, cap_value, cap_unit)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pool_id, api_key_id, model) DO UPDATE SET
       cap_value = excluded.cap_value,
       cap_unit  = excluded.cap_unit`,
    cap.poolId,
    cap.apiKeyId,
    cap.model,
    cap.capValue,
    cap.capUnit
  );
}

/**
 * Remove the cap for a specific (pool, key, model) triple.
 * No-op if it does not exist.
 */
export async function deleteModelCap(
  poolId: string,
  apiKeyId: string,
  model: string
): Promise<void> {
  const db = getDbClient();
  await db.run(
    `DELETE FROM quota_allocation_model_caps
     WHERE pool_id = ? AND api_key_id = ? AND model = ?`,
    poolId,
    apiKeyId,
    model
  );
}
