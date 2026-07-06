/**
 * db/providers/nodes.ts — Provider nodes CRUD.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbClient, rowToCamel } from "../core";
import { selectProviderNodeForConnection } from "../providerNodeSelect";
import { backupDbFile } from "../backup";
import { toRecord, type JsonRecord } from "./columns";

export async function getProviderNodes(filter: JsonRecord = {}) {
  const db = getDbClient();
  let sql = "SELECT * FROM provider_nodes";
  const params: unknown[] = [];

  if (filter.type) {
    sql += " WHERE type = ?";
    params.push(filter.type);
  }

  const rows = await db.all(sql, ...params);
  return rows.map(rowToCamel);
}

export async function getProviderNodeById(id: string) {
  const db = getDbClient();
  const row = await db.get("SELECT * FROM provider_nodes WHERE id = ?", id);
  return row ? rowToCamel(row) : null;
}

// #4421: resolve the provider node for a new connection from either its concrete id
// (what the dashboard sends, "<type>-<uuid>") OR the bare derived type (what callers
// using the /api/providers API directly often pass, e.g. "openai-compatible-responses").
// Falls back to the sole node of that type only when unambiguous; otherwise null (so the
// caller still surfaces the existing 404).
export async function resolveProviderNodeForConnection(idOrType: string) {
  const exact = await getProviderNodeById(idOrType);
  if (exact) return exact;
  const all = (await getProviderNodes()) as JsonRecord[];
  return selectProviderNodeForConnection(idOrType, all);
}

export async function createProviderNode(data: JsonRecord) {
  const db = getDbClient();
  const now = new Date().toISOString();

  const customHeadersJson = data.customHeaders ? JSON.stringify(data.customHeaders) : null;

  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix || null,
    apiType: data.apiType || null,
    baseUrl: data.baseUrl || null,
    chatPath: data.chatPath || null,
    modelsPath: data.modelsPath || null,
    // Optional operator-supplied remote icon URL (#2166) — plain TEXT, no JSON parsing needed.
    iconUrl: data.iconUrl || null,
    customHeadersJson,
    createdAt: now,
    updatedAt: now,
  };

  await db.run(
    `INSERT INTO provider_nodes (id, type, name, prefix, api_type, base_url, chat_path, models_path, icon_url, custom_headers_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    node.id,
    node.type,
    node.name,
    node.prefix,
    node.apiType,
    node.baseUrl,
    node.chatPath,
    node.modelsPath,
    node.iconUrl,
    node.customHeadersJson,
    node.createdAt,
    node.updatedAt
  );

  backupDbFile("pre-write");

  const result: JsonRecord = { ...node };
  if (customHeadersJson) {
    try {
      result.customHeaders = JSON.parse(customHeadersJson);
    } catch {
      result.customHeaders = null;
    }
  } else {
    result.customHeaders = null;
  }
  delete result.customHeadersJson;
  return result;
}

export async function updateProviderNode(id: string, data: JsonRecord) {
  const db = getDbClient();
  const existing = await db.get("SELECT * FROM provider_nodes WHERE id = ?", id);
  if (!existing) return null;

  const merged: JsonRecord = {
    ...toRecord(rowToCamel(existing)),
    ...data,
    updatedAt: new Date().toISOString(),
  };

  if (data.customHeaders !== undefined) {
    merged["customHeadersJson"] = data.customHeaders ? JSON.stringify(data.customHeaders) : null;
  } else {
    // Partial update that omits customHeaders must PRESERVE the stored value.
    // rowToCamel surfaces the column under `customHeaders` (suffix stripped),
    // never `customHeadersJson`, so read the raw stored JSON from `existing`
    // directly instead of relying on the (absent) merged key — otherwise the
    // UPDATE would bind null and silently wipe the saved headers.
    const existingJson = (existing as JsonRecord).custom_headers_json;
    merged["customHeadersJson"] = typeof existingJson === "string" ? existingJson : null;
  }

  await db.run(
    `UPDATE provider_nodes SET type = ?, name = ?, prefix = ?,
    api_type = ?, base_url = ?, chat_path = ?,
    models_path = ?, icon_url = ?,
    custom_headers_json = ?, updated_at = ?
    WHERE id = ?`,
    merged["type"],
    merged["name"],
    merged["prefix"] || null,
    merged["apiType"] || null,
    merged["baseUrl"] || null,
    merged["chatPath"] || null,
    merged["modelsPath"] || null,
    // #2166: iconUrl is nullable — explicit `null` (not omission) clears a previously
    // stored custom icon when the caller submits an empty value.
    merged["iconUrl"] || null,
    merged["customHeadersJson"] || null,
    merged["updatedAt"],
    id
  );

  backupDbFile("pre-write");

  const result: JsonRecord = { ...merged };
  const storedJson = merged["customHeadersJson"] as string | null;
  if (storedJson) {
    try {
      result.customHeaders = JSON.parse(storedJson);
    } catch {
      result.customHeaders = null;
    }
  } else {
    result.customHeaders = null;
  }
  delete result.customHeadersJson;
  return result;
}

export async function deleteProviderNode(id: string) {
  const db = getDbClient();
  const existing = await db.get("SELECT * FROM provider_nodes WHERE id = ?", id);
  if (!existing) return null;

  await db.run("DELETE FROM provider_nodes WHERE id = ?", id);
  backupDbFile("pre-write");
  return rowToCamel(existing);
}
