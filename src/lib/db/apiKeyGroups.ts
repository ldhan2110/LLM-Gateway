/**
 * API Key Groups DB — CRUD operations for team/enterprise key grouping
 *
 * Tables: key_groups, group_model_permissions, key_group_members
 * Migration: 065_api_key_groups.sql
 *
 * Enables team-level API key management with model-level access control.
 */

import { getDbClient } from "@/lib/db/core";
import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────────────

export interface KeyGroup {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupModelPermission {
  id: string;
  groupId: string;
  modelPattern: string;
  provider: string | null;
  accessType: "allow" | "deny";
  createdAt: string;
}

export interface KeyGroupMember {
  keyId: string;
  groupId: string;
  createdAt: string;
}

export interface KeyGroupWithPermissions extends KeyGroup {
  permissions: GroupModelPermission[];
  memberCount: number;
}

// ── Key Groups CRUD ──────────────────────────────────────────────────────

export async function getAllKeyGroups(): Promise<KeyGroup[]> {
  const db = getDbClient();
  const rows = await db.all("SELECT * FROM key_groups ORDER BY name ASC");
  return rows.map(rowToGroup);
}

export async function getKeyGroup(id: string): Promise<KeyGroup | undefined> {
  const db = getDbClient();
  const row = await db.get("SELECT * FROM key_groups WHERE id = ?", id);
  return row ? rowToGroup(row) : undefined;
}

export async function getKeyGroupWithPermissions(id: string): Promise<KeyGroupWithPermissions | undefined> {
  const group = await getKeyGroup(id);
  if (!group) return undefined;

  const permissions = await getGroupPermissions(id);
  const memberCount = await getGroupMemberCount(id);

  return { ...group, permissions, memberCount };
}

export async function createKeyGroup(name: string, description = ""): Promise<KeyGroup> {
  const db = getDbClient();
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.run(
    "INSERT INTO key_groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    id,
    name,
    description,
    now,
    now
  );

  return (await getKeyGroup(id))!;
}

export async function updateKeyGroup(
  id: string,
  updates: { name?: string; description?: string; isActive?: boolean }
): Promise<KeyGroup | undefined> {
  const existing = await getKeyGroup(id);
  if (!existing) return undefined;

  const db = getDbClient();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    sets.push("name = ?");
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    params.push(updates.description);
  }
  if (updates.isActive !== undefined) {
    sets.push("is_active = ?");
    params.push(updates.isActive ? 1 : 0);
  }

  if (sets.length === 0) return existing;
  sets.push("updated_at = datetime('now')");
  params.push(id);

  await db.run(`UPDATE key_groups SET ${sets.join(", ")} WHERE id = ?`, ...params);
  return getKeyGroup(id);
}

export async function deleteKeyGroup(id: string): Promise<boolean> {
  const db = getDbClient();
  // CASCADE deletes permissions and members
  const result = await db.run("DELETE FROM key_groups WHERE id = ?", id);
  return (result.changes ?? 0) > 0;
}

// ── Group Permissions ────────────────────────────────────────────────────

export async function getGroupPermissions(groupId: string): Promise<GroupModelPermission[]> {
  const db = getDbClient();
  const rows = await db.all(
    "SELECT * FROM group_model_permissions WHERE group_id = ? ORDER BY access_type ASC, model_pattern ASC",
    groupId
  );
  return rows.map(rowToPermission);
}

export async function addGroupPermission(
  groupId: string,
  modelPattern: string,
  accessType: "allow" | "deny",
  provider?: string
): Promise<GroupModelPermission> {
  const db = getDbClient();
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.run(
    "INSERT INTO group_model_permissions (id, group_id, model_pattern, provider, access_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    groupId,
    modelPattern,
    provider || null,
    accessType,
    now
  );

  return (await getGroupPermissions(groupId)).find((p) => p.id === id)!;
}

export async function removeGroupPermission(permissionId: string): Promise<boolean> {
  const db = getDbClient();
  const result = await db.run(
    "DELETE FROM group_model_permissions WHERE id = ?",
    permissionId
  );
  return (result.changes ?? 0) > 0;
}

export async function clearGroupPermissions(groupId: string): Promise<void> {
  const db = getDbClient();
  await db.run("DELETE FROM group_model_permissions WHERE group_id = ?", groupId);
}

