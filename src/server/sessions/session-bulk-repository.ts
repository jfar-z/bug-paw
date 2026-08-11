import { createHash } from "node:crypto";

import type { ScheduledTask } from "../../shared/scheduled-task-contracts";
import type { SessionBulkAction, SessionBulkPreparedPreview, SessionBulkResult } from "../../shared/session-bulk-contracts";
import { DomainError } from "../core/errors";
import type { Database } from "../database/database";

interface SessionBulkRow extends Record<string, unknown> {
  id: string;
  agent_id: string;
  display_name: string | null;
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
  preview(action: SessionBulkAction, sessionIds: string[]): Promise<SessionBulkPreparedPreview>;
  archive(preview: SessionBulkPreparedPreview, now: string): Promise<SessionBulkResult>;
  deletePreservingTasks(preview: SessionBulkPreparedPreview, now: string): Promise<SessionBulkResult>;
}

/** 创建会话批量事务 Repository。 */
export function createSessionBulkRepository(database: Database): SessionBulkRepository {
  return {
    async preview(action, sessionIds) {
      return readPreview(database, action, sessionIds, false).preview;
    },
    async archive(preview, now) {
      return database.transaction(() => {
        assertPreviewFresh(database, preview);
        for (const sessionId of preview.sessionIds) {
          database.write(
            "UPDATE sessions SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?",
            [now, now, sessionId],
          );
        }
        return { action: "archive", sessionCount: preview.sessionCount, affectedTaskCount: preview.tasks.length };
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
        for (const sessionId of preview.sessionIds) {
          database.write("DELETE FROM sessions WHERE id = ?", [sessionId]);
        }
        return { action: "delete", sessionCount: preview.sessionCount, affectedTaskCount: preview.tasks.length };
      });
    },
  };
}

function assertPreviewFresh(database: Database, expected: SessionBulkPreparedPreview) {
  const current = readPreview(database, expected.action, expected.sessionIds, true);
  if (current.preview.fingerprint !== expected.fingerprint) {
    throw new DomainError("SESSION_BULK_PREVIEW_STALE", "会话或定时任务已发生变化，请重新确认");
  }
  return current;
}

function readPreview(database: Database, action: SessionBulkAction, values: string[], stale: boolean) {
  const sessionIds = [...new Set(values)].sort();
  if (sessionIds.length === 0) {
    throw new DomainError("VALIDATION_FAILED", "至少选择一个会话");
  }
  const placeholders = sessionIds.map(() => "?").join(", ");
  const sessions = database.read<SessionBulkRow>(
    `SELECT id, agent_id, display_name, updated_at FROM sessions WHERE id IN (${placeholders}) ORDER BY id`,
    sessionIds,
  );
  if (sessions.length !== sessionIds.length) {
    throw new DomainError(stale ? "SESSION_BULK_PREVIEW_STALE" : "SESSION_NOT_FOUND", stale
      ? "会话或定时任务已发生变化，请重新确认"
      : "Session 不存在");
  }
  const agentIds = new Set(sessions.map((session) => session.agent_id));
  if (agentIds.size !== 1) {
    throw new DomainError("SESSION_AGENT_CONFLICT", "批量操作的 Session 必须属于同一 Agent");
  }
  const taskRows = database.read<SessionBulkTaskRow>(
    `SELECT id, session_id, task_json, updated_at FROM scheduled_tasks WHERE session_id IN (${placeholders}) ORDER BY created_at, id`,
    sessionIds,
  );
  const tasks = taskRows.map((row) => {
    const task = JSON.parse(row.task_json) as ScheduledTask;
    return { id: task.id, name: task.name, sessionId: row.session_id };
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({
    action,
    sessions: sessions.map((session) => [session.id, session.agent_id, session.display_name, session.updated_at]),
    tasks: taskRows.map((task) => [task.id, task.session_id, task.updated_at]),
  })).digest("hex");
  return {
    preview: {
      action,
      sessionIds,
      sessionCount: sessions.length,
      tasks,
      fingerprint,
      agentId: sessions[0]!.agent_id,
    } satisfies SessionBulkPreparedPreview,
    sessions,
    taskRows,
  };
}
