/**
 * Database module: AgentBridgeMappings
 * CRUD operations for agent_bridge_mappings table.
 */

import { getDbClient } from "./core";
import type { AgentBridgeMappingRow } from "./_rowTypes";

export async function getMappingsForAgent(agentId: string): Promise<AgentBridgeMappingRow[]> {
  const db = getDbClient();
  return db.all<AgentBridgeMappingRow>(
    "SELECT agent_id, source_model, target_model, updated_at FROM agent_bridge_mappings WHERE agent_id = ? ORDER BY source_model ASC",
    agentId
  );
}

export async function setMappings(
  agentId: string,
  mappings: Array<{ source: string; target: string }>
): Promise<void> {
  const db = getDbClient();
  const now = new Date().toISOString();

  await db.transaction(async (c) => {
    await c.run("DELETE FROM agent_bridge_mappings WHERE agent_id = ?", agentId);
    for (const mapping of mappings) {
      await c.run(
        `INSERT INTO agent_bridge_mappings (agent_id, source_model, target_model, updated_at)
         VALUES (?, ?, ?, ?)`,
        agentId, mapping.source, mapping.target, now
      );
    }
  });
}

export async function deleteMapping(agentId: string, source: string): Promise<void> {
  const db = getDbClient();
  await db.run(
    "DELETE FROM agent_bridge_mappings WHERE agent_id = ? AND source_model = ?",
    agentId, source
  );
}
