import { v4 as uuidv4 } from "uuid";
import type {
  CompressionEngineId,
  CompressionPipelineStep,
} from "@omniroute/open-sse/services/compression/types.ts";

import { backupDbFile } from "./backup";
import { getDbClient, rowToCamel } from "./core";

export interface CompressionCombo {
  id: string;
  name: string;
  description: string;
  pipeline: CompressionPipelineStep[];
  languagePacks: string[];
  outputMode: boolean;
  outputModeIntensity: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CompressionComboAssignment {
  id: string;
  compressionComboId: string;
  routingComboId: string;
  createdAt: string;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_COMPRESSION_COMBO_ID = "default-caveman";
const DEFAULT_COMPRESSION_COMBO_NAME = "Standard Savings";
const DEFAULT_COMPRESSION_COMBO_DESCRIPTION = "Default RTK + Caveman compression pipeline";
const LEGACY_DEFAULT_COMPRESSION_COMBO_DESCRIPTION = "Default Caveman compression pipeline";

function defaultCompressionComboPipeline(): CompressionPipelineStep[] {
  return [
    { engine: "rtk", intensity: "standard" },
    { engine: "caveman", intensity: "full" },
  ];
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function parseJsonArray<T>(value: unknown, fallback: T[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

const KNOWN_ENGINE_IDS = [
  "lite",
  "caveman",
  "aggressive",
  "ultra",
  "rtk",
  "headroom",
  "session-dedup",
  "ccr",
  "llmlingua",
];

function normalizePipeline(value: unknown): CompressionPipelineStep[] {
  return parseJsonArray<CompressionPipelineStep>(value, []).filter((step) => {
    return step && typeof step === "object" && KNOWN_ENGINE_IDS.includes(String(step.engine));
  });
}

function normalizeLanguagePacks(value: unknown): string[] {
  const packs = parseJsonArray<string>(value, ["en"]).filter(
    (pack): pack is string => typeof pack === "string" && pack.trim().length > 0
  );
  return [...new Set(packs.length > 0 ? packs.map((pack) => pack.trim()) : ["en"])];
}

function isLegacySeededDefaultPipeline(pipeline: CompressionPipelineStep[]): boolean {
  if (pipeline.length !== 1) return false;
  const [step] = pipeline;
  return step.engine === "caveman" && (step.intensity === undefined || step.intensity === "full");
}

async function upgradeLegacySeededDefaultCompressionCombo(): Promise<void> {
  const db = getDbClient();
  const row = await db.get<{ name?: string; description?: string; pipeline?: string }>(
    "SELECT name, description, pipeline FROM compression_combos WHERE id = ?",
    DEFAULT_COMPRESSION_COMBO_ID
  );

  if (!row) return;

  const description = String(row.description ?? "");
  const isSeededMetadata =
    String(row.name ?? "") === DEFAULT_COMPRESSION_COMBO_NAME &&
    (description === LEGACY_DEFAULT_COMPRESSION_COMBO_DESCRIPTION ||
      description === DEFAULT_COMPRESSION_COMBO_DESCRIPTION);

  if (!isSeededMetadata || !isLegacySeededDefaultPipeline(normalizePipeline(row.pipeline))) return;

  await db.run(
    `
    UPDATE compression_combos
    SET description = ?, pipeline = ?, updated_at = ?
    WHERE id = ?
  `,
    DEFAULT_COMPRESSION_COMBO_DESCRIPTION,
    JSON.stringify(defaultCompressionComboPipeline()),
    new Date().toISOString(),
    DEFAULT_COMPRESSION_COMBO_ID
  );
}

let tablesEnsured = false;

async function ensureCompressionComboTables(): Promise<void> {
  if (tablesEnsured) return;
  const db = getDbClient();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS compression_combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      pipeline TEXT NOT NULL DEFAULT '[]',
      language_packs TEXT DEFAULT '["en"]',
      output_mode INTEGER DEFAULT 0,
      output_mode_intensity TEXT DEFAULT 'full',
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS compression_combo_assignments (
      id TEXT PRIMARY KEY,
      compression_combo_id TEXT NOT NULL REFERENCES compression_combos(id) ON DELETE CASCADE,
      routing_combo_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(routing_combo_id)
    );

    CREATE INDEX IF NOT EXISTS idx_compression_combos_default
      ON compression_combos(is_default);
    CREATE INDEX IF NOT EXISTS idx_compression_combo_assignments_combo
      ON compression_combo_assignments(compression_combo_id);
    CREATE INDEX IF NOT EXISTS idx_compression_combo_assignments_routing
      ON compression_combo_assignments(routing_combo_id);
  `);
  await db.run(
    `
    INSERT OR IGNORE INTO compression_combos (
      id, name, description, pipeline, language_packs, output_mode, output_mode_intensity, is_default
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    DEFAULT_COMPRESSION_COMBO_ID,
    DEFAULT_COMPRESSION_COMBO_NAME,
    DEFAULT_COMPRESSION_COMBO_DESCRIPTION,
    JSON.stringify(defaultCompressionComboPipeline()),
    JSON.stringify(["en"]),
    0,
    "full",
    1
  );
  await upgradeLegacySeededDefaultCompressionCombo();
  tablesEnsured = true;
}

function rowToCompressionCombo(row: unknown): CompressionCombo | null {
  if (!row) return null;
  const camel = rowToCamel(row as Record<string, unknown>) as JsonRecord;
  return {
    id: String(camel.id),
    name: String(camel.name ?? ""),
    description: String(camel.description ?? ""),
    pipeline: normalizePipeline(camel.pipeline),
    languagePacks: normalizeLanguagePacks(camel.languagePacks),
    outputMode: Boolean(camel.outputMode),
    outputModeIntensity: String(camel.outputModeIntensity ?? "full"),
    isDefault: Boolean(camel.isDefault),
    createdAt: String(camel.createdAt ?? ""),
    updatedAt: String(camel.updatedAt ?? ""),
  };
}

function rowToAssignment(row: unknown): CompressionComboAssignment | null {
  if (!row) return null;
  const camel = rowToCamel(row as Record<string, unknown>) as JsonRecord;
  return {
    id: String(camel.id),
    compressionComboId: String(camel.compressionComboId),
    routingComboId: String(camel.routingComboId),
    createdAt: String(camel.createdAt ?? ""),
  };
}

function buildComboPayload(data: Partial<CompressionCombo>, existing?: CompressionCombo) {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? data.id ?? uuidv4(),
    name: data.name?.trim() || existing?.name || "Compression Combo",
    description: data.description ?? existing?.description ?? "",
    pipeline:
      data.pipeline && data.pipeline.length > 0
        ? data.pipeline
        : existing?.pipeline && existing.pipeline.length > 0
          ? existing.pipeline
          : defaultCompressionComboPipeline(),
    languagePacks:
      data.languagePacks && data.languagePacks.length > 0
        ? data.languagePacks
        : existing?.languagePacks && existing.languagePacks.length > 0
          ? existing.languagePacks
          : ["en"],
    outputMode: data.outputMode ?? existing?.outputMode ?? false,
    outputModeIntensity: data.outputModeIntensity ?? existing?.outputModeIntensity ?? "full",
    isDefault: data.isDefault ?? existing?.isDefault ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function listCompressionCombos(): Promise<CompressionCombo[]> {
  await ensureCompressionComboTables();
  const db = getDbClient();
  const rows = await db.all(
    "SELECT * FROM compression_combos ORDER BY is_default DESC, name COLLATE NOCASE ASC"
  );
  return rows.map(rowToCompressionCombo).filter((combo): combo is CompressionCombo => combo !== null);
}

export async function getCompressionCombo(id: string): Promise<CompressionCombo | null> {
  await ensureCompressionComboTables();
  const db = getDbClient();
  const row = await db.get("SELECT * FROM compression_combos WHERE id = ?", id);
  return rowToCompressionCombo(row);
}

export async function getDefaultCompressionCombo(): Promise<CompressionCombo | null> {
  await ensureCompressionComboTables();
  const db = getDbClient();
  const row = await db.get(
    "SELECT * FROM compression_combos WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1"
  );
  return rowToCompressionCombo(row);
}

export async function createCompressionCombo(
  data: Partial<CompressionCombo>
): Promise<CompressionCombo> {
  await ensureCompressionComboTables();
  const db = getDbClient();
  const combo = buildComboPayload(data);
  await db.transaction(async (c) => {
    if (combo.isDefault) await c.run("UPDATE compression_combos SET is_default = 0");
    await c.run(
      `
      INSERT INTO compression_combos (
        id, name, description, pipeline, language_packs, output_mode, output_mode_intensity,
        is_default, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      combo.id,
      combo.name,
      combo.description,
      JSON.stringify(combo.pipeline),
      JSON.stringify(combo.languagePacks),
      combo.outputMode ? 1 : 0,
      combo.outputModeIntensity,
      combo.isDefault ? 1 : 0,
      combo.createdAt,
      combo.updatedAt
    );
  });
  backupDbFile("pre-write");
  return (await getCompressionCombo(combo.id)) as CompressionCombo;
}

export async function updateCompressionCombo(
  id: string,
  data: Partial<CompressionCombo>
): Promise<CompressionCombo | null> {
  await ensureCompressionComboTables();
  const existing = await getCompressionCombo(id);
  if (!existing) return null;
  const combo = buildComboPayload(data, existing);
  const db = getDbClient();
  await db.transaction(async (c) => {
    if (combo.isDefault) await c.run("UPDATE compression_combos SET is_default = 0");
    await c.run(
      `
      UPDATE compression_combos
      SET name = ?, description = ?, pipeline = ?, language_packs = ?, output_mode = ?,
          output_mode_intensity = ?, is_default = ?, updated_at = ?
      WHERE id = ?
    `,
      combo.name,
      combo.description,
      JSON.stringify(combo.pipeline),
      JSON.stringify(combo.languagePacks),
      combo.outputMode ? 1 : 0,
      combo.outputModeIntensity,
      combo.isDefault ? 1 : 0,
      combo.updatedAt,
      id
    );
  });
  backupDbFile("pre-write");
  return getCompressionCombo(id);
}

export async function deleteCompressionCombo(id: string): Promise<boolean> {
  await ensureCompressionComboTables();
  const existing = await getCompressionCombo(id);
  if (!existing || existing.isDefault) return false;
  const db = getDbClient();
  const result = await db.run("DELETE FROM compression_combos WHERE id = ?", id);
  if (result.changes > 0) backupDbFile("pre-write");
  return result.changes > 0;
}

export async function setDefaultCompressionCombo(id: string): Promise<boolean> {
  await ensureCompressionComboTables();
  if (!(await getCompressionCombo(id))) return false;
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.transaction(async (c) => {
    await c.run("UPDATE compression_combos SET is_default = 0");
    await c.run("UPDATE compression_combos SET is_default = 1, updated_at = ? WHERE id = ?", now, id);
  });
  backupDbFile("pre-write");
  return true;
}

export async function getAssignmentsForCompressionCombo(
  id: string
): Promise<CompressionComboAssignment[]> {
  await ensureCompressionComboTables();
  const db = getDbClient();
  const rows = await db.all(
    "SELECT * FROM compression_combo_assignments WHERE compression_combo_id = ? ORDER BY routing_combo_id",
    id
  );
  return rows
    .map(rowToAssignment)
    .filter((assignment): assignment is CompressionComboAssignment => assignment !== null);
}

export async function getCompressionComboForRoutingCombo(
  routingComboId: string
): Promise<CompressionCombo | null> {
  await ensureCompressionComboTables();
  const db = getDbClient();
  const row = await db.get(
    `
      SELECT c.*
      FROM compression_combos c
      JOIN compression_combo_assignments a ON a.compression_combo_id = c.id
      WHERE a.routing_combo_id = ?
      LIMIT 1
    `,
    routingComboId
  );
  return rowToCompressionCombo(row);
}

export async function assignRoutingCombo(
  compressionComboId: string,
  routingComboId: string
): Promise<boolean> {
  await ensureCompressionComboTables();
  if (!(await getCompressionCombo(compressionComboId)) || !routingComboId.trim()) return false;
  const db = getDbClient();
  await db.run(
    `
      INSERT OR REPLACE INTO compression_combo_assignments (
        id, compression_combo_id, routing_combo_id, created_at
      )
      VALUES (?, ?, ?, ?)
    `,
    uuidv4(),
    compressionComboId,
    routingComboId.trim(),
    new Date().toISOString()
  );
  backupDbFile("pre-write");
  return true;
}

export async function unassignRoutingCombo(
  compressionComboId: string,
  routingComboId: string
): Promise<boolean> {
  await ensureCompressionComboTables();
  const db = getDbClient();
  const result = await db.run(
    "DELETE FROM compression_combo_assignments WHERE compression_combo_id = ? AND routing_combo_id = ?",
    compressionComboId,
    routingComboId
  );
  if (result.changes > 0) backupDbFile("pre-write");
  return result.changes > 0;
}

// Static stackPriority map — mirrors the values defined in each engine file.
// Using a static map avoids cross-workspace imports (open-sse → src/lib/db) that
// would introduce a circular dependency detected by check:cycles.
const ENGINE_STACK_PRIORITY: Record<string, number> = {
  "session-dedup": 3,
  ccr: 4,
  lite: 5,
  rtk: 10,
  headroom: 15,
  caveman: 20,
  aggressive: 30,
  llmlingua: 35,
  ultra: 40,
};

export async function setEngineInDefaultCombo(
  engineId: string,
  enabled: boolean,
  config?: Record<string, unknown>
): Promise<CompressionCombo | null> {
  if (!KNOWN_ENGINE_IDS.includes(engineId)) return null;
  await ensureCompressionComboTables();
  const existing = await getDefaultCompressionCombo();
  if (!existing) return null;

  let newPipeline = [...existing.pipeline];
  if (enabled) {
    const idx = newPipeline.findIndex((s) => s.engine === engineId);
    if (idx >= 0) {
      if (config !== undefined) {
        newPipeline[idx] = { ...newPipeline[idx], config };
      }
    } else {
      newPipeline.push({ engine: engineId as CompressionEngineId, ...(config ? { config } : {}) });
    }
    // Sort by stackPriority ascending so the pipeline runs in the correct order.
    newPipeline.sort((a, b) => {
      const pa = ENGINE_STACK_PRIORITY[a.engine] ?? 50;
      const pb = ENGINE_STACK_PRIORITY[b.engine] ?? 50;
      return pa - pb;
    });
  } else {
    newPipeline = newPipeline.filter((s) => s.engine !== engineId);
  }

  // Direct UPDATE — preserves empty pipeline (Fix #2) without going through
  // buildComboPayload which falls back to defaultCompressionComboPipeline() when
  // the incoming array is empty.
  const db = getDbClient();
  const now = new Date().toISOString();
  await db.run(
    "UPDATE compression_combos SET pipeline = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(newPipeline),
    now,
    existing.id
  );
  backupDbFile("pre-write");

  return getCompressionCombo(existing.id);
}

export async function updateAssignments(
  compressionComboId: string,
  routingComboIds: string[]
): Promise<boolean> {
  await ensureCompressionComboTables();
  if (!(await getCompressionCombo(compressionComboId))) return false;
  const cleanedIds = [...new Set(routingComboIds.map((id) => id.trim()).filter(Boolean))];
  const db = getDbClient();
  await db.transaction(async (c) => {
    await c.run(
      "DELETE FROM compression_combo_assignments WHERE compression_combo_id = ?",
      compressionComboId
    );
    if (cleanedIds.length > 0) {
      for (const routingComboId of cleanedIds) {
        await c.run(
          "DELETE FROM compression_combo_assignments WHERE routing_combo_id = ?",
          routingComboId
        );
        await c.run(
          `
          INSERT INTO compression_combo_assignments (
            id, compression_combo_id, routing_combo_id, created_at
          )
          VALUES (?, ?, ?, ?)
        `,
          uuidv4(),
          compressionComboId,
          routingComboId,
          new Date().toISOString()
        );
      }
    }
  });
  backupDbFile("pre-write");
  return true;
}
