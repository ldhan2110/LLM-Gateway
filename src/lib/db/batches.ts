import { getDbClient, rowToCamel, objToSnake } from "./core";
import { deleteFile } from "./files";
import { v4 as uuidv4 } from "uuid";

function parseBatchRow(row: any): BatchRecord {
  const camel = rowToCamel(row) as any;
  if (camel.metadata && typeof camel.metadata === "string") {
    try {
      camel.metadata = JSON.parse(camel.metadata);
    } catch {
      camel.metadata = null;
    }
  }
  if (camel.errors && typeof camel.errors === "string") {
    try {
      camel.errors = JSON.parse(camel.errors);
    } catch {
      camel.errors = null;
    }
  }
  if (camel.usage && typeof camel.usage === "string") {
    try {
      camel.usage = JSON.parse(camel.usage);
    } catch {
      camel.usage = null;
    }
  }
  // Normalize numeric date fields to ensure they are valid numbers
  const coerceNum = (v: any): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  camel.createdAt = coerceNum(camel.createdAt) ?? 0;
  camel.inProgressAt = coerceNum(camel.inProgressAt);
  camel.expiresAt = coerceNum(camel.expiresAt);
  camel.finalizingAt = coerceNum(camel.finalizingAt);
  camel.completedAt = coerceNum(camel.completedAt);
  camel.failedAt = coerceNum(camel.failedAt);
  camel.expiredAt = coerceNum(camel.expiredAt);
  camel.cancellingAt = coerceNum(camel.cancellingAt);
  camel.cancelledAt = coerceNum(camel.cancelledAt);
  return camel as BatchRecord;
}

export interface BatchRecord {
  id: string;
  endpoint: string;
  completionWindow: string;
  status:
    | "validating"
    | "failed"
    | "in_progress"
    | "finalizing"
    | "completed"
    | "expired"
    | "cancelling"
    | "cancelled";
  inputFileId: string;
  outputFileId?: string | null;
  errorFileId?: string | null;
  createdAt: number;
  inProgressAt?: number | null;
  expiresAt?: number | null;
  finalizingAt?: number | null;
  completedAt?: number | null;
  failedAt?: number | null;
  expiredAt?: number | null;
  cancellingAt?: number | null;
  cancelledAt?: number | null;
  requestCountsTotal: number;
  requestCountsCompleted: number;
  requestCountsFailed: number;
  metadata?: Record<string, any> | null;
  apiKeyId?: string | null;
  errors?: any | null;
  model?: string | null;
  usage?: any | null;
  outputExpiresAfterSeconds?: number | null;
  outputExpiresAfterAnchor?: string | null;
}

export type BatchItemCheckpointStatus = "pending" | "processing" | "completed" | "errored";

export interface BatchItemCheckpoint {
  batchId: string;
  lineNumber: number;
  customId: string | null;
  status: BatchItemCheckpointStatus;
  result: any | null;
  error: any | null;
  createdAt: number;
  updatedAt: number;
}

