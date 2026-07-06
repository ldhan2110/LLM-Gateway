/**
 * db/models.ts — Custom models, synced available models, and model-flag queries.
 * Compat overrides, model aliases, and MITM aliases have moved to sub-modules under
 * models/; this file re-exports their public APIs for backward compatibility.
 */

import { getDbClient } from "./core";
import { backupDbFile } from "./backup";
import { type JsonRecord, asRecord, toNonEmptyString, getKeyValue } from "./models/shared";
import {
  readCompatList,
  writeCompatList,
  deepMergeCompatByProtocol,
  compatByProtocolHasEntries,
  isCompatProtocolKey,
  sanitizeUpstreamHeadersMap,
  removeModelCompatOverride,
  type CompatByProtocolMap,
  type ModelCompatProtocolKey,
  type ModelCompatOverride,
  type ModelCompatPerProtocol,
} from "./models/compat";

export {
  sanitizeUpstreamHeadersMap,
  getModelCompatOverrides,
  mergeModelCompatOverride,
  removeModelCompatOverride,
  MODEL_COMPAT_PROTOCOL_KEYS,
  type ModelCompatProtocolKey,
  type ModelCompatPerProtocol,
  type ModelCompatOverride,
  type ModelCompatPatch,
} from "./models/compat";
export {
  getModelAliases,
  setModelAlias,
  deleteModelAlias,
  deleteModelAliasesForProvider,
} from "./models/aliases";
export { getMitmAlias, setMitmAliasAll } from "./models/mitmAlias";

// ──────────────── Custom Models ────────────────

export async function getCustomModels(providerId?: string) {
  const db = getDbClient();
  if (providerId) {
    const row = await db.get(
      "SELECT value FROM key_value WHERE namespace = 'customModels' AND key = ?",
      providerId
    );
    const value = getKeyValue(row).value;
    return value ? JSON.parse(value) : [];
  }
  const rows = await db.all(
    "SELECT key, value FROM key_value WHERE namespace = 'customModels'"
  );
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const { key, value } = getKeyValue(row);
    if (!key || value === null) continue;
    result[key] = JSON.parse(value);
  }
  return result;
}

export async function getAllCustomModels() {
  const db = getDbClient();
  const rows = await db.all(
    "SELECT key, value FROM key_value WHERE namespace = 'customModels'"
  );
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    const { key, value } = getKeyValue(row);
    if (!key || value === null) continue;
    result[key] = JSON.parse(value);
  }
  return result;
}

export async function addCustomModel(
  providerId: string,
  modelId: string,
  modelName?: string,
  source = "manual",
  apiFormat:
    | "chat-completions"
    | "responses"
    | "embeddings"
    | "rerank"
    | "audio-transcriptions"
    | "audio-speech"
    | "images-generations" = "chat-completions",
  supportedEndpoints: string[] = ["chat"],
  // #2905: optional per-model wire format override (e.g. "claude" for an
  // opencode-go custom model). When unset, routing falls back to the provider
  // default format.
  targetFormat?: string,
  // #1294: optional per-model token limits supplied from the "add custom model"
  // form. Persisted under the same keys the /v1/models catalog reads back.
  tokenLimits: { inputTokenLimit?: number; outputTokenLimit?: number } = {}
) {
  const db = getDbClient();
  const row = await db.get(
    "SELECT value FROM key_value WHERE namespace = 'customModels' AND key = ?",
    providerId
  );
  const value = getKeyValue(row).value;
  const models = value ? JSON.parse(value) : [];

  const exists = models.find((m: JsonRecord) => m.id === modelId);
  if (exists) return exists;

  const model = {
    id: modelId,
    name: modelName || modelId,
    source,
    apiFormat,
    supportedEndpoints,
    ...(targetFormat ? { targetFormat } : {}),
    ...(tokenLimits.inputTokenLimit != null
      ? { inputTokenLimit: tokenLimits.inputTokenLimit }
      : {}),
    ...(tokenLimits.outputTokenLimit != null
      ? { outputTokenLimit: tokenLimits.outputTokenLimit }
      : {}),
  };
  models.push(model);
  await db.run(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('customModels', ?, ?)",
    providerId,
    JSON.stringify(models)
  );
  backupDbFile("pre-write");
  return model;
}

