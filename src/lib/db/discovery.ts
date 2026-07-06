/**
 * Discovery results CRUD — stores discovered provider access methods.
 *
 * @module db/discovery
 */

import { getDbClient } from "./core";
import { logger } from "../../open-sse/utils/logger";

const log = logger("DB_DISCOVERY");

export interface DiscoveryResult {
  id?: number;
  providerId: string;
  method: "free_tier" | "web_cookie" | "auto_register" | "trial" | "public_api";
  authType: "none" | "cookie" | "api_key" | "oauth";
  endpoint?: string;
  modelsJson?: string;
  rateLimit?: string;
  feasibility?: number;
  riskLevel?: "none" | "low" | "medium" | "high" | "critical";
  status?: "pending" | "testing" | "verified" | "rejected";
  notes?: string;
  discoveredAt?: string;
  verifiedAt?: string;
}

export async function insertDiscoveryResult(result: DiscoveryResult): Promise<number> {
  const db = getDbClient();
  const now = new Date().toISOString();
  const info = await db.run(
    `INSERT INTO discovery_results (provider_id, method, auth_type, endpoint, models_json, rate_limit, feasibility, risk_level, status, notes, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    result.providerId,
    result.method,
    result.authType,
    result.endpoint ?? null,
    result.modelsJson ?? "[]",
    result.rateLimit ?? null,
    result.feasibility ?? 0,
    result.riskLevel ?? "none",
    result.status ?? "pending",
    result.notes ?? null,
    now
  );
  log.info("discovery_result.inserted", { id: info.lastInsertRowid, providerId: result.providerId });
  return info.lastInsertRowid as number;
}

export async function listDiscoveryResults(status?: string): Promise<DiscoveryResult[]> {
  const db = getDbClient();
  const rows = status
    ? await db.all("SELECT * FROM discovery_results WHERE status = ? ORDER BY discovered_at DESC", status)
    : await db.all("SELECT * FROM discovery_results ORDER BY discovered_at DESC");
  return (rows as Record<string, unknown>[]).map(rowToResult);
}

export async function getDiscoveryResultById(id: number): Promise<DiscoveryResult | null> {
  const db = getDbClient();
  const row = await db.get("SELECT * FROM discovery_results WHERE id = ?", id) as Record<string, unknown> | undefined;
  return row ? rowToResult(row) : null;
}

export async function updateDiscoveryStatus(id: number, status: string, notes?: string): Promise<boolean> {
  const db = getDbClient();
  const now = new Date().toISOString();
  const result = await db.run(
    "UPDATE discovery_results SET status = ?, notes = COALESCE(?, notes), verified_at = CASE WHEN ? = 'verified' THEN ? ELSE verified_at END, updated_at = ? WHERE id = ?",
    status,
    notes ?? null,
    status,
    now,
    now,
    id
  );
  return result.changes > 0;
}

export async function deleteDiscoveryResult(id: number): Promise<boolean> {
  const db = getDbClient();
  const result = await db.run("DELETE FROM discovery_results WHERE id = ?", id);
  return result.changes > 0;
}

function rowToResult(row: Record<string, unknown>): DiscoveryResult {
  return {
    id: row.id as number,
    providerId: row.provider_id as string,
    method: row.method as DiscoveryResult["method"],
    authType: row.auth_type as DiscoveryResult["authType"],
    endpoint: row.endpoint as string | undefined,
    modelsJson: row.models_json as string | undefined,
    rateLimit: row.rate_limit as string | undefined,
    feasibility: row.feasibility as number,
    riskLevel: row.risk_level as DiscoveryResult["riskLevel"],
    status: row.status as DiscoveryResult["status"],
    notes: row.notes as string | undefined,
    discoveredAt: row.discovered_at as string,
    verifiedAt: row.verified_at as string | undefined,
  };
}
