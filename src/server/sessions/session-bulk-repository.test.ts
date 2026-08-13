// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "../database/database";
import { createTestDatabase } from "../database/test-database";
import { createAgentRepository } from "../agents/agent-repository";
import { createScheduledTaskRepository } from "../scheduled-tasks/scheduled-task-repository";
import { createSessionBulkRepository } from "./session-bulk-repository";
import { createSessionRepository } from "./session-repository";

describe("SessionBulkRepository", () => {
  const databases: Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it("批量删除时保留并停用绑定任务及其运行历史", async () => {
    const { bulk, sessions, tasks } = await createFixture();
    const daily = await tasks.createTask(taskInput("task-daily", "日报", "session-1"));
    const weekly = await tasks.createTask(taskInput("task-weekly", "周报", "session-2"));
    await tasks.updateTask(daily.id, { nextRunAt: "2026-08-12T00:00:00.000Z" });
    await tasks.appendRun({
      taskId: daily.id,
      trigger: "manual",
      status: "completed",
      startedAt: "2026-08-10T00:00:00.000Z",
      finishedAt: "2026-08-10T00:01:00.000Z",
      prompt: "生成日报",
    });

    const preview = await bulk.preview("delete", { mode: "selected", sessionIds: ["session-2", "session-1", "session-1"] });
    expect(preview.resolvedSessionIds).toEqual(["session-1", "session-2"]);
    expect(new Set(preview.tasks.map((task) => task.name))).toEqual(new Set(["日报", "周报"]));

    const result = await bulk.deletePreservingTasks(preview, "2026-08-11T10:00:00.000Z");

    expect(result).toEqual({ action: "delete", sessionCount: 2, affectedTaskCount: 2 });
    expect(await sessions.find("session-1")).toBeUndefined();
    expect(await sessions.find("session-2")).toBeUndefined();
    expect(await tasks.getTask(daily.id)).toMatchObject({
      enabled: false,
      target: { type: "deleted_session", sessionId: "session-1", sessionName: "日报会话" },
    });
    expect((await tasks.getTask(daily.id))?.nextRunAt).toBeUndefined();
    expect(await tasks.getTask(weekly.id)).toMatchObject({
      enabled: false,
      target: { type: "deleted_session", sessionId: "session-2", sessionName: "周报会话" },
    });
    expect(await tasks.listRuns(daily.id)).toHaveLength(1);
  });

  it("预览后任务绑定变化时拒绝执行并保持会话", async () => {
    const { bulk, sessions, tasks } = await createFixture();
    const preview = await bulk.preview("delete", { mode: "selected", sessionIds: ["session-1"] });
    await tasks.createTask(taskInput("task-late", "新增任务", "session-1"));

    await expect(bulk.deletePreservingTasks(preview, "2026-08-11T10:00:00.000Z"))
      .rejects.toMatchObject({ code: "SESSION_BULK_PREVIEW_STALE" });
    expect(await sessions.find("session-1")).toBeDefined();
    expect(await tasks.listBoundTasks("session-1")).toHaveLength(1);
  });

  it("批量归档会话但保持绑定任务原状态", async () => {
    const { bulk, sessions, tasks } = await createFixture();
    const task = await tasks.createTask(taskInput("task-daily", "日报", "session-1"));
    await sessions.pin("session-1", "2026-08-11T09:00:00.000Z");
    const preview = await bulk.preview("archive", { mode: "selected", sessionIds: ["session-1"] });

    await expect(bulk.archive(preview, "2026-08-11T10:00:00.000Z"))
      .resolves.toEqual({ action: "archive", sessionCount: 1, affectedTaskCount: 1 });
    expect(await sessions.find("session-1")).toMatchObject({ archivedAt: "2026-08-11T10:00:00.000Z" });
    expect(await sessions.find("session-1")).not.toHaveProperty("pinnedAt");
    expect(await tasks.getTask(task.id)).toMatchObject({
      enabled: true,
      target: { type: "existing_session", sessionId: "session-1" },
    });

    const restorePreview = await bulk.preview("restore", { mode: "all_archived", agentId: "agent-1" });
    await bulk.restore(restorePreview, "2026-08-11T11:00:00.000Z");
    expect(await sessions.find("session-1")).not.toHaveProperty("pinnedAt");
  });

  it("解析并恢复超过 200 个当前 Agent 的归档会话", async () => {
    const { bulk, sessions } = await createFixture();
    const sessionIds = Array.from({ length: 205 }, (_, index) => `archived-${index}`);
    for (const sessionId of sessionIds) {
      await sessions.assign(sessionId, "agent-1", "2026-08-10T00:00:00.000Z");
      await sessions.archive(sessionId, "2026-08-10T00:01:00.000Z");
    }

    const preview = await bulk.preview("restore", { mode: "all_archived", agentId: "agent-1" });
    expect(preview.resolvedSessionIds).toHaveLength(205);

    await expect(bulk.restore(preview, "2026-08-11T10:00:00.000Z")).resolves.toEqual({
      action: "restore",
      sessionCount: 205,
      affectedTaskCount: 0,
    });
    expect(await sessions.listByAgent("agent-1", true)).toHaveLength(0);
    expect((await sessions.listByAgent("agent-1", false)).map(({ id }) => id))
      .toEqual(expect.arrayContaining(sessionIds));
  });

  it("全部恢复不影响同 Agent 未归档会话和其他 Agent 的归档会话", async () => {
    const { bulk, database, sessions } = await createFixture();
    await sessions.archive("session-1", "2026-08-10T00:01:00.000Z");
    await createAgentRepository(database).insert({
      version: 1,
      id: "agent-2",
      name: "Agent 2",
      avatar: { kind: "initial", value: "B" },
      description: "",
      status: "active",
      cwd: "/workspace/agent-2",
      allowedTools: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    await sessions.assign("session-other", "agent-2", "2026-08-07T00:00:00.000Z");
    await sessions.archive("session-other", "2026-08-10T00:01:00.000Z");

    const preview = await bulk.preview("restore", { mode: "all_archived", agentId: "agent-1" });
    expect(preview.resolvedSessionIds).toEqual(["session-1"]);
    await bulk.restore(preview, "2026-08-11T10:00:00.000Z");

    expect(await sessions.find("session-1")).not.toHaveProperty("archivedAt");
    expect(await sessions.find("session-2")).not.toHaveProperty("archivedAt");
    expect(await sessions.find("session-other")).toHaveProperty("archivedAt");
  });

  it("全部范围变化后原预览失效", async () => {
    const { bulk, sessions } = await createFixture();
    await sessions.archive("session-1", "2026-08-10T00:01:00.000Z");
    const preview = await bulk.preview("restore", { mode: "all_archived", agentId: "agent-1" });
    await sessions.archive("session-2", "2026-08-10T00:02:00.000Z");

    await expect(bulk.restore(preview, "2026-08-11T10:00:00.000Z"))
      .rejects.toMatchObject({ code: "SESSION_BULK_PREVIEW_STALE" });
    expect(await sessions.find("session-1")).toHaveProperty("archivedAt");
    expect(await sessions.find("session-2")).toHaveProperty("archivedAt");
  });

  it("全部恢复失败时回滚已恢复的会话", async () => {
    const { bulk, database, sessions } = await createFixture();
    await sessions.archive("session-1", "2026-08-10T00:01:00.000Z");
    await sessions.archive("session-2", "2026-08-10T00:01:00.000Z");
    const preview = await bulk.preview("restore", { mode: "all_archived", agentId: "agent-1" });
    const failingDatabase: Database = {
      ...database,
      write(sql, parameters) {
        if (sql.includes("SET archived_at = NULL") && parameters?.[1] === "session-2") {
          throw new Error("database unavailable");
        }
        return database.write(sql, parameters);
      },
    };

    await expect(createSessionBulkRepository(failingDatabase).restore(preview, "2026-08-11T10:00:00.000Z"))
      .rejects.toThrow("database unavailable");
    expect(await sessions.find("session-1")).toHaveProperty("archivedAt");
    expect(await sessions.find("session-2")).toHaveProperty("archivedAt");
  });

  it("拒绝动作与目标的不合法组合", async () => {
    const { bulk } = await createFixture();
    await expect(bulk.preview("restore", { mode: "selected", sessionIds: ["session-1"] }))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(bulk.preview("archive", { mode: "all_archived", agentId: "agent-1" }))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("全部删除继续停用任务并保留目标与运行历史", async () => {
    const { bulk, sessions, tasks } = await createFixture();
    await sessions.archive("session-1", "2026-08-10T00:01:00.000Z");
    const task = await tasks.createTask(taskInput("task-daily", "日报", "session-1"));
    await tasks.updateTask(task.id, { nextRunAt: "2026-08-12T00:00:00.000Z" });
    await tasks.appendRun({
      taskId: task.id,
      trigger: "manual",
      status: "completed",
      startedAt: "2026-08-10T00:00:00.000Z",
      finishedAt: "2026-08-10T00:01:00.000Z",
      prompt: "生成日报",
    });

    const preview = await bulk.preview("delete", { mode: "all_archived", agentId: "agent-1" });
    await bulk.deletePreservingTasks(preview, "2026-08-11T10:00:00.000Z");

    expect(await sessions.find("session-1")).toBeUndefined();
    expect(await sessions.find("session-2")).toBeDefined();
    expect(await tasks.getTask(task.id)).toMatchObject({
      enabled: false,
      target: { type: "deleted_session", sessionId: "session-1", sessionName: "日报会话" },
    });
    expect(await tasks.getTask(task.id)).not.toHaveProperty("nextRunAt");
    expect(await tasks.listRuns(task.id)).toHaveLength(1);
  });

  it("拒绝空选择、缺失会话和跨 Agent 会话", async () => {
    const { bulk, database } = await createFixture();
    await createAgentRepository(database).insert({
      version: 1,
      id: "agent-2",
      name: "Agent 2",
      avatar: { kind: "initial", value: "B" },
      description: "",
      status: "active",
      cwd: "/workspace/agent-2",
      allowedTools: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    await createSessionRepository(database).assign("session-other", "agent-2", "2026-08-07T00:00:00.000Z");

    await expect(bulk.preview("delete", { mode: "selected", sessionIds: [] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(bulk.preview("delete", { mode: "selected", sessionIds: ["missing-session"] })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(bulk.preview("delete", { mode: "selected", sessionIds: ["session-1", "session-other"] }))
      .rejects.toMatchObject({ code: "SESSION_AGENT_CONFLICT" });
  });

  it("数据库删除中途失败时回滚已修改的任务与会话", async () => {
    const { bulk, database, sessions, tasks } = await createFixture();
    const task = await tasks.createTask(taskInput("task-daily", "日报", "session-1"));
    const preview = await bulk.preview("delete", { mode: "selected", sessionIds: ["session-1", "session-2"] });
    const failingDatabase: Database = {
      ...database,
      write(sql, parameters) {
        if (sql === "DELETE FROM sessions WHERE id = ?" && parameters?.[0] === "session-2") {
          throw new Error("database unavailable");
        }
        return database.write(sql, parameters);
      },
    };

    await expect(createSessionBulkRepository(failingDatabase).deletePreservingTasks(preview, "2026-08-11T10:00:00.000Z"))
      .rejects.toThrow("database unavailable");
    expect(await sessions.find("session-1")).toBeDefined();
    expect(await sessions.find("session-2")).toBeDefined();
    expect(await tasks.getTask(task.id)).toMatchObject({
      enabled: true,
      target: { type: "existing_session", sessionId: "session-1" },
    });
  });

  async function createFixture() {
    const database = createTestDatabase();
    databases.push(database);
    await createAgentRepository(database).insert({
      version: 1,
      id: "agent-1",
      name: "Agent",
      avatar: { kind: "initial", value: "A" },
      description: "",
      status: "active",
      cwd: "/workspace/agent-1",
      allowedTools: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    const sessions = createSessionRepository(database);
    await sessions.assign("session-1", "agent-1", "2026-08-07T00:00:00.000Z");
    await sessions.rename("session-1", "日报会话", "2026-08-07T00:01:00.000Z");
    await sessions.assign("session-2", "agent-1", "2026-08-07T00:00:00.000Z");
    await sessions.rename("session-2", "周报会话", "2026-08-07T00:01:00.000Z");
    return {
      database,
      bulk: createSessionBulkRepository(database),
      sessions,
      tasks: createScheduledTaskRepository(database),
    };
  }
});

function taskInput(id: string, name: string, sessionId: string) {
  return {
    agentId: "agent-1",
    name,
    prompt: name,
    enabled: true,
    schedule: { type: "interval" as const, unit: "hour" as const, value: 1 },
    target: { type: "existing_session" as const, sessionId },
    id,
  };
}
