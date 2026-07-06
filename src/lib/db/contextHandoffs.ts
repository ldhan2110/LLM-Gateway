import { getDbClient, rowToCamel } from "./core";

export interface HandoffPayload {
  id?: string;
  sessionId: string;
  comboName: string;
  fromAccount: string;
  summary: string;
  keyDecisions: string[];
  taskProgress: string;
  activeEntities: string[];
  messageCount: number;
  model: string;
  lastModel?: string;
  warningThresholdPct: number;
  generatedAt: string;
  expiresAt: string;
  createdAt?: string;
}

type JsonRecord = Record<string, unknown>;

const CLEANUP_THROTTLE_MS = 30 * 60 * 1000;

let lastCleanupAt = 0;

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : String(item))).filter(Boolean);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => (typeof item === "string" ? item : String(item))).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function toHandoffPayload(row: unknown): HandoffPayload | null {
  const camel = rowToCamel(row) as JsonRecord | null;
  if (!camel) return null;

  return {
    id: typeof camel.id === "string" ? camel.id : undefined,
    sessionId: typeof camel.sessionId === "string" ? camel.sessionId : "",
    comboName: typeof camel.comboName === "string" ? camel.comboName : "",
    fromAccount: typeof camel.fromAccount === "string" ? camel.fromAccount : "",
    summary: typeof camel.summary === "string" ? camel.summary : "",
    keyDecisions: parseJsonArray(camel.keyDecisions),
    taskProgress: typeof camel.taskProgress === "string" ? camel.taskProgress : "",
    activeEntities: parseJsonArray(camel.activeEntities),
    messageCount: Number.isFinite(Number(camel.messageCount)) ? Number(camel.messageCount) : 0,
    model: typeof camel.model === "string" ? camel.model : "",
    lastModel: typeof camel.lastModel === "string" ? camel.lastModel : undefined,
    warningThresholdPct: Number.isFinite(Number(camel.warningThresholdPct))
      ? Number(camel.warningThresholdPct)
      : 0.85,
    generatedAt: typeof camel.generatedAt === "string" ? camel.generatedAt : "",
    expiresAt: typeof camel.expiresAt === "string" ? camel.expiresAt : "",
    createdAt: typeof camel.createdAt === "string" ? camel.createdAt : undefined,
  };
}

export async function upsertHandoff(payload: HandoffPayload): Promise<void> {
  const db = getDbClient();
  const createdAt = new Date().toISOString();

  await db.run(
    `INSERT INTO context_handoffs
      (session_id, combo_name, from_account, summary, key_decisions,
       task_progress, active_entities, message_count, model, last_model,
       warning_threshold_pct, generated_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, combo_name) DO UPDATE SET
       from_account = excluded.from_account,
       summary = excluded.summary,
       key_decisions = excluded.key_decisions,
       task_progress = excluded.task_progress,
       active_entities = excluded.active_entities,
       message_count = excluded.message_count,
       model = excluded.model,
       last_model = excluded.last_model,
       warning_threshold_pct = excluded.warning_threshold_pct,
       generated_at = excluded.generated_at,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`,
    payload.sessionId,
    payload.comboName,
    payload.fromAccount,
    payload.summary,
    JSON.stringify(payload.keyDecisions || []),
    payload.taskProgress,
    JSON.stringify(payload.activeEntities || []),
    payload.messageCount,
    payload.model,
    payload.lastModel || null,
    payload.warningThresholdPct,
    payload.generatedAt,
    payload.expiresAt,
    createdAt
  );
}

export async function getHandoff(
  sessionId: string,
  comboName: string
): Promise<HandoffPayload | null> {
  const db = getDbClient();
  const now = new Date().toISOString();
  const row = await db.get(
    `SELECT *
       FROM context_handoffs
       WHERE session_id = ? AND combo_name = ? AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`,
    sessionId,
    comboName,
    now
  );

  return toHandoffPayload(row);
}

export async function deleteHandoff(sessionId: string, comboName: string): Promise<void> {
  const db = getDbClient();
  await db.run(
    "DELETE FROM context_handoffs WHERE session_id = ? AND combo_name = ?",
    sessionId,
    comboName
  );
}

export async function cleanupExpiredHandoffs(): Promise<number> {
  const nowMs = Date.now();
  if (nowMs - lastCleanupAt < CLEANUP_THROTTLE_MS) {
    return 0;
  }

  const db = getDbClient();
  const now = new Date(nowMs).toISOString();
  const result = await db.run("DELETE FROM context_handoffs WHERE expires_at <= ?", now);
  lastCleanupAt = nowMs;
  return Number(result.changes || 0);
}

export async function hasActiveHandoff(sessionId: string, comboName: string): Promise<boolean> {
  const db = getDbClient();
  const now = new Date().toISOString();
  const row = await db.get(
    `SELECT 1
       FROM context_handoffs
       WHERE session_id = ? AND combo_name = ? AND expires_at > ?
       LIMIT 1`,
    sessionId,
    comboName,
    now
  );

  return !!row;
}

/**
 * Record a model usage entry for a session/combo combination.
 * Used by context-relay to track which models have been active.
 *
 * @param sessionId - The session identifier.
 * @param comboName - The combo name.
 * @param modelStr - The model string (e.g. "claude-sonnet-4-20250514").
 * @param provider - The provider identifier.
 * @param connectionId - Optional connection ID used.
 */
export async function recordSessionModelUsage(
  sessionId: string,
  comboName: string,
  modelStr: string,
  provider: string,
  connectionId?: string
): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT INTO session_model_history
      (session_id, combo_name, model_str, provider, connection_id)
     VALUES (?, ?, ?, ?, ?)`,
    sessionId,
    comboName,
    modelStr,
    provider,
    connectionId || null
  );
}

/**
 * Get the most recently used model for a session/combo combination.
 * Returns null if no usage has been recorded.
 *
 * @param sessionId - The session identifier.
 * @param comboName - The combo name.
 * @returns The model string, or null if no record exists.
 */
export async function getLastSessionModel(
  sessionId: string,
  comboName: string
): Promise<string | null> {
  const db = getDbClient();
  const row = await db.get<{ model_str: string }>(
    `SELECT model_str
       FROM session_model_history
       WHERE session_id = ? AND combo_name = ?
       ORDER BY used_at DESC, id DESC
       LIMIT 1`,
    sessionId,
    comboName
  );

  return row?.model_str ?? null;
}