/**
 * Replace the entire custom models list for a provider.
 * Preserves per-model compatibility overrides for models that still exist.
 */
export async function replaceCustomModels(
  providerId: string,
  models: Array<{
    id: string;
    name?: string;
    source?: string;
    apiFormat?: string;
    supportedEndpoints?: string[];
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    description?: string;
    supportsThinking?: boolean;
    targetFormat?: string;
  }>,
  { allowEmpty = false }: { allowEmpty?: boolean } = {}
) {
  // Guard: skip destructive clear when the caller hasn't explicitly opted in.
  // This prevents callers from wiping manually added models when the
  // upstream /models endpoint fails, times out, or returns an empty list.
  if (models.length === 0 && !allowEmpty) {
    const existing = await getCustomModels(providerId);
    return Array.isArray(existing) ? existing : [];
  }

  const db = getDbClient();
  const existing = await getCustomModels(providerId);
  const existingMap = new Map<string, JsonRecord>();
  if (Array.isArray(existing)) {
    for (const m of existing) {
      if (m && typeof m === "object" && m.id) existingMap.set(m.id, m);
    }
  }

  // Merge: keep existing per-model compat flags if model still exists
  const merged = models.map((m) => {
    const prev = existingMap.get(m.id);
    return {
      id: m.id,
      name: m.name || m.id,
      source: m.source || "auto-sync",
      apiFormat: m.apiFormat || (prev as any)?.apiFormat || "chat-completions",
      supportedEndpoints: m.supportedEndpoints || (prev as any)?.supportedEndpoints || ["chat"],
      // #2905: preserve a per-model targetFormat override (new value wins, else prev).
      ...(m.targetFormat
        ? { targetFormat: m.targetFormat }
        : (prev as any)?.targetFormat
          ? { targetFormat: (prev as any).targetFormat }
          : {}),
      // Preserve metadata from provider API (or previous sync)
      ...(m.inputTokenLimit != null
        ? { inputTokenLimit: m.inputTokenLimit }
        : (prev as any)?.inputTokenLimit != null
          ? { inputTokenLimit: (prev as any).inputTokenLimit }
          : {}),
      ...(m.outputTokenLimit != null
        ? { outputTokenLimit: m.outputTokenLimit }
        : (prev as any)?.outputTokenLimit != null
          ? { outputTokenLimit: (prev as any).outputTokenLimit }
          : {}),
      ...(m.description != null
        ? { description: m.description }
        : (prev as any)?.description != null
          ? { description: (prev as any).description }
          : {}),
      ...(m.supportsThinking != null
        ? { supportsThinking: m.supportsThinking }
        : (prev as any)?.supportsThinking != null
          ? { supportsThinking: (prev as any).supportsThinking }
          : {}),
      // Preserve existing compat flags
      ...(prev && (prev as any).normalizeToolCallId !== undefined
        ? { normalizeToolCallId: (prev as any).normalizeToolCallId }
        : {}),
      ...(prev && (prev as any).preserveOpenAIDeveloperRole !== undefined
        ? { preserveOpenAIDeveloperRole: (prev as any).preserveOpenAIDeveloperRole }
        : {}),
      ...(prev && (prev as any).compatByProtocol
        ? { compatByProtocol: (prev as any).compatByProtocol }
        : {}),
      ...(prev && (prev as any).upstreamHeaders
        ? { upstreamHeaders: (prev as any).upstreamHeaders }
        : {}),
    };
  });

  if (merged.length === 0) {
    await db.run(
      "DELETE FROM key_value WHERE namespace = 'customModels' AND key = ?",
      providerId
    );
  } else {
    await db.run(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('customModels', ?, ?)",
      providerId,
      JSON.stringify(merged)
    );
  }

  backupDbFile("pre-write");
  return merged;
}

