/**
 * db/modelComboMappings.ts — Per-model combo mapping CRUD + resolution.
 *
 * Maps model name patterns (glob-style wildcards) to specific combos.
 * When a request arrives for a model string like "claude-sonnet-4",
 * the resolver checks all enabled mappings (highest priority first)
 * and returns the first matching combo.
 */

import { v4 as uuidv4 } from "uuid";
import { getDbClient } from "./core";

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export interface ModelComboMapping {
  id: string;
  pattern: string;
  comboId: string;
  comboName?: string;
  priority: number;
  enabled: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface MappingRow {
  id: string;
  pattern: string;
  combo_id: string;
  combo_name?: string;
  priority: number;
  enabled: number;
  description: string;
  created_at: string;
  updated_at: string;
}

// ──────────────────────────────────────────────────────────
// Glob → RegExp conversion
// ──────────────────────────────────────────────────────────

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports `*` (any characters) and `?` (single character).
 * Case-insensitive matching.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials
    .replace(/\*/g, ".*") // * → .*
    .replace(/\?/g, "."); // ? → .
  return new RegExp(`^${escaped}$`, "i");
}

// ──────────────────────────────────────────────────────────
// Row mapping
// ──────────────────────────────────────────────────────────

function rowToMapping(row: MappingRow): ModelComboMapping {
  return {
    id: row.id,
    pattern: row.pattern,
    comboId: row.combo_id,
    comboName: row.combo_name || undefined,
    priority: row.priority,
    enabled: row.enabled === 1,
    description: row.description || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ──────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────

/**
 * List all model-combo mappings, joined with combo name.
 * Ordered by priority descending (highest first).
 */
export async function getModelComboMappings(): Promise<ModelComboMapping[]> {
  const db = getDbClient();
  const rows = await db.all<MappingRow>(
    `SELECT m.id, m.pattern, m.combo_id, c.name AS combo_name,
              m.priority, m.enabled, m.description,
              m.created_at, m.updated_at
       FROM model_combo_mappings m
       LEFT JOIN combos c ON c.id = m.combo_id
       ORDER BY m.priority DESC, m.created_at ASC`
  );
  return rows.map(rowToMapping);
}

/**
 * Get a single mapping by ID.
 */
export async function getModelComboMappingById(id: string): Promise<ModelComboMapping | null> {
  const db = getDbClient();
  const row = await db.get<MappingRow>(
    `SELECT m.id, m.pattern, m.combo_id, c.name AS combo_name,
              m.priority, m.enabled, m.description,
              m.created_at, m.updated_at
       FROM model_combo_mappings m
       LEFT JOIN combos c ON c.id = m.combo_id
       WHERE m.id = ?`,
    id
  );
  return row ? rowToMapping(row) : null;
}

/**
 * Create a new model-combo mapping.
 */
export async function createModelComboMapping(data: {
  pattern: string;
  comboId: string;
  priority?: number;
  enabled?: boolean;
  description?: string;
}): Promise<ModelComboMapping> {
  const db = getDbClient();
  const now = new Date().toISOString();
  const id = uuidv4();

  await db.run(
    `INSERT INTO model_combo_mappings
     (id, pattern, combo_id, priority, enabled, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    data.pattern,
    data.comboId,
    data.priority ?? 0,
    data.enabled !== false ? 1 : 0,
    data.description || "",
    now,
    now
  );

  return {
    id,
    pattern: data.pattern,
    comboId: data.comboId,
    priority: data.priority ?? 0,
    enabled: data.enabled !== false,
    description: data.description || "",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update an existing model-combo mapping.
 */
export async function updateModelComboMapping(
  id: string,
  data: Partial<{
    pattern: string;
    comboId: string;
    priority: number;
    enabled: boolean;
    description: string;
  }>
): Promise<ModelComboMapping | null> {
  const existing = await getModelComboMappingById(id);
  if (!existing) return null;

  const db = getDbClient();
  const now = new Date().toISOString();
  const updated = {
    pattern: data.pattern ?? existing.pattern,
    combo_id: data.comboId ?? existing.comboId,
    priority: data.priority ?? existing.priority,
    enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : existing.enabled ? 1 : 0,
    description: data.description ?? existing.description,
  };

  await db.run(
    `UPDATE model_combo_mappings
     SET pattern = ?, combo_id = ?, priority = ?, enabled = ?,
         description = ?, updated_at = ?
     WHERE id = ?`,
    updated.pattern,
    updated.combo_id,
    updated.priority,
    updated.enabled,
    updated.description,
    now,
    id
  );

  return getModelComboMappingById(id);
}

/**
 * Delete a model-combo mapping.
 */
export async function deleteModelComboMapping(id: string): Promise<boolean> {
  const db = getDbClient();
  const result = await db.run("DELETE FROM model_combo_mappings WHERE id = ?", id);
  return (result.changes ?? 0) > 0;
}

// ──────────────────────────────────────────────────────────
// Core: Resolve combo for a model string
// ──────────────────────────────────────────────────────────

/**
 * Check if a model string matches any enabled model-combo mapping.
 * Returns the full combo object if a match is found, null otherwise.
 *
 * Mappings are checked in priority order (highest first).
 * Uses glob-style pattern matching (* = any chars, ? = single char).
 */
export async function resolveComboForModel(
  modelStr: string
): Promise<Record<string, unknown> | null> {
  const db = getDbClient();

  // Fetch enabled mappings, ordered by priority (highest first)
  const rows = await db.all<{ pattern: string; combo_id: string; combo_data: string }>(
    `SELECT m.pattern, m.combo_id, c.data AS combo_data
       FROM model_combo_mappings m
       JOIN combos c ON c.id = m.combo_id
       WHERE m.enabled = 1
       ORDER BY m.priority DESC, m.created_at ASC`
  );

  for (const row of rows) {
    const regex = globToRegex(row.pattern);
    if (regex.test(modelStr)) {
      try {
        const combo = JSON.parse(row.combo_data) as Record<string, unknown>;
        if (combo.isActive === false) {
          continue;
        }
        return combo;
      } catch {
        // Corrupted combo data — skip
        continue;
      }
    }
  }

  return null;
}
