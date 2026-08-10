import { randomUUID } from "node:crypto";

import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  ScheduledTaskRun,
  UpdateScheduledTaskInput,
} from "../../shared/scheduled-task-contracts";
import type { Database } from "../database/database";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import { nextRunAt } from "./schedule";

interface TaskRow extends Record<string, unknown> {
  id: string;
  task_json: string;
}

interface RunRow extends Record<string, unknown> {
  id: string;
  run_json: string;
}

/** 以 SQLite 为单一事实来源的定时任务仓库。 */
export interface ScheduledTaskRepository {
  listAllTasks(): Promise<ScheduledTask[]>;
  listTasks(agentId: string): Promise<ScheduledTask[]>;
  getTask(id: string): Promise<ScheduledTask | undefined>;
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTask>;
  updateTask(id: string, input: ScheduledTaskUpdate): Promise<ScheduledTask | undefined>;
  claimDueTask(id: string, now: Date): Promise<ScheduledTask | undefined>;
  removeTask(id: string): Promise<void>;
  listBoundTasks(sessionId: string): Promise<ScheduledTask[]>;
  removeTasksForSession(sessionId: string): Promise<void>;
  appendRun(input: Omit<ScheduledTaskRun, "id">): Promise<ScheduledTaskRun>;
  updateRun(id: string, patch: Partial<ScheduledTaskRun>): Promise<ScheduledTaskRun | undefined>;
  listRuns(taskId: string): Promise<ScheduledTaskRun[]>;
  pruneRuns(limits: { perTask: number; global: number }): Promise<void>;
}

export type ScheduledTaskUpdate = UpdateScheduledTaskInput & Partial<Pick<ScheduledTask, "nextRunAt" | "lastRunAt">>;