export async function removeCustomModel(providerId: string, modelId: string) {
  const db = getDbClient();
  const row = await db.get(
    "SELECT value FROM key_value WHERE namespace = 'customModels' AND key = ?",
    providerId
  );
  if (!row) return false;

  const value = getKeyValue(row).value;
  if (!value) return false;
  const models = JSON.parse(value);
  const before = models.length;
  const filtered = models.filter((m: JsonRecord) => m.id !== modelId);

  if (filtered.length === before) return false;

  if (filtered.length === 0) {
    await db.run(
      "DELETE FROM key_value WHERE namespace = 'customModels' AND key = ?",
      providerId
    );
  } else {
    await db.run(
      "UPDATE key_value SET value = ? WHERE namespace = 'customModels' AND key = ?",
      JSON.stringify(filtered),
      providerId
    );
  }

  await removeModelCompatOverride(providerId, modelId);
  backupDbFile("pre-write");
  return true;
}

// ──────────────── Synced Available Models ────────────────
// Storage: namespace = 'syncedAvailableModels', key = '<providerId>:<connectionId>'
// Each connection stores its own model list. Reads union across all connections
// for a provider. Deleting a connection removes only its models.

export interface SyncedAvailableModel {
  id: string;
  name: string;
  source: "imported";
  apiFormat?: string;
  supportedEndpoints?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  description?: string;
  supportsThinking?: boolean;
  // #4264: image-input capability captured at sync time (e.g. OpenRouter
  // `architecture.input_modalities`/`modality`) so the catalog can surface vision.
  supportsVision?: boolean;
}

type SyncedAvailableModelInput = Omit<SyncedAvailableModel, "source"> & {
  source?: string;
};

