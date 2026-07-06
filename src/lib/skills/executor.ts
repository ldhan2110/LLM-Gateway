import { skillRegistry } from "./registry";
import { SkillExecution, SkillStatus, SkillHandler } from "./types";
import { getDbClient } from "../db/core";
import { getSettings } from "../db/settings";
import { randomUUID } from "crypto";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("SKILLS_EXECUTOR");

class SkillExecutor {
  private static instance: SkillExecutor;
  private handlers: Map<string, SkillHandler> = new Map();
  private timeout: number = 30000;
  private maxRetries: number = 3;

  private constructor() {}

  static getInstance(): SkillExecutor {
    if (!SkillExecutor.instance) {
      SkillExecutor.instance = new SkillExecutor();
    }
    return SkillExecutor.instance;
  }

  registerHandler(name: string, handler: SkillHandler): void {
    this.handlers.set(name, handler);
  }

  setTimeout(ms: number): void {
    this.timeout = ms;
  }

  setMaxRetries(count: number): void {
    this.maxRetries = count;
  }

  async execute(
    skillName: string,
    input: Record<string, unknown>,
    context: { apiKeyId: string; sessionId?: string }
  ): Promise<SkillExecution> {
    const settings = await getSettings();
    if (settings.skillsEnabled === false) {
      throw new Error("Skills execution is disabled. Enable Skills in Settings > AI.");
    }

    const skill = skillRegistry.getSkill(skillName, context.apiKeyId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    if (!skill.enabled) {
      throw new Error(`Skill is disabled: ${skillName}`);
    }

    const db = getDbClient();
    const executionId = randomUUID();
    const startTime = Date.now();

    log.info("skills.executor.start", { skillId: skill.id, skillName, apiKeyId: context.apiKeyId });

    try {
      await db.run(
        `INSERT INTO skill_executions (id, skill_id, api_key_id, session_id, input, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        executionId,
        skill.id,
        context.apiKeyId,
        context.sessionId || null,
        JSON.stringify(input),
        SkillStatus.RUNNING,
        new Date().toISOString()
      );

      const handler = this.handlers.get(skill.handler);
      if (!handler) {
        throw new Error(`Handler not found: ${skill.handler}`);
      }

      let output: Record<string, unknown> | null = null;
      let errorMessage: string | null = null;
      let status = SkillStatus.SUCCESS;

      try {
        const result = await this.executeWithTimeout(
          handler(input, { apiKeyId: context.apiKeyId, sessionId: context.sessionId || "" })
        );
        output = result;
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        status = SkillStatus.ERROR;
      }

      const durationMs = Date.now() - startTime;

      await db.run(
        `UPDATE skill_executions SET output = ?, status = ?, error_message = ?, duration_ms = ? WHERE id = ?`,
        output ? JSON.stringify(output) : null,
        status,
        errorMessage,
        durationMs,
        executionId
      );

      log.info("skills.executor.complete", {
        skillId: skill.id,
        success: status === SkillStatus.SUCCESS,
        durationMs,
      });

      return {
        id: executionId,
        skillId: skill.id,
        apiKeyId: context.apiKeyId,
        sessionId: context.sessionId || "",
        input,
        output,
        status,
        errorMessage,
        durationMs,
        createdAt: new Date(),
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      await db.run(
        `UPDATE skill_executions SET status = ?, error_message = ?, duration_ms = ? WHERE id = ?`,
        SkillStatus.ERROR,
        errorMessage,
        durationMs,
        executionId
      );

      throw err;
    }
  }

  private async executeWithTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("Skill execution timed out")), this.timeout)
      ),
    ]);
  }

  async getExecution(executionId: string): Promise<SkillExecution | undefined> {
    const db = getDbClient();
    const row = await db.get<any>("SELECT * FROM skill_executions WHERE id = ?", executionId);
    if (!row) return undefined;

    return {
      id: row.id,
      skillId: row.skill_id,
      apiKeyId: row.api_key_id,
      sessionId: row.session_id || "",
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : null,
      status: row.status as SkillStatus,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: new Date(row.created_at),
    };
  }

  async listExecutions(
    apiKeyId?: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<SkillExecution[]> {
    const db = getDbClient();
    const rows = apiKeyId
      ? await db.all<any>(
          "SELECT * FROM skill_executions WHERE api_key_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
          apiKeyId,
          limit,
          offset
        )
      : await db.all<any>(
          "SELECT * FROM skill_executions ORDER BY created_at DESC LIMIT ? OFFSET ?",
          limit,
          offset
        );

    return rows.map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      apiKeyId: row.api_key_id,
      sessionId: row.session_id || "",
      input: JSON.parse(row.input),
      output: row.output ? JSON.parse(row.output) : null,
      status: row.status as SkillStatus,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: new Date(row.created_at),
    }));
  }

  async countExecutions(apiKeyId?: string): Promise<number> {
    const db = getDbClient();
    const row = apiKeyId
      ? await db.get<{ count: number }>(
          "SELECT COUNT(*) as count FROM skill_executions WHERE api_key_id = ?",
          apiKeyId
        )
      : await db.get<{ count: number }>("SELECT COUNT(*) as count FROM skill_executions");
    return row?.count ?? 0;
  }
}

export const skillExecutor = SkillExecutor.getInstance();