// ── Key Group Members ────────────────────────────────────────────────────

export async function getGroupMembers(groupId: string): Promise<KeyGroupMember[]> {
  const db = getDbClient();
  const rows = await db.all(
    "SELECT * FROM key_group_members WHERE group_id = ? ORDER BY created_at ASC",
    groupId
  );
  return rows.map(rowToMember);
}

export async function getKeyGroupsForApiKey(keyId: string): Promise<KeyGroup[]> {
  const db = getDbClient();
  const rows = await db.all(
    `SELECT g.* FROM key_groups g
    INNER JOIN key_group_members m ON g.id = m.group_id
    WHERE m.key_id = ? AND g.is_active = 1
    ORDER BY g.name ASC`,
    keyId
  );
  return rows.map(rowToGroup);
}

export async function addKeyToGroup(keyId: string, groupId: string): Promise<boolean> {
  const db = getDbClient();
  try {
    await db.run(
      "INSERT OR IGNORE INTO key_group_members (key_id, group_id) VALUES (?, ?)",
      keyId,
      groupId
    );
    return true;
  } catch {
    return false;
  }
}

export async function removeKeyFromGroup(keyId: string, groupId: string): Promise<boolean> {
  const db = getDbClient();
  const result = await db.run(
    "DELETE FROM key_group_members WHERE key_id = ? AND group_id = ?",
    keyId,
    groupId
  );
  return (result.changes ?? 0) > 0;
}

async function getGroupMemberCount(groupId: string): Promise<number> {
  const db = getDbClient();
  const row = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM key_group_members WHERE group_id = ?",
    groupId
  );
  return row?.count || 0;
}

// ── Authorization Helper ────────────────────────────────────────────────

export interface ModelAccessCheck {
  allowed: boolean;
  matchedRules: GroupModelPermission[];
  deniedBy: GroupModelPermission | null;
}

/**
 * Check if an API key has access to a specific model.
 * Deny rules override allow rules. If no rules match, access is allowed by default.
 */
export async function checkKeyModelAccess(
  keyId: string,
  model: string,
  provider?: string
): Promise<ModelAccessCheck> {
  const groups = await getKeyGroupsForApiKey(keyId);
  if (groups.length === 0) {
    // No groups = no restrictions
    return { allowed: true, matchedRules: [], deniedBy: null };
  }

  const db = getDbClient();
  const groupIds = groups.map((g) => g.id);
  const placeholders = groupIds.map(() => "?").join(",");

  const rules = await db.all(
    `SELECT * FROM group_model_permissions
    WHERE group_id IN (${placeholders})
    ORDER BY access_type ASC`,
    ...groupIds
  );

  const permissions = rules.map(rowToPermission);

  // Check deny rules first (they take precedence)
  const denyRules = permissions.filter(
    (p) =>
      p.accessType === "deny" &&
      matchesModelPattern(p.modelPattern, model) &&
      (!p.provider || p.provider === provider)
  );

  if (denyRules.length > 0) {
    return { allowed: false, matchedRules: permissions, deniedBy: denyRules[0] };
  }

  // Check allow rules
  const allowRules = permissions.filter(
    (p) =>
      p.accessType === "allow" &&
      matchesModelPattern(p.modelPattern, model) &&
      (!p.provider || p.provider === provider)
  );

  if (allowRules.length > 0) {
    return { allowed: true, matchedRules: permissions, deniedBy: null };
  }

  // No matching rules = restricted by group membership but no explicit allow
  return { allowed: false, matchedRules: permissions, deniedBy: null };
}

function matchesModelPattern(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(model);
  }
  return pattern === model;
}

// ── Row Mappers ──────────────────────────────────────────────────────────

function rowToGroup(row: any): KeyGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPermission(row: any): GroupModelPermission {
  return {
    id: row.id,
    groupId: row.group_id,
    modelPattern: row.model_pattern,
    provider: row.provider || null,
    accessType: row.access_type,
    createdAt: row.created_at,
  };
}

function rowToMember(row: any): KeyGroupMember {
  return {
    keyId: row.key_id,
    groupId: row.group_id,
    createdAt: row.created_at,
  };
}
