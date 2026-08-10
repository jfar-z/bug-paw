import { DomainError } from "../core/errors";
import type { Database } from "../database/database";

export interface SessionRecord {
  id: string;
  agentId: string;
  archivedAt?: string;
  displayName?: string;
  projectionVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRepository {
  assign(sessionId: string, agentId: string, now: string): Promise<SessionRecord>;
  find(sessionId: string): Promise<SessionRecord | undefined>;
  listByAgent(agentId: string, archived: boolean): Promise<SessionRecord[]>;
  listArchivedIds(): Promise<string[]>;
  listIdsByAgent(agentId: string): Promise<string[]>;
  removeByAgent(agentId: string): Promise<void>;
  archive(sessionId: string, now: string): Promise<void>;
  unarchive(sessionId: string, now: string): Promise<void>;
  rename(sessionId: string, name: string, now: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  removeWithBoundTasks(sessionId: string, deleteScheduledTasks: boolean): Promise<void>;
  bumpProjectionVersion(sessionId: string, now: string): Promise<number>;
}

/** 创建 Session 归属和 Web 元数据 Repository。 */
export function createSessionRepository(database: Database): SessionRepository {
  return {
    async assign(sessionId, agentId, now) {
      assertId("Session", sessionId);
      assertId("Agent", agentId);
      return database.transaction(() => {
        const existing = database.readOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", [sessionId]);
        if (existing) {
          if (existing.agent_id !== agentId) {
            throw new DomainError("SESSION_AGENT_CONFLICT", "Session 已归属其他 Agent");
          }
          return toRecord(existing);
        }
        database.write(`
          INSERT INTO sessions(id, agent_id, projection_version, created_at, updated_at)
          VALUES (?, ?, 0, ?, ?)
        `, [sessionId, agentId, now, now]);
        return {
          id: sessionId,
          agentId,
          projectionVersion: 0,
          createdAt: now,
          updatedAt: now,
        };
      });
    },
    async find(sessionId) {
      assertId("Session", sessionId);
      const row = database.readOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", [sessionId]);
      return row ? toRecord(row) : undefined;
    },
    async listByAgent(agentId, archived) {
      assertId("Agent", agentId);
      const predicate = archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
      return database.read<SessionRow>(`
        SELECT * FROM sessions WHERE agent_id = ? AND ${predicate} ORDER BY updated_at DESC, id
      `, [agentId]).map(toRecord);
    },
    async listArchivedIds() {
      return database.read<{ id: string }>(
        "SELECT id FROM sessions WHERE archived_at IS NOT NULL ORDER BY id",
      ).map(({ id }) => id);
    },
    async listIdsByAgent(agentId) {
      assertId("Agent", agentId);
      return database.read<{ id: string }>(
        "SELECT id FROM sessions WHERE agent_id = ? ORDER BY id",
        [agentId],
      ).map(({ id }) => id);
    },
    async removeByAgent(agentId) {
      assertId("Agent", agentId);
      database.write("DELETE FROM sessions WHERE agent_id = ?", [agentId]);
    },
    async archive(sessionId, now) {
      assertId("Session", sessionId);
      assertChanged(database.write(
        "UPDATE sessions SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?",
        [now, now, sessionId],
      ).changes);
    },
    async unarchive(sessionId, now) {
      assertId("Session", sessionId);
      assertChanged(database.write(
        "UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ?",
        [now, sessionId],
      ).changes);
    },
    async rename(sessionId, name, now) {
      assertId("Session", sessionId);
      assertChanged(database.write(
        "UPDATE sessions SET display_name = ?, updated_at = ? WHERE id = ?",
        [name, now, sessionId],
      ).changes);
    },
    async remove(sessionId) {
      assertId("Session", sessionId);
      database.write("DELETE FROM sessions WHERE id = ?", [sessionId]);
    },
    async removeWithBoundTasks(sessionId, deleteScheduledTasks) {
      assertId("Session", sessionId);
      database.transaction(() => {
        const boundCount = database.readOne<{ count: number }>(
          "SELECT COUNT(*) AS count FROM scheduled_tasks WHERE session_id = ?",
          [sessionId],
        )?.count ?? 0;
        if (boundCount > 0 && !deleteScheduledTasks) {
          throw new DomainError("SCHEDULED_TASKS_BOUND", `会话已绑定 ${boundCount} 个定时任务，请确认同时删除`);
        }
        if (deleteScheduledTasks) database.write("DELETE FROM scheduled_tasks WHERE session_id = ?", [sessionId]);
        const result = database.write("DELETE FROM sessions WHERE id = ?", [sessionId]);
        assertChanged(result.changes);
      });
    },
    async bumpProjectionVersion(sessionId, now) {
      assertId("Session", sessionId);
      assertChanged(database.write(`
        UPDATE sessions SET projection_version = projection_version + 1, updated_at = ? WHERE id = ?
      `, [now, sessionId]).changes);
      return database.readOne<{ projection_version: number }>(
        "SELECT projection_version FROM sessions WHERE id = ?",
        [sessionId],
      )!.projection_version;
    },
  };
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  agent_id: string;
  archived_at: string | null;
  display_name: string | null;
  projection_version: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    ...(row.display_name ? { displayName: row.display_name } : {}),
    projectionVersion: row.projection_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertChanged(changes: number): void {
  if (changes !== 1) throw new DomainError("SESSION_NOT_FOUND", "Session 不存在");
}

function assertId(kind: "Session" | "Agent", value: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${kind} ID 格式不正确`);
  }
}
