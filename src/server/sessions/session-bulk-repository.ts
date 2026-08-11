import { createHash } from "node:crypto";

import type { ScheduledTask } from "../../shared/scheduled-task-contracts";
import type {
  SessionBulkAction,
  SessionBulkPreparedPreview,
  SessionBulkResult,
  SessionBulkTarget,
} from "../../shared/session-bulk-contracts";
import { DomainError } from "../core/errors";
import type { Database } from "../database/database";

interface SessionBulkRow extends Record<string, unknown> {
  id: string;
  agent_id: string;
  archived_at: string | null;
  display_name: string | null;
  projection_version: number;
  updated_at: string;
}

interface SessionBulkTaskRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  task_json: string;
  updated_at: string;
}

/** 批量会话预览与 SQLite 原子变更边界。 */
export interface SessionBulkRepository {
  preview(action: SessionBulkAction, target: SessionBulkTarget): Promise<SessionBulkPreparedPreview>;
  archive(preview: SessionBulkPreparedPreview, now: string): Promise<SessionBulkResult>;
  restore(preview: SessionBulkPreparedPreview, now: string): Promise<SessionBulkResult>;
  deletePreservingTasks(preview: SessionBulkPreparedPreview, now: string): Promise<SessionBulkResult>;
}

/** 创建会话批量事务 Repository。 */
export function createSessionBulkRepository(database: Database): SessionBulkRepository {
  return {
    async preview(action, target) {
      return readPreview(database, action, target, false).preview;
    },
    async archive(preview, now) {
      return database.transaction(() => {
        assertPreviewFresh(database, preview);
        for (const sessionId of preview.resolvedSessionIds) {
          database.write(
            "UPDATE sessions SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?",
            [now, now, sessionId],
          );
        }
        return { action: "archive", sessionCount: preview.sessionCount, affectedTaskCount: preview.tasks.length };
      });
    },
    async restore(preview, now) {
      return database.transaction(() => {
        assertPreviewFresh(database, preview);
        for (const sessionId of preview.resolvedSessionIds) {
          const result = database.write(
            "UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL",
            [now, sessionId],
          );
          if (result.changes !== 1) {
            throw stalePreviewError();
          }
        }
        return { action: "restore", sessionCount: preview.sessionCount, affectedTaskCount: preview.tasks.length };
      });
    },
    async deletePreservingTasks(preview, now) {
      return database.transaction(() => {
        const current = assertPreviewFresh(database, preview);
        const sessionNames = new Map(current.sessions.map((session) => [
          session.id,
          session.display_name?.trim() || session.id,
        ]));
        for (const row of current.taskRows) {
          const task = JSON.parse(row.task_json) as ScheduledTask;
          const nextTask: ScheduledTask = {
            ...task,
            enabled: false,
            target: {
              type: "deleted_session",
              sessionId: row.session_id,
              sessionName: sessionNames.get(row.session_id) ?? row.session_id,
            },
            updatedAt: now,
          };
          delete nextTask.nextRunAt;
          database.write(
            "UPDATE scheduled_tasks SET session_id = NULL, task_json = ?, updated_at = ? WHERE id = ?",
            [JSON.stringify(nextTask), now, task.id],
          );
        }
        for (const sessionId of preview.resolvedSessionIds) {
          database.write("DELETE FROM sessions WHERE id = ?", [sessionId]);
        }
        return { action: "delete", sessionCount: preview.sessionCount, affectedTaskCount: preview.tasks.length };
      });
    },
  };
}

function assertPreviewFresh(database: Database, expected: SessionBulkPreparedPreview) {
  const current = readPreview(database, expected.action, expected.target, true);
  if (current.preview.fingerprint !== expected.fingerprint) {
    throw stalePreviewError();
  }
  return current;
}

