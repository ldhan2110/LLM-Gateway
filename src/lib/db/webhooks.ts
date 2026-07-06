/**
 * Database module: Webhooks
 * CRUD operations for webhook event subscriptions
 */

import { getDbClient } from "./core";
import crypto from "crypto";

export type WebhookKind = "slack" | "telegram" | "discord" | "custom";

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  enabled: boolean;
  description: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: number;
  kind: WebhookKind;
  metadata_encrypted: string | null;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  secret: string | null;
  enabled: number;
  description: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: number;
  kind: string;
  metadata_encrypted: string | null;
}

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    ...row,
    kind: (row.kind as WebhookKind) || "custom",
    events: JSON.parse(row.events || '["*"]'),
    enabled: row.enabled === 1,
  };
}

export async function getWebhooks(): Promise<Webhook[]> {
  const db = getDbClient();
  const rows = await db.all<WebhookRow>("SELECT * FROM webhooks ORDER BY created_at DESC");
  return rows.map(rowToWebhook);
}

export async function getWebhook(id: string): Promise<Webhook | null> {
  const db = getDbClient();
  const row = await db.get<WebhookRow>("SELECT * FROM webhooks WHERE id = ?", id);
  return row ? rowToWebhook(row) : null;
}

export async function getEnabledWebhooks(): Promise<Webhook[]> {
  const db = getDbClient();
  const rows = await db.all<WebhookRow>("SELECT * FROM webhooks WHERE enabled = 1");
  return rows.map(rowToWebhook);
}

export async function createWebhook(data: {
  url: string;
  events?: string[];
  secret?: string;
  description?: string;
  kind?: WebhookKind;
  metadataEncrypted?: string | null;
}): Promise<Webhook> {
  const db = getDbClient();
  const id = crypto.randomUUID();
  const secret = data.secret || `whsec_${crypto.randomBytes(24).toString("hex")}`;
  const kind = data.kind || "custom";

  await db.run(
    `INSERT INTO webhooks (id, url, events, secret, description, kind, metadata_encrypted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    data.url,
    JSON.stringify(data.events || ["*"]),
    secret,
    data.description || "",
    kind,
    data.metadataEncrypted ?? null
  );

  return (await getWebhook(id))!;
}

export async function updateWebhook(
  id: string,
  data: Partial<{
    url: string;
    events: string[];
    secret: string;
    enabled: boolean;
    description: string;
    kind: WebhookKind;
    metadataEncrypted: string | null;
  }>
): Promise<Webhook | null> {
  const db = getDbClient();
  const existing = await getWebhook(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (data.url !== undefined) {
    fields.push("url = ?");
    values.push(data.url);
  }
  if (data.events !== undefined) {
    fields.push("events = ?");
    values.push(JSON.stringify(data.events));
  }
  if (data.secret !== undefined) {
    fields.push("secret = ?");
    values.push(data.secret);
  }
  if (data.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(data.enabled ? 1 : 0);
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
  }
  if (data.kind !== undefined) {
    fields.push("kind = ?");
    values.push(data.kind);
  }
  if (data.metadataEncrypted !== undefined) {
    fields.push("metadata_encrypted = ?");
    values.push(data.metadataEncrypted);
  }

  if (fields.length === 0) return existing;

  values.push(id);
  await db.run(`UPDATE webhooks SET ${fields.join(", ")} WHERE id = ?`, ...values);

  return getWebhook(id);
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const db = getDbClient();
  const result = await db.run("DELETE FROM webhooks WHERE id = ?", id);
  return result.changes > 0;
}

export async function recordWebhookDelivery(id: string, status: number, success: boolean): Promise<void> {
  const db = getDbClient();
  if (success) {
    await db.run(
      `UPDATE webhooks SET last_triggered_at = datetime('now'), last_status = ?, failure_count = 0 WHERE id = ?`,
      status,
      id
    );
  } else {
    await db.run(
      `UPDATE webhooks SET last_triggered_at = datetime('now'), last_status = ?, failure_count = failure_count + 1 WHERE id = ?`,
      status,
      id
    );
  }
}

export async function disableWebhooksWithHighFailures(threshold = 10): Promise<number> {
  const db = getDbClient();
  const result = await db.run(
    `UPDATE webhooks SET enabled = 0 WHERE failure_count >= ? AND enabled = 1`,
    threshold
  );
  return result.changes;
}