/** 创建定时任务仓库，任务与运行记录均受数据库事务和外键保护。 */
export function createScheduledTaskRepository(database: Database): ScheduledTaskRepository {
  return {
    async listAllTasks() {
      return database.read<TaskRow>("SELECT id, task_json FROM scheduled_tasks ORDER BY created_at, id").map(toTask);
    },
    async listTasks(agentId) {
      return database.read<TaskRow>("SELECT id, task_json FROM scheduled_tasks WHERE agent_id = ? ORDER BY created_at, id", [agentId]).map(toTask);
    },
    async getTask(id) {
      const row = database.readOne<TaskRow>("SELECT id, task_json FROM scheduled_tasks WHERE id = ?", [id]);
      return row ? toTask(row) : undefined;
    },
    async createTask(input) {
      const now = new Date().toISOString();
      const task: ScheduledTask = {
        ...input,
        id: randomUUID(),
        name: input.name.trim(),
        prompt: input.prompt.trim(),
        createdAt: now,
        updatedAt: now,
      };
      const sessionId = targetSessionId(task);
      database.transaction(() => {
        validateTargetSession(database, task.agentId, sessionId);
        database.write(
          "INSERT INTO scheduled_tasks(id, agent_id, session_id, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [task.id, task.agentId, sessionId, JSON.stringify(task), task.createdAt, task.updatedAt],
        );
      });
      return task;
    },
    async updateTask(id, input) {
      // 同步事务内完成读-合并-写，避免调度器状态更新与用户 PATCH 互相覆盖。
      return database.transaction(() => {
        const row = database.readOne<TaskRow>("SELECT id, task_json FROM scheduled_tasks WHERE id = ?", [id]);
        if (!row) return undefined;
        const current = toTask(row);
        const updated: ScheduledTask = {
          ...current,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(input.nextRunAt !== undefined ? { nextRunAt: input.nextRunAt } : {}),
          ...(input.lastRunAt !== undefined ? { lastRunAt: input.lastRunAt } : {}),
          updatedAt: new Date().toISOString(),
        };
        const sessionId = targetSessionId(updated);
        validateTargetSession(database, updated.agentId, sessionId);
        database.write("UPDATE scheduled_tasks SET session_id = ?, task_json = ?, updated_at = ? WHERE id = ?", [
          sessionId,
          JSON.stringify(updated),
          updated.updatedAt,
          id,
        ]);
        return updated;
      });
    },
    async removeTask(id) {
      database.write("DELETE FROM scheduled_tasks WHERE id = ?", [id]);
    },
    async claimDueTask(id, now) {
      return database.transaction(() => {
        const row = database.readOne<TaskRow>("SELECT id, task_json FROM scheduled_tasks WHERE id = ?", [id]);
        if (!row) return undefined;
        const task = toTask(row);
        if (!task.enabled || !task.nextRunAt || Date.parse(task.nextRunAt) > now.getTime()) return undefined;
        const timestamp = now.toISOString();
        const claimed: ScheduledTask = {
          ...task,
          lastRunAt: timestamp,
          ...(task.schedule.type === "once" ? { enabled: false, nextRunAt: undefined } : { nextRunAt: nextRunAt(task.schedule, now) }),
          updatedAt: timestamp,
        };
        database.write("UPDATE scheduled_tasks SET task_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(claimed), timestamp, id]);
        return claimed;
      });
    },
    async listBoundTasks(sessionId) {
      return database.read<TaskRow>(
        "SELECT id, task_json FROM scheduled_tasks WHERE session_id = ? ORDER BY created_at, id",
        [sessionId],
      ).map(toTask);
    },
    async removeTasksForSession(sessionId) {
      database.write("DELETE FROM scheduled_tasks WHERE session_id = ?", [sessionId]);
    },
    async appendRun(input) {
      const run: ScheduledTaskRun = { ...input, id: randomUUID() };
      database.write(
        "INSERT INTO scheduled_task_runs(id, task_id, run_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?)",
        [run.id, run.taskId, JSON.stringify(run), run.startedAt, run.finishedAt ?? null],
      );
      pruneRuns(database, {
        perTask: SYSTEM_LIMITS.scheduledRunsPerTask,
        global: SYSTEM_LIMITS.scheduledRunsGlobal,
      });
      return run;
    },
    async updateRun(id, patch) {
      const row = database.readOne<RunRow>("SELECT id, run_json FROM scheduled_task_runs WHERE id = ?", [id]);
      if (!row) return undefined;
      const run = { ...toRun(row), ...patch };
      database.write("UPDATE scheduled_task_runs SET run_json = ?, finished_at = ? WHERE id = ?", [JSON.stringify(run), run.finishedAt ?? null, id]);
      return run;
    },
    async listRuns(taskId) {
      return database.read<RunRow>(
        "SELECT id, run_json FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC, id DESC",
        [taskId],
      ).map(toRun);
    },
    async pruneRuns({ perTask, global }) {
      pruneRuns(database, { perTask, global });
    },
  };
}

function targetSessionId(task: ScheduledTask): string | null {
  return task.target.type === "existing_session" ? task.target.sessionId : null;
}

function validateTargetSession(database: Database, agentId: string, sessionId: string | null): void {
  if (!sessionId) return;
  const session = database.readOne<{ agent_id: string }>("SELECT agent_id FROM sessions WHERE id = ?", [sessionId]);
  if (!session) throw new DomainError("SESSION_NOT_FOUND", "定时任务目标 Session 不存在");
  if (session.agent_id !== agentId) {
    throw new DomainError("SESSION_AGENT_CONFLICT", "定时任务与目标 Session 不属于同一 Agent");
  }
}

function pruneRuns(database: Database, limits: { perTask: number; global: number }): void {
  database.transaction(() => {
    database.write(`
      DELETE FROM scheduled_task_runs
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC, id DESC) AS position
          FROM scheduled_task_runs
        ) WHERE position > ?
      )
    `, [Math.max(0, limits.perTask)]);
    database.write(`
      DELETE FROM scheduled_task_runs
      WHERE id NOT IN (
        SELECT id FROM scheduled_task_runs ORDER BY started_at DESC, id DESC LIMIT ?
      )
    `, [Math.max(0, limits.global)]);
  });
}

function toTask(row: TaskRow): ScheduledTask {
  return JSON.parse(row.task_json) as ScheduledTask;
}

function toRun(row: RunRow): ScheduledTaskRun {
  return JSON.parse(row.run_json) as ScheduledTaskRun;
}
