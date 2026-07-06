/**
 * Relay Proxy DB module
 *
 * Manages relay tokens, rate limits, and usage tracking for serverless relay proxies.
 */

import { randomBytes } from "node:crypto";
import { getDbClient } from "./core";
import { rowToCamel } from "./core";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RelayToken {
  id: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  description: string;
  comboId: string | null;
  allowedModels: string;
  maxTokensPerRequest: number;
  maxRequestsPerMinute: number;
  maxRequestsPerDay: number;
  maxCostPerDay: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  metadata: string;
}

export interface RelayTokenRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  description: string;
  combo_id: string | null;
  allowed_models: string;
  max_tokens_per_request: number;
  max_requests_per_minute: number;
  max_requests_per_day: number;
  max_cost_per_day: number;
  enabled: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  metadata: string;
}

export interface CreateRelayTokenInput {
  name: string;
  description?: string;
  comboId?: string;
  allowedModels?: string[];
  maxTokensPerRequest?: number;
  maxRequestsPerMinute?: number;
  maxRequestsPerDay?: number;
  maxCostPerDay?: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface RelayTokenWithSecret extends RelayToken {
  rawToken: string; // Only returned once on creation
}

export interface RelayLogRow {
  id: number;
  token_id: string;
  request_id: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  status: string;
  status_code: number;
  latency_ms: number;
  client_ip: string | null;
  user_agent: string | null;
  created_at: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return "rl_" + randomBytes(16).toString("hex");
}

function generateToken(): string {
  return "relay_" + randomBytes(24).toString("hex");
}

function hashToken(token: string): string {
  // Simple hash for token comparison (not bcrypt-heavy for performance)
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(token).digest("hex");
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function createRelayToken(input: CreateRelayTokenInput): Promise<RelayTokenWithSecret> {
  const db = getDbClient();
  const id = generateId();
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const now = Math.floor(Date.now() / 1000);

  const prefix = "rl_" + rawToken.slice(6, 14);

  await db.run(
    `INSERT INTO relay_tokens (id, name, token_hash, token_prefix, description, combo_id, allowed_models,
      max_tokens_per_request, max_requests_per_minute, max_requests_per_day, max_cost_per_day,
      enabled, created_at, updated_at, expires_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    id,
    input.name,
    tokenHash,
    prefix,
    input.description || "",
    input.comboId || null,
    JSON.stringify(input.allowedModels || ["*"]),
    input.maxTokensPerRequest || 128000,
    input.maxRequestsPerMinute || 60,
    input.maxRequestsPerDay || 10000,
    input.maxCostPerDay || 0,
    now,
    now,
    input.expiresAt || null,
    JSON.stringify(input.metadata || {})
  );

  const token = await db.get<RelayTokenRow>("SELECT * FROM relay_tokens WHERE id = ?", id);
  return { ...(rowToCamel(token!) as unknown as RelayToken), rawToken };
}

export async function getRelayTokens(): Promise<RelayToken[]> {
  const db = getDbClient();
  const rows = await db.all<RelayTokenRow>(
    "SELECT * FROM relay_tokens ORDER BY created_at DESC"
  );
  return rows.map((r) => ({
    ...(rowToCamel(r) as unknown as RelayToken),
    enabled: r.enabled === 1,
  }));
}

export async function getRelayToken(id: string): Promise<RelayToken | null> {
  const db = getDbClient();
  const row = await db.get<RelayTokenRow>("SELECT * FROM relay_tokens WHERE id = ?", id);
  if (!row) return null;
  return { ...(rowToCamel(row) as unknown as RelayToken), enabled: row.enabled === 1 };
}

export async function getRelayTokenByHash(
  tokenHash: string
): Promise<(RelayToken & { rawToken?: string }) | null> {
  const db = getDbClient();
  const row = await db.get<RelayTokenRow>(
    "SELECT * FROM relay_tokens WHERE token_hash = ? AND enabled = 1",
    tokenHash
  );
  if (!row) return null;
  return { ...(rowToCamel(row) as unknown as RelayToken), enabled: row.enabled === 1 };
}

export async function updateRelayToken(
  id: string,
  updates: Partial<CreateRelayTokenInput>
): Promise<RelayToken | null> {
  const db = getDbClient();
  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];

  if (updates.name !== undefined) {
    sets.push("name = ?");
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    params.push(updates.description);
  }
  if (updates.comboId !== undefined) {
    sets.push("combo_id = ?");
    params.push(updates.comboId);
  }
  if (updates.allowedModels !== undefined) {
    sets.push("allowed_models = ?");
    params.push(JSON.stringify(updates.allowedModels));
  }
  if (updates.maxTokensPerRequest !== undefined) {
    sets.push("max_tokens_per_request = ?");
    params.push(updates.maxTokensPerRequest);
  }
  if (updates.maxRequestsPerMinute !== undefined) {
    sets.push("max_requests_per_minute = ?");
    params.push(updates.maxRequestsPerMinute);
  }
  if (updates.maxRequestsPerDay !== undefined) {
    sets.push("max_requests_per_day = ?");
    params.push(updates.maxRequestsPerDay);
  }
  if (updates.maxCostPerDay !== undefined) {
    sets.push("max_cost_per_day = ?");
    params.push(updates.maxCostPerDay);
  }

  params.push(id);
  await db.run(`UPDATE relay_tokens SET ${sets.join(", ")} WHERE id = ?`, ...params);
  return getRelayToken(id);
}

export async function deleteRelayToken(id: string): Promise<void> {
  const db = getDbClient();
  await db.run("DELETE FROM relay_tokens WHERE id = ?", id);
}

export async function toggleRelayToken(id: string, enabled: boolean): Promise<RelayToken | null> {
  const db = getDbClient();
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    "UPDATE relay_tokens SET enabled = ?, updated_at = ? WHERE id = ?",
    enabled ? 1 : 0,
    now,
    id
  );
  return getRelayToken(id);
}

// ── Usage / Rate Limit ───────────────────────────────────────────────────────

export async function checkRateLimit(tokenId: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetIn: number;
}> {
  const db = getDbClient();
  const token = await db.get<RelayTokenRow>(
    "SELECT * FROM relay_tokens WHERE id = ?",
    tokenId
  );
  if (!token) return { allowed: false, remaining: 0, resetIn: 0 };

  const now = Math.floor(Date.now() / 1000);
  const minuteWindow = Math.floor(now / 60) * 60;
  const dayWindow = Math.floor(now / 86400) * 86400;

  // Check minute rate
  const minuteRow = await db.get<{ request_count: number; cost: number }>(
    "SELECT request_count, cost FROM relay_rate_limits WHERE token_id = ? AND window_start = ?",
    tokenId,
    minuteWindow
  );

  const minuteCount = minuteRow?.request_count || 0;
  if (minuteCount >= token.max_requests_per_minute) {
    return { allowed: false, remaining: 0, resetIn: 60 - (now % 60) };
  }

  // Check daily rate
  const dayRow = await db.get<{ total: number }>(
    "SELECT SUM(request_count) as total FROM relay_rate_limits WHERE token_id = ? AND window_start >= ?",
    tokenId,
    dayWindow
  );

  const dayCount = dayRow?.total || 0;
  if (dayCount >= token.max_requests_per_day) {
    return { allowed: false, remaining: 0, resetIn: 86400 - (now % 86400) };
  }

  const remaining = Math.min(
    token.max_requests_per_minute - minuteCount,
    token.max_requests_per_day - dayCount
  );

  return { allowed: true, remaining, resetIn: 60 - (now % 60) };
}

export async function recordRelayUsage(
  tokenId: string,
  params: {
    requestId?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    cost?: number;
    status?: string;
    statusCode?: number;
    latencyMs?: number;
    clientIp?: string;
    userAgent?: string;
  }
): Promise<void> {
  const db = getDbClient();
  const now = Math.floor(Date.now() / 1000);
  const minuteWindow = Math.floor(now / 60) * 60;

  // Update rate limit window
  await db.run(
    `INSERT INTO relay_rate_limits (token_id, window_start, request_count, cost)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(token_id, window_start) DO UPDATE SET
      request_count = request_count + 1,
      cost = cost + ?`,
    tokenId,
    minuteWindow,
    params.cost || 0,
    params.cost || 0
  );

  // Update last_used_at
  await db.run("UPDATE relay_tokens SET last_used_at = ? WHERE id = ?", now, tokenId);

  // Insert log
  await db.run(
    `INSERT INTO relay_logs (token_id, request_id, model, prompt_tokens, completion_tokens, cost,
      status, status_code, latency_ms, client_ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    tokenId,
    params.requestId || null,
    params.model || null,
    params.promptTokens || 0,
    params.completionTokens || 0,
    params.cost || 0,
    params.status || "success",
    params.statusCode || 200,
    params.latencyMs || 0,
    params.clientIp || null,
    params.userAgent || null,
    now
  );
}

export async function getRelayUsage(
  tokenId: string,
  since: number
): Promise<{ requestCount: number; totalCost: number }> {
  const db = getDbClient();
  const row = await db.get<{ request_count: number; total_cost: number }>(
    "SELECT COUNT(*) as request_count, COALESCE(SUM(cost), 0) as total_cost FROM relay_logs WHERE token_id = ? AND created_at >= ?",
    tokenId,
    since
  );
  return { requestCount: row?.request_count ?? 0, totalCost: row?.total_cost ?? 0 };
}

export async function getRelayLogs(tokenId?: string, limit = 50): Promise<RelayLogRow[]> {
  const db = getDbClient();
  if (tokenId) {
    return db.all<RelayLogRow>(
      "SELECT * FROM relay_logs WHERE token_id = ? ORDER BY created_at DESC LIMIT ?",
      tokenId,
      limit
    );
  }
  return db.all<RelayLogRow>(
    "SELECT * FROM relay_logs ORDER BY created_at DESC LIMIT ?",
    limit
  );
}