function parseJsonColumn(value: unknown): any | null {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseBatchItemCheckpoint(row: any): BatchItemCheckpoint {
  return {
    batchId: row.batch_id,
    lineNumber: Number(row.line_number),
    customId: row.custom_id ?? null,
    status: row.status,
    result: parseJsonColumn(row.result_json),
    error: parseJsonColumn(row.error_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function createBatch(
  batch: Omit<
    BatchRecord,
    | "id"
    | "createdAt"
    | "requestCountsTotal"
    | "requestCountsCompleted"
    | "requestCountsFailed"
    | "status"
  > & { status?: BatchRecord["status"] }
): Promise<BatchRecord> {
  const db = getDbClient();
  const id = "batch_" + uuidv4().replaceAll("-", "").substring(0, 24);
  const createdAt = Math.floor(Date.now() / 1000);
  const record: BatchRecord = {
    ...batch,
    id,
    createdAt,
    status: batch.status || "validating",
    requestCountsTotal: 0,
    requestCountsCompleted: 0,
    requestCountsFailed: 0,
    errors: batch.errors || null,
    model: batch.model || null,
    usage: batch.usage || null,
    outputExpiresAfterSeconds: batch.outputExpiresAfterSeconds || null,
    outputExpiresAfterAnchor: batch.outputExpiresAfterAnchor || null,
  };

  const snakeRecord = objToSnake({
    ...record,
    metadata: record.metadata ? JSON.stringify(record.metadata) : null,
    errors: record.errors ? JSON.stringify(record.errors) : null,
    usage: record.usage ? JSON.stringify(record.usage) : null,
  }) as any;
  const keys = Object.keys(snakeRecord);
  const values = Object.values(snakeRecord);
  const placeholders = keys.map(() => "?").join(", ");

  await db.run(`INSERT INTO batches (${keys.join(", ")}) VALUES (${placeholders})`, ...values);

  return record;
}

export async function getBatch(id: string): Promise<BatchRecord | null> {
  const db = getDbClient();
  const row = await db.get("SELECT * FROM batches WHERE id = ?", id);
  if (!row) return null;
  return parseBatchRow(row);
}

export async function updateBatch(id: string, updates: Partial<BatchRecord>): Promise<boolean> {
  const db = getDbClient();
  const snakeUpdates = objToSnake(updates) as any;
  if (snakeUpdates.metadata && typeof snakeUpdates.metadata !== "string") {
    snakeUpdates.metadata = JSON.stringify(snakeUpdates.metadata);
  }
  if (snakeUpdates.errors && typeof snakeUpdates.errors !== "string") {
    snakeUpdates.errors = JSON.stringify(snakeUpdates.errors);
  }
  if (snakeUpdates.usage && typeof snakeUpdates.usage !== "string") {
    snakeUpdates.usage = JSON.stringify(snakeUpdates.usage);
  }

  const keys = Object.keys(snakeUpdates);
  if (keys.length === 0) return false;

  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = Object.values(snakeUpdates);

  const result = await db.run(`UPDATE batches SET ${setClause} WHERE id = ?`, ...values, id);
  return result.changes > 0;
}

export async function ensureBatchItemCheckpoints(
  batchId: string,
  items: Array<{ lineNumber: number; customId: string | null }>
): Promise<void> {
  if (items.length === 0) return;

  const db = getDbClient();
  const now = Math.floor(Date.now() / 1000);
  await db.transaction(async (c) => {
    for (const item of items) {
      await c.run(
        `INSERT OR IGNORE INTO batch_item_checkpoints (
          batch_id,
          line_number,
          custom_id,
          status,
          result_json,
          error_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        batchId,
        item.lineNumber,
        item.customId,
        now,
        now
      );
    }
  });
}

export async function countBatchItemCheckpoints(batchId: string): Promise<number> {
  const db = getDbClient();
  const row = await db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM batch_item_checkpoints WHERE batch_id = ?",
    batchId
  );
  return row ? Number(row.c) : 0;
}

export async function listBatchItemCheckpoints(batchId: string): Promise<BatchItemCheckpoint[]> {
  const db = getDbClient();
  const rows = await db.all(
    `
      SELECT batch_id, line_number, custom_id, status, result_json, error_json, created_at, updated_at
      FROM batch_item_checkpoints
      WHERE batch_id = ?
      ORDER BY line_number ASC
    `,
    batchId
  );
  return rows.map((row) => parseBatchItemCheckpoint(row));
}

export async function markBatchItemProcessing(
  batchId: string,
  item: { lineNumber: number; customId: string | null }
): Promise<void> {
  const db = getDbClient();
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    `
    INSERT INTO batch_item_checkpoints (
      batch_id,
      line_number,
      custom_id,
      status,
      result_json,
      error_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 'processing', NULL, NULL, ?, ?)
    ON CONFLICT(batch_id, line_number) DO UPDATE SET
      custom_id = excluded.custom_id,
      status = 'processing',
      result_json = NULL,
      error_json = NULL,
      updated_at = excluded.updated_at
  `,
    batchId,
    item.lineNumber,
    item.customId,
    now,
    now
  );
}

export async function markBatchItemResult(
  batchId: string,
  item: { lineNumber: number; customId: string | null },
  result: any
): Promise<void> {
  const db = getDbClient();
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    `
    UPDATE batch_item_checkpoints
    SET custom_id = ?,
        status = 'completed',
        result_json = ?,
        error_json = NULL,
        updated_at = ?
    WHERE batch_id = ? AND line_number = ?
  `,
    item.customId,
    JSON.stringify(result),
    now,
    batchId,
    item.lineNumber
  );
}

export async function markBatchItemError(
  batchId: string,
  item: { lineNumber: number; customId: string | null },
  error: any
): Promise<void> {
  const db = getDbClient();
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    `
    UPDATE batch_item_checkpoints
    SET custom_id = ?,
        status = 'errored',
        result_json = NULL,
        error_json = ?,
        updated_at = ?
    WHERE batch_id = ? AND line_number = ?
  `,
    item.customId,
    JSON.stringify(error),
    now,
    batchId,
    item.lineNumber
  );
}

export async function listBatches(
  apiKeyId?: string,
  limit: number = 20,
  after?: string
): Promise<BatchRecord[]> {
  const db = getDbClient();
  const afterBatch = after ? await getBatch(after) : null;
  let rows: any[];
  if (apiKeyId) {
    if (afterBatch) {
      rows = await db.all(
        "SELECT * FROM batches WHERE api_key_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
        apiKeyId,
        afterBatch.createdAt,
        afterBatch.createdAt,
        after,
        limit
      );
    } else {
      rows = await db.all(
        "SELECT * FROM batches WHERE api_key_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        apiKeyId,
        limit
      );
    }
  } else if (afterBatch) {
    rows = await db.all(
      "SELECT * FROM batches WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
      afterBatch.createdAt,
      afterBatch.createdAt,
      after,
      limit
    );
  } else {
    rows = await db.all(
      "SELECT * FROM batches ORDER BY created_at DESC, id DESC LIMIT ?",
      limit
    );
  }
  return rows.map((row) => parseBatchRow(row));
}

export async function countBatches(apiKeyId?: string): Promise<number> {
  const db = getDbClient();
  if (apiKeyId) {
    const row = await db.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM batches WHERE api_key_id = ?",
      apiKeyId
    );
    return row ? Number(row.c) : 0;
  } else {
    const row = await db.get<{ c: number }>("SELECT COUNT(*) as c FROM batches");
    return row ? Number(row.c) : 0;
  }
}

export async function getPendingBatches(): Promise<BatchRecord[]> {
  const db = getDbClient();
  const rows = await db.all(
    "SELECT * FROM batches WHERE status IN ('validating', 'in_progress', 'finalizing', 'cancelling')"
  );
  return rows.map((row) => parseBatchRow(row));
}

export async function getTerminalBatches(): Promise<BatchRecord[]> {
  const db = getDbClient();
  const rows = await db.all(
    "SELECT * FROM batches WHERE status IN ('completed', 'failed', 'cancelled', 'expired') ORDER BY created_at ASC"
  );
  return rows.map((row) => parseBatchRow(row));
}

export async function deleteBatch(id: string): Promise<boolean> {
  const db = getDbClient();
  const batch = await getBatch(id);
  if (!batch) return false;

  await db.run("DELETE FROM batch_item_checkpoints WHERE batch_id = ?", id);

  // Soft-delete associated files (input, output, error)
  if (batch.inputFileId) {
    try {
      await deleteFile(batch.inputFileId);
    } catch {
      /* ignore */
    }
  }
  if (batch.outputFileId) {
    try {
      await deleteFile(batch.outputFileId);
    } catch {
      /* ignore */
    }
  }
  if (batch.errorFileId) {
    try {
      await deleteFile(batch.errorFileId);
    } catch {
      /* ignore */
    }
  }

  const result = await db.run("DELETE FROM batches WHERE id = ?", id);
  return result.changes > 0;
}

export async function deleteCompletedBatches(): Promise<{
  deletedBatches: number;
  deletedFiles: number;
}> {
  const db = getDbClient();

  // Collect unique file IDs from all completed batches
  const rows = await db.all<{
    input_file_id: string | null;
    output_file_id: string | null;
    error_file_id: string | null;
  }>(
    "SELECT input_file_id, output_file_id, error_file_id FROM batches WHERE status = 'completed'"
  );
  const fileIds = new Set<string>();
  for (const row of rows) {
    if (row.input_file_id) fileIds.add(row.input_file_id);
    if (row.output_file_id) fileIds.add(row.output_file_id);
    if (row.error_file_id) fileIds.add(row.error_file_id);
  }

  let deletedFiles = 0;
  for (const fid of fileIds) {
    try {
      if (await deleteFile(fid)) deletedFiles++;
    } catch {
      /* ignore */
    }
  }

  await db.run(
    "DELETE FROM batch_item_checkpoints WHERE batch_id IN (SELECT id FROM batches WHERE status = 'completed')"
  );

  const result = await db.run("DELETE FROM batches WHERE status = 'completed'");
  return { deletedBatches: result.changes, deletedFiles };
}