function normalizeSyncedAvailableModel(model: unknown): SyncedAvailableModel | null {
  const record = asRecord(model);
  const id =
    toNonEmptyString(record.id) || toNonEmptyString(record.name) || toNonEmptyString(record.model);
  if (!id) return null;

  const name =
    toNonEmptyString(record.name) ||
    toNonEmptyString(record.displayName) ||
    toNonEmptyString(record.model) ||
    id;
  const supportedEndpoints = Array.isArray(record.supportedEndpoints)
    ? Array.from(
        new Set(
          record.supportedEndpoints
            .map((endpoint) => toNonEmptyString(endpoint))
            .filter((endpoint): endpoint is string => Boolean(endpoint))
        )
      ).sort()
    : undefined;

  return {
    id,
    name,
    source: "imported",
    ...(toNonEmptyString(record.apiFormat)
      ? { apiFormat: toNonEmptyString(record.apiFormat)! }
      : {}),
    ...(supportedEndpoints && supportedEndpoints.length > 0 ? { supportedEndpoints } : {}),
    ...(typeof record.inputTokenLimit === "number"
      ? { inputTokenLimit: record.inputTokenLimit }
      : {}),
    ...(typeof record.outputTokenLimit === "number"
      ? { outputTokenLimit: record.outputTokenLimit }
      : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(record.supportsThinking === true ? { supportsThinking: true } : {}),
    ...(record.supportsVision === true ? { supportsVision: true } : {}),
  };
}

function normalizeSyncedAvailableModels(models: unknown): SyncedAvailableModel[] {
  if (!Array.isArray(models)) return [];
  const deduped = new Map<string, SyncedAvailableModel>();
  for (const model of models) {
    const normalized = normalizeSyncedAvailableModel(model);
    if (normalized) deduped.set(normalized.id, normalized);
  }
  return Array.from(deduped.values());
}

/**
 * Get synced available models for a specific provider connection.
 */
export async function getSyncedAvailableModelsForConnection(
  providerId: string,
  connectionId: string
): Promise<SyncedAvailableModel[]> {
  const db = getDbClient();
  const key = `${providerId}:${connectionId}`;
  const row = await db.get(
    "SELECT value FROM key_value WHERE namespace = 'syncedAvailableModels' AND key = ?",
    key
  );
  const value = getKeyValue(row).value;
  if (!value) return [];
  try {
    const models = JSON.parse(value);
    return normalizeSyncedAvailableModels(models);
  } catch {
    return [];
  }
}

/**
 * Get all synced available models for a provider, unioned across all connections.
 */
export async function getSyncedAvailableModels(
  providerId: string
): Promise<SyncedAvailableModel[]> {
  const db = getDbClient();
  const rows = await db.all(
    "SELECT key, value FROM key_value WHERE namespace = 'syncedAvailableModels' AND key LIKE ?",
    `${providerId}:%`
  );
  const map = new Map<string, SyncedAvailableModel>();
  for (const row of rows) {
    const { key, value } = getKeyValue(row);
    if (!key || value === null) continue;
    const models = normalizeSyncedAvailableModels(JSON.parse(value));
    for (const m of models) {
      if (m.id) map.set(m.id, m);
    }
  }
  return Array.from(map.values());
}

/**
 * Get synced available models for a provider grouped by connection id.
 */
export async function getSyncedAvailableModelsByConnection(
  providerId: string
): Promise<Record<string, SyncedAvailableModel[]>> {
  const db = getDbClient();
  const prefix = `${providerId}:`;
  const rows = await db.all(
    "SELECT key, value FROM key_value WHERE namespace = 'syncedAvailableModels' AND key LIKE ?",
    `${prefix}%`
  );
  const result: Record<string, SyncedAvailableModel[]> = {};
  for (const row of rows) {
    const { key, value } = getKeyValue(row);
    if (!key || value === null || !key.startsWith(prefix)) continue;
    try {
      const connectionId = key.slice(prefix.length);
      result[connectionId] = normalizeSyncedAvailableModels(JSON.parse(value));
    } catch {
      // Ignore malformed legacy entries.
    }
  }
  return result;
}

/**
 * Get all synced available models across all providers.
 */
export async function getAllSyncedAvailableModels(): Promise<
  Record<string, SyncedAvailableModel[]>
> {
  const db = getDbClient();
  const rows = await db.all(
    "SELECT key, value FROM key_value WHERE namespace = 'syncedAvailableModels'"
  );
  // Group by providerId (before the colon)
  const byProvider = new Map<string, Map<string, SyncedAvailableModel>>();
  for (const row of rows) {
    const { key, value } = getKeyValue(row);
    if (!key || value === null) continue;
    const providerId = key.split(":")[0];
    if (!byProvider.has(providerId)) byProvider.set(providerId, new Map());
    const models = normalizeSyncedAvailableModels(JSON.parse(value));
    const map = byProvider.get(providerId)!;
    for (const m of models) {
      if (m.id) map.set(m.id, m);
    }
  }
  const result: Record<string, SyncedAvailableModel[]> = {};
  for (const [providerId, map] of byProvider) {
    result[providerId] = Array.from(map.values());
  }
  return result;
}

/**
 * Replace the model list for a specific connection.
 * Key format: '<providerId>:<connectionId>'
 */
export async function replaceSyncedAvailableModelsForConnection(
  providerId: string,
  connectionId: string,
  models: SyncedAvailableModelInput[]
): Promise<SyncedAvailableModel[]> {
  const db = getDbClient();
  const key = `${providerId}:${connectionId}`;
  // #3199: drop ids the operator DELETED (trash) so a re-fetch does not re-import
  // a model that was explicitly removed.
  // #3782: key ONLY on the distinct `isDeleted` marker — NOT on `isHidden`.
  // Eye/visibility-hidden models (`isHidden:true`, no `isDeleted`) must stay in
  // the synced store so they remain listed-but-hidden across re-syncs instead of
  // churning back on through the managed-alias path ("Auto Sync Enabling all
  // Models"). See getModelIsDeleted for the legacy-row caveat.
  const allNormalized = normalizeSyncedAvailableModels(models);
  const deletedFlags = await Promise.all(allNormalized.map((m) => getModelIsDeleted(providerId, m.id)));
  const normalizedModels = allNormalized.filter((_, i) => !deletedFlags[i]);
  if (normalizedModels.length === 0) {
    await db.run(
      "DELETE FROM key_value WHERE namespace = 'syncedAvailableModels' AND key = ?",
      key
    );
  } else {
    await db.run(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('syncedAvailableModels', ?, ?)",
      key,
      JSON.stringify(normalizedModels)
    );
  }
  backupDbFile("pre-write");
  // Return the full unioned list for the provider
  return getSyncedAvailableModels(providerId);
}

/**
 * Remove a single synced available model from all connections of a provider.
 * Returns true if the model was found and removed from at least one connection.
 */
export async function removeSyncedAvailableModel(
  providerId: string,
  modelId: string
): Promise<boolean> {
  const db = getDbClient();
  const prefix = `${providerId}:`;
  const rows = await db.all(
    "SELECT key, value FROM key_value WHERE namespace = 'syncedAvailableModels' AND key LIKE ?",
    `${prefix}%`
  );

  let removedAny = false;
  await db.transaction(async (c) => {
    for (const row of rows) {
      const { key, value } = getKeyValue(row);
      if (!key || value === null) continue;

      let parsedModels: unknown;
      try {
        parsedModels = JSON.parse(value);
      } catch (error) {
        console.warn(`[DB] Skipping malformed syncedAvailableModels entry for key ${key}:`, error);
        continue;
      }

      const models = normalizeSyncedAvailableModels(parsedModels);
      const filtered = models.filter((m) => m.id !== modelId);
      if (filtered.length !== models.length) {
        removedAny = true;
        if (filtered.length === 0) {
          await c.run(
            "DELETE FROM key_value WHERE namespace = 'syncedAvailableModels' AND key = ?",
            key
          );
        } else {
          await c.run(
            "UPDATE key_value SET value = ? WHERE namespace = 'syncedAvailableModels' AND key = ?",
            JSON.stringify(filtered),
            key
          );
        }
      }
    }

    if (removedAny) backupDbFile("pre-write");
  });

  return removedAny;
}

/**
 * Delete all synced models for a specific connection.
 * Returns the remaining unioned list for the provider.
 */
export async function deleteSyncedAvailableModelsForConnection(
  providerId: string,
  connectionId: string
): Promise<SyncedAvailableModel[]> {
  const db = getDbClient();
  const key = `${providerId}:${connectionId}`;
  await db.run(
    "DELETE FROM key_value WHERE namespace = 'syncedAvailableModels' AND key = ?",
    key
  );
  backupDbFile("pre-write");
  return getSyncedAvailableModels(providerId);
}

/**
 * Delete all synced models for every connection belonging to a provider.
 * Returns the number of connection-scoped synced model lists removed.
 */
export async function deleteSyncedAvailableModelsForProvider(providerId: string): Promise<number> {
  const db = getDbClient();
  const keyPrefix = `${providerId}:`;
  const result = await db.run(
    "DELETE FROM key_value WHERE namespace = 'syncedAvailableModels' AND substr(key, 1, ?) = ?",
    keyPrefix.length,
    keyPrefix
  );
  backupDbFile("pre-write");
  return Number(result.changes || 0);
}

/**
 * Prune stale synced available models for a provider, keeping only the specified allowed connection IDs.
 * Returns the number of keys deleted.
 */
export async function pruneStaleSyncedAvailableModelsForProvider(
  providerId: string,
  allowedConnectionIds: string[]
): Promise<number> {
  const db = getDbClient();
  if (allowedConnectionIds.length === 0) {
    return deleteSyncedAvailableModelsForProvider(providerId);
  }
  const placeholders = allowedConnectionIds.map(() => "?").join(",");
  const keyPrefix = `${providerId}:`;
  const allowedKeys = allowedConnectionIds.map((id) => `${providerId}:${id}`);
  const result = await db.run(
    `DELETE FROM key_value WHERE namespace = 'syncedAvailableModels' AND key LIKE ? AND key NOT IN (${placeholders})`,
    `${keyPrefix}%`,
    ...allowedKeys
  );
  backupDbFile("pre-write");
  return Number(result.changes || 0);
}

export async function updateCustomModel(
  providerId: string,
  modelId: string,
  updates: Record<string, unknown> = {}
) {
  const db = getDbClient();
  const row = await db.get(
    "SELECT value FROM key_value WHERE namespace = 'customModels' AND key = ?",
    providerId
  );
  if (!row) return null;

  const value = getKeyValue(row).value;
  if (!value) return null;

  const models = JSON.parse(value);
  const index = models.findIndex((m: JsonRecord) => m.id === modelId);
  if (index === -1) return null;

  const current = models[index];
  const currentCompat = (current as JsonRecord).compatByProtocol as CompatByProtocolMap | undefined;
  let mergedCompat: CompatByProtocolMap | undefined = currentCompat;
  if (
    updates.compatByProtocol !== undefined &&
    typeof updates.compatByProtocol === "object" &&
    updates.compatByProtocol !== null &&
    !Array.isArray(updates.compatByProtocol)
  ) {
    mergedCompat = deepMergeCompatByProtocol(
      currentCompat,
      updates.compatByProtocol as Partial<
        Record<ModelCompatProtocolKey, Partial<ModelCompatPerProtocol>>
      >
    );
    if (!compatByProtocolHasEntries(mergedCompat)) mergedCompat = undefined;
  }

  const next: JsonRecord = {
    ...current,
    ...(updates.modelName !== undefined ? { name: updates.modelName || current.name } : {}),
    ...(updates.apiFormat !== undefined ? { apiFormat: updates.apiFormat } : {}),
    ...(updates.targetFormat !== undefined ? { targetFormat: updates.targetFormat } : {}),
    ...(updates.supportedEndpoints !== undefined
      ? { supportedEndpoints: updates.supportedEndpoints }
      : {}),
    ...(updates.normalizeToolCallId !== undefined
      ? { normalizeToolCallId: Boolean(updates.normalizeToolCallId) }
      : {}),
    ...(updates.isHidden !== undefined ? { isHidden: Boolean(updates.isHidden) } : {}),
  };
  if (Object.prototype.hasOwnProperty.call(updates, "preserveOpenAIDeveloperRole")) {
    if (updates.preserveOpenAIDeveloperRole === null) {
      delete next.preserveOpenAIDeveloperRole;
    } else {
      next.preserveOpenAIDeveloperRole = Boolean(updates.preserveOpenAIDeveloperRole);
    }
  }
  if (updates.compatByProtocol !== undefined) {
    if (mergedCompat && compatByProtocolHasEntries(mergedCompat)) {
      next.compatByProtocol = mergedCompat;
    } else {
      delete next.compatByProtocol;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, "upstreamHeaders")) {
    const uh = updates.upstreamHeaders;
    if (uh === null || uh === undefined) {
      delete next.upstreamHeaders;
    } else if (typeof uh === "object" && !Array.isArray(uh)) {
      const s = sanitizeUpstreamHeadersMap(uh as Record<string, unknown>);
      if (Object.keys(s).length === 0) delete next.upstreamHeaders;
      else next.upstreamHeaders = s;
    }
  }

  models[index] = next;

  await db.run(
    "UPDATE key_value SET value = ? WHERE namespace = 'customModels' AND key = ?",
    JSON.stringify(models),
    providerId
  );

  backupDbFile("pre-write");
  return next;
}

/** Single custom model row from key_value customModels, or null */
async function getCustomModelRow(providerId: string, modelId: string): Promise<JsonRecord | null> {
  const db = getDbClient();
  const row = await db.get(
    "SELECT value FROM key_value WHERE namespace = 'customModels' AND key = ?",
    providerId
  );
  const value = getKeyValue(row).value;
  if (!value) return null;
  try {
    const models = JSON.parse(value) as unknown;
    if (!Array.isArray(models)) return null;
    const m = models.find((x: unknown) => {
      if (!x || typeof x !== "object" || Array.isArray(x)) return false;
      return (x as { id?: string }).id === modelId;
    }) as JsonRecord | undefined;
    return m ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the given provider/model has "normalize tool call id" (9-char Mistral-style) enabled.
 * Custom model row wins; otherwise {@link getModelCompatOverrides}.
 * When `sourceFormat` is one of `openai` | `openai-responses` | `claude`, per-protocol
 * `compatByProtocol[sourceFormat].normalizeToolCallId` overrides the legacy top-level flag.
 */
export async function getModelNormalizeToolCallId(
  providerId: string,
  modelId: string,
  sourceFormat?: string | null
): Promise<boolean> {
  const m = await getCustomModelRow(providerId, modelId);
  const protocol = sourceFormat && isCompatProtocolKey(sourceFormat) ? sourceFormat : null;

  if (m) {
    if (protocol) {
      const pc = (m.compatByProtocol as CompatByProtocolMap | undefined)?.[protocol];
      if (pc && Object.prototype.hasOwnProperty.call(pc, "normalizeToolCallId")) {
        return Boolean(pc.normalizeToolCallId);
      }
    }
    return Boolean(m.normalizeToolCallId);
  }
  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  if (protocol && co?.compatByProtocol?.[protocol]) {
    const pc = co.compatByProtocol[protocol]!;
    if (Object.prototype.hasOwnProperty.call(pc, "normalizeToolCallId")) {
      return Boolean(pc.normalizeToolCallId);
    }
  }
  return Boolean(co?.normalizeToolCallId);
}

/**
 * Explicit preserve-openai-developer preference for this provider/model.
 * `undefined` = unset → routing keeps legacy default (preserve developer for OpenAI format).
 * `false` = map developer → system (e.g. MiniMax). `true` = keep developer.
 * Per-protocol overrides live under `compatByProtocol[sourceFormat]` when `sourceFormat` matches.
 */
export async function getModelPreserveOpenAIDeveloperRole(
  providerId: string,
  modelId: string,
  sourceFormat?: string | null
): Promise<boolean | undefined> {
  const m = await getCustomModelRow(providerId, modelId);
  const protocol = sourceFormat && isCompatProtocolKey(sourceFormat) ? sourceFormat : null;

  if (m) {
    if (protocol) {
      const pc = (m.compatByProtocol as CompatByProtocolMap | undefined)?.[protocol];
      if (pc && Object.prototype.hasOwnProperty.call(pc, "preserveOpenAIDeveloperRole")) {
        return Boolean(pc.preserveOpenAIDeveloperRole);
      }
    }
    if (Object.prototype.hasOwnProperty.call(m, "preserveOpenAIDeveloperRole")) {
      return Boolean(m.preserveOpenAIDeveloperRole);
    }
    return undefined;
  }
  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  if (protocol && co?.compatByProtocol?.[protocol]) {
    const pc = co.compatByProtocol[protocol]!;
    if (Object.prototype.hasOwnProperty.call(pc, "preserveOpenAIDeveloperRole")) {
      return Boolean(pc.preserveOpenAIDeveloperRole);
    }
  }
  if (co && Object.prototype.hasOwnProperty.call(co, "preserveOpenAIDeveloperRole")) {
    return Boolean(co.preserveOpenAIDeveloperRole);
  }
  return undefined;
}

/**
 * Check if the model is flagged as hidden from the public catalog.
 */
export async function getModelIsHidden(providerId: string, modelId: string): Promise<boolean> {
  const m = await getCustomModelRow(providerId, modelId);
  if (m && Object.prototype.hasOwnProperty.call(m, "isHidden")) {
    return Boolean(m.isHidden);
  }
  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  return Boolean(co?.isHidden);
}

/**
 * Get a map of provider ID → set of hidden model IDs from all modelCompatOverrides
 * and customModels. Used by auto-combo candidate building to skip user-hidden models.
 * Single bulk DB query — not N+1 per model.
 */
export async function getHiddenModelsByProvider(): Promise<Map<string, Set<string>>> {
  const db = getDbClient();
  const result = new Map<string, Set<string>>();

  // Query all rows from key_value for both namespaces
  const rows = await db.all<{ key: string; value: string | null }>(
    "SELECT key, value FROM key_value WHERE namespace IN ('modelCompatOverrides', 'customModels')"
  );

  for (const row of rows) {
    if (!row.value) continue;
    try {
      const parsed = JSON.parse(row.value);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (entry && typeof entry === "object" && entry.isHidden) {
          const modelId = entry.id;
          if (typeof modelId === "string" && modelId.length > 0) {
            if (!result.has(row.key)) result.set(row.key, new Set());
            result.get(row.key)!.add(modelId);
          }
        }
      }
    } catch {
      // Skip malformed entries
    }
  }

  return result;
}

/**
 * #3782 — Check if a model was DELETED (trash) rather than merely eye-hidden.
 *
 * Only the DELETE route sets `isDeleted`. The sync re-import filter keys on this
 * (not on `isHidden`) so eye-hidden models survive a re-sync while deleted ones
 * stay dropped.
 *
 * Legacy caveat: rows written by the DELETE route BEFORE this change carry only
 * `isHidden:true` (no `isDeleted`). Treating bare legacy `isHidden:true` as
 * deleted here would resurrect the #3782 bug for eye-hidden models; treating it
 * as "kept" would resurrect previously-deleted models. Resurrecting a deleted
 * model is the less-surprising, recoverable outcome (the operator can re-hide or
 * re-delete it), whereas silently dropping an eye-hidden model is the reported
 * regression — so we deliberately key ONLY on the explicit `isDeleted` flag and
 * accept that a handful of pre-existing deleted rows may reappear once after the
 * upgrade. Going forward both paths write the correct distinct markers.
 */
export async function getModelIsDeleted(providerId: string, modelId: string): Promise<boolean> {
  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  return Boolean(co?.isDeleted);
}

/**
 * Persist the hidden flag for a model. Stores the override on the custom-model
 * row when one exists, otherwise on the compat-override list. Setting
 * `hidden = false` is a no-op when the model is already visible.
 */
export async function setModelIsHidden(
  providerId: string,
  modelId: string,
  hidden: boolean
): Promise<void> {
  const customRow = await getCustomModelRow(providerId, modelId);
  if (customRow) {
    if (hidden) {
      await updateCustomModel(providerId, modelId, { isHidden: true });
    } else if (Object.prototype.hasOwnProperty.call(customRow, "isHidden")) {
      await updateCustomModel(providerId, modelId, { isHidden: false });
    }
    return;
  }

  const list = await readCompatList(providerId);
  const idx = list.findIndex((e) => e.id === modelId);
  if (hidden) {
    const prev = idx >= 0 ? list[idx] : { id: modelId };
    const next: ModelCompatOverride = { ...prev, id: modelId, isHidden: true };
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    await writeCompatList(providerId, list);
    return;
  }

  if (idx < 0) return;
  if (Object.keys(list[idx]).length <= 1) {
    // Only `id` left; drop the entry entirely.
    const filtered = list.filter((_, i) => i !== idx);
    await writeCompatList(providerId, filtered);
    return;
  }
  delete list[idx].isHidden;
  await writeCompatList(providerId, list);
}

function readUpstreamFromJsonRecord(
  row: JsonRecord | null | undefined,
  key: "upstreamHeaders"
): Record<string, string> | undefined {
  if (!row) return undefined;
  const raw = row[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const s = sanitizeUpstreamHeadersMap(raw as Record<string, unknown>);
  return Object.keys(s).length > 0 ? s : undefined;
}

/**
 * Extra HTTP headers to send to the upstream provider for this model (after executor auth headers).
 * Order: top-level `upstreamHeaders` on the custom model row (override list merged under custom),
 * then per-protocol `compatByProtocol[sourceFormat].upstreamHeaders` (wins on key conflict).
 * Use for gateways that expect `Authentication`, `X-API-Key`, etc. alongside Bearer.
 *
 * `modelId` should be the **canonical** model id when known. Callers that accept client aliases
 * (e.g. chat proxy) should merge results for both alias and `resolveModelAlias(alias)` so UI
 * config on the resolved id still applies — see `chatCore` merge.
 */
export async function getModelUpstreamExtraHeaders(
  providerId: string,
  modelId: string,
  sourceFormat?: string | null
): Promise<Record<string, string>> {
  const protocol = sourceFormat && isCompatProtocolKey(sourceFormat) ? sourceFormat : null;
  const m = await getCustomModelRow(providerId, modelId);

  const base: Record<string, string> = {};
  if (m) {
    const fromModel = readUpstreamFromJsonRecord(m, "upstreamHeaders");
    if (fromModel) Object.assign(base, fromModel);
    if (protocol) {
      const pc = (m.compatByProtocol as CompatByProtocolMap | undefined)?.[protocol];
      const fromProto = pc?.upstreamHeaders;
      if (fromProto && typeof fromProto === "object") {
        Object.assign(base, sanitizeUpstreamHeadersMap(fromProto as Record<string, unknown>));
      }
    }
    return base;
  }

  const co = (await readCompatList(providerId)).find((e) => e.id === modelId);
  if (co?.upstreamHeaders) {
    Object.assign(base, sanitizeUpstreamHeadersMap(co.upstreamHeaders as Record<string, unknown>));
  }
  if (protocol && co?.compatByProtocol?.[protocol]?.upstreamHeaders) {
    Object.assign(
      base,
      sanitizeUpstreamHeadersMap(
        co.compatByProtocol[protocol]!.upstreamHeaders as Record<string, unknown>
      )
    );
  }
  return base;
}