function readPreview(database: Database, action: SessionBulkAction, target: SessionBulkTarget, stale: boolean) {
  assertActionTarget(action, target);
  const sessions = readSessionRows(database, target, stale);
  const sessionIds = sessions.map(({ id }) => id);
  const agentIds = new Set(sessions.map((session) => session.agent_id));
  if (agentIds.size !== 1) {
    throw new DomainError("SESSION_AGENT_CONFLICT", "批量操作的 Session 必须属于同一 Agent");
  }
  const taskRows = readTaskRows(database, target, sessionIds);
  const tasks = taskRows.map((row) => {
    const task = JSON.parse(row.task_json) as ScheduledTask;
    return { id: task.id, name: task.name, sessionId: row.session_id };
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({
    action,
    target: normalizeTarget(target, sessionIds),
    sessions: sessions.map((session) => [
      session.id,
      session.agent_id,
      session.archived_at,
      session.display_name,
      session.projection_version,
      session.updated_at,
    ]),
    tasks: taskRows.map((task) => [task.id, task.session_id, task.task_json, task.updated_at]),
  })).digest("hex");
  return {
    preview: {
      action,
      target: normalizeTarget(target, sessionIds),
      sessionCount: sessions.length,
      tasks,
      fingerprint,
      agentId: sessions[0]!.agent_id,
      resolvedSessionIds: sessionIds,
    } satisfies SessionBulkPreparedPreview,
    sessions,
    taskRows,
  };
}

/** 服务端再次校验动作与范围，避免绕过 HTTP 边界。 */
function assertActionTarget(action: SessionBulkAction, target: SessionBulkTarget): void {
  const allowed = target.mode === "selected"
    ? action === "archive" || action === "delete"
    : action === "restore" || action === "delete";
  if (!allowed) throw new DomainError("VALIDATION_FAILED", "批量操作与目标范围不匹配");
}

/** 将客户端范围解析为稳定排序的真实会话集合。 */
function readSessionRows(database: Database, target: SessionBulkTarget, stale: boolean): SessionBulkRow[] {
  if (target.mode === "selected") {
    const sessionIds = [...new Set(target.sessionIds)].sort();
    if (sessionIds.length === 0 || sessionIds.length > 200) {
      if (stale) throw stalePreviewError();
      throw new DomainError("VALIDATION_FAILED", sessionIds.length === 0 ? "至少选择一个会话" : "批量选择不能超过 200 个会话");
    }
    const placeholders = sessionIds.map(() => "?").join(", ");
    const sessions = database.read<SessionBulkRow>(`
      SELECT id, agent_id, archived_at, display_name, projection_version, updated_at
      FROM sessions WHERE id IN (${placeholders}) ORDER BY id
    `, sessionIds);
    if (sessions.length !== sessionIds.length) {
      throw stale ? stalePreviewError() : new DomainError("SESSION_NOT_FOUND", "Session 不存在");
    }
    return sessions;
  }
  assertId("Agent", target.agentId);
  const sessions = database.read<SessionBulkRow>(`
    SELECT id, agent_id, archived_at, display_name, projection_version, updated_at
    FROM sessions WHERE agent_id = ? AND archived_at IS NOT NULL ORDER BY id
  `,
    [target.agentId],
  );
  if (sessions.length === 0) {
    if (stale) throw stalePreviewError();
    throw new DomainError("VALIDATION_FAILED", "没有可操作的归档会话");
  }
  return sessions;
}

/** 全归档范围使用联表查询，避免把无界 ID 集合展开为 SQLite 参数。 */
function readTaskRows(database: Database, target: SessionBulkTarget, sessionIds: string[]): SessionBulkTaskRow[] {
  if (target.mode === "all_archived") {
    return database.read<SessionBulkTaskRow>(`
      SELECT tasks.id, tasks.session_id, tasks.task_json, tasks.updated_at
      FROM scheduled_tasks AS tasks
      INNER JOIN sessions ON sessions.id = tasks.session_id
      WHERE sessions.agent_id = ? AND sessions.archived_at IS NOT NULL
      ORDER BY tasks.created_at, tasks.id
    `, [target.agentId]);
  }
  const placeholders = sessionIds.map(() => "?").join(", ");
  return database.read<SessionBulkTaskRow>(
    `SELECT id, session_id, task_json, updated_at FROM scheduled_tasks WHERE session_id IN (${placeholders}) ORDER BY created_at, id`,
    sessionIds,
  );
}

function normalizeTarget(target: SessionBulkTarget, sessionIds: string[]): SessionBulkTarget {
  return target.mode === "selected"
    ? { mode: "selected", sessionIds }
    : { mode: "all_archived", agentId: target.agentId };
}

function stalePreviewError(): DomainError {
  return new DomainError("SESSION_BULK_PREVIEW_STALE", "会话或定时任务已发生变化，请重新确认");
}

function assertId(kind: "Agent", value: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${kind} ID 格式不正确`);
  }
}
